import fs from 'node:fs';
import path from 'node:path';
import { q, one, getProject, updateProject, getClip, updateClip, WORK_DIR, IS_VERCEL } from '../db.js';
import { ffmpeg, probe, run, assFilter } from './ffmpeg.js';
import { buildASS, sliceWords, normWord } from './ass.js';
import { trackFaces, cropPlan, cropExpr } from './face.js';
import { sceneCuts, buildSignals } from './signals.js';
import { emojiImage } from './emoji.js';
import { transcribeChunk, CHUNK_SECONDS } from '../ai/transcribe.js';
import { chatJSON } from '../ai/llm.js';
import { getSetting } from '../settings.js';
import { register, enqueue } from '../jobs.js';
import { saveFile, inputPath, removeFile } from '../storage.js';

const projectFail = async ({ id }, msg) => updateProject(id, { status: 'error', error: msg, progress: null });

// ---------- Paso 1: preparar origen ----------
register('shorts.start', async ({ id }) => {
  const p = await getProject(id);
  await updateProject(id, { status: 'processing', error: null, progress: 'Preparando el vídeo…' });
  let source = p.source;
  if (!source && p.source_url) {
    if (IS_VERCEL) throw new Error('En Vercel no se pueden descargar enlaces (YouTube bloquea los servidores en la nube). Sube el archivo de vídeo directamente. (400)');
    const tmp = path.join(WORK_DIR, `dl_${id}.%(ext)s`);
    await updateProject(id, { progress: 'Descargando vídeo…' });
    await run('yt-dlp', ['-f', 'bv*[height<=1080]+ba/b[height<=1080]/b', '--merge-output-format', 'mp4', '-o', tmp, '--no-playlist', p.source_url]);
    const f = fs.readdirSync(WORK_DIR).find(n => n.startsWith(`dl_${id}.`));
    if (!f) throw new Error('yt-dlp no generó ningún archivo.');
    source = await saveFile(path.join(WORK_DIR, f), `source_${id}.mp4`);
    fs.rmSync(path.join(WORK_DIR, f), { force: true });
    await updateProject(id, { source });
  }
  const info = await probe(inputPath(source));
  if (!info.hasAudio) throw new Error('El vídeo no tiene audio, no se puede transcribir. (400)');
  await updateProject(id, { progress: 'Analizando cambios de plano…' });
  const cuts = await sceneCuts(inputPath(source)).catch(() => []);
  p.data = { ...p.data, cuts, width: info.width, height: info.height };
  if (p.data.transcript?.words?.length) { // ya transcrito (reintento): saltar a la selección
    await updateProject(id, { duration: info.duration, data: p.data });
    return enqueue('shorts.pick', { id });
  }
  await updateProject(id, { duration: info.duration, data: { ...p.data, transcript: { language: '', segments: [], words: [], energy: [] } } });
  await enqueue('shorts.transcribe', { id, chunk: 0 });
}, projectFail);

// ---------- Paso 2: transcribir por trozos ----------
register('shorts.transcribe', async ({ id, chunk }) => {
  const p = await getProject(id);
  const chunks = Math.max(1, Math.ceil(p.duration / CHUNK_SECONDS));
  await updateProject(id, { progress: `Transcribiendo audio (${chunk + 1}/${chunks})…` });
  const r = await transcribeChunk(inputPath(p.source), { offset: chunk * CHUNK_SECONDS, len: CHUNK_SECONDS, language: p.data.options?.language });
  const t = p.data.transcript || { segments: [], words: [] };
  // Evita duplicar si este paso se reintenta
  const from = chunk * CHUNK_SECONDS;
  t.segments = t.segments.filter(s => s.start < from).concat(r.segments);
  t.words = t.words.filter(w => w.start < from).concat(r.words);
  t.energy = (t.energy || []).filter(e => e.t < from).concat(r.energy || []);
  t.language ||= r.language;
  await updateProject(id, { data: { ...p.data, transcript: t } });
  if (chunk + 1 < chunks) await enqueue('shorts.transcribe', { id, chunk: chunk + 1 });
  else await enqueue('shorts.pick', { id });
}, projectFail);

// ---------- Paso 3: la IA elige los clips ----------
async function pickClips(transcript, sig, { count, minSec, maxSec, language }) {
  const lines = transcript.segments.map(s => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}${sig.tags(s.start, s.end)}`).join('\n');
  const system = `Eres el mejor editor de vídeos cortos virales (YouTube Shorts, TikTok, Reels). Sabes exactamente qué momentos de un vídeo largo retienen a la audiencia y se comparten.
Criterios (de más a menos importante):
1. GANCHO: los primeros 3 segundos deben atrapar (frase impactante, pregunta, conflicto, dato sorprendente). Si la mejor frase está a mitad, empieza el clip ahí.
2. HISTORIA COMPLETA: se entiende sin contexto y tiene planteamiento → tensión → remate o revelación.
3. EMOCIÓN: humor, sorpresa, polémica, indignación, inspiración o vulnerabilidad.
4. VALOR: consejo accionable, secreto, dato que la gente quiera guardar o enviar.
5. FINAL: termina en una frase completa y contundente, sin cortar a media idea.
Las etiquetas entre corchetes son señales medidas del audio y el vídeo: 🔊 energía alta (gritos, risas, emoción), ⚡ habla rápida, 🎬 cambio de plano, 😂 risas. Úsalas como pista, pero manda el contenido.`;
  const user = `Transcripción con marcas de tiempo en segundos:
${lines}

Devuelve hasta ${count} clips que NO se solapen, de entre ${minSec} y ${maxSec} segundos cada uno, ordenados de más a menos viral.
JSON: {"clips":[{"start":número,"end":número,
 "title":"título para YouTube con gancho (máx 70 caracteres)",
 "hook":"frase de gancho de 3 a 7 palabras para mostrar arriba los primeros 4 segundos",
 "scores":{"hook":1-10,"story":1-10,"emotion":1-10,"value":1-10,"ending":1-10},
 "score":entero 1-10 (potencial viral global),
 "keywords":["3 a 6 palabras EXACTAS que se dicen en el clip y conviene resaltar en los subtítulos"],
 "emojis":[{"word":"palabra exacta que se dice","emoji":"un emoji"}] (2 a 4, solo donde aporten),
 "reason":"por qué funcionará, en una frase"}]}
Escribe title, hook y reason en el idioma: ${language || 'el mismo del vídeo'}. keywords y emojis.word deben aparecer tal cual en la transcripción del clip.`;
  const res = await chatJSON(system, user, { maxTokens: 8000 });
  return Array.isArray(res) ? res : (res.clips || []);
}

function snap(words, start, end) {
  const near = (arr, t, k) => arr.filter(w => Math.abs(w[k] - t) < 1.5).sort((a, b) => Math.abs(a[k] - t) - Math.abs(b[k] - t))[0];
  const s = near(words, start, 'start'), e = near(words, end, 'end');
  return { start: Math.max(0, (s?.start ?? start) - 0.1), end: (e?.end ?? end) + 0.25 };
}

register('shorts.pick', async ({ id }) => {
  const p = await getProject(id);
  if (!p.data.transcript?.segments?.length) throw new Error('No se detectó voz en el vídeo. (400)');
  await updateProject(id, { progress: 'La IA está buscando los mejores momentos…' });
  const opts = { count: 10, minSec: 20, maxSec: 60, layout: 'face', ...p.data.options };
  const sig = buildSignals({ energy: p.data.transcript.energy, words: p.data.transcript.words, cuts: p.data.cuts || [] });
  const picked = await pickClips(p.data.transcript, sig, { ...opts, language: opts.titleLanguage });
  if (!picked.length) throw new Error('La IA no encontró clips en la transcripción.');
  for (const old of await q('SELECT file FROM clips WHERE project_id = $1', [id])) await removeFile(old.file);
  await q('DELETE FROM clips WHERE project_id = $1', [id]);
  let n = 0;
  for (const c of picked) {
    let { start, end } = snap(p.data.transcript.words, Number(c.start), Number(c.end));
    end = Math.min(end, p.duration || end);
    if (!(end - start > 3)) continue;
    // Nota final: 75 % criterio de la IA + 25 % señales medidas (si hay datos de audio)
    const llm = Math.max(1, Math.min(10, Number(c.score) || 5));
    const measured = sig.score(start, end);
    const final = sig.hasAudioData ? Math.round(llm * 0.75 + measured.score * 0.25) : Math.round(llm);
    const signals = { llm, measured: measured.score, scores: c.scores || {}, peaks: measured.peaks, rate: +measured.rate.toFixed(2), cuts: measured.cuts, laugh: measured.laugh };
    const clipWords = new Set(sliceWords(p.data.transcript.words, start, end).map(w => normWord(w.word)));
    const keywords = (c.keywords || []).map(String).filter(k => clipWords.has(normWord(k))).slice(0, 6);
    const emojis = (c.emojis || []).filter(e => e?.emoji && clipWords.has(normWord(e.word))).slice(0, 4);
    const clip = await one(`INSERT INTO clips (project_id, idx, start, "end", title, hook, score, reason, layout, status, style, keywords, emojis, signals)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'rendering',$10,$11,$12,$13) RETURNING id`,
      [id, ++n, start, end, String(c.title || '').slice(0, 100), String(c.hook || '').slice(0, 80),
        Math.max(1, Math.min(10, final)), c.reason || '', opts.layout, opts.captionStyle || 'clasico',
        JSON.stringify(keywords), JSON.stringify(opts.emojis === false ? [] : emojis), JSON.stringify(signals)]);
    await enqueue('clip.render', { clipId: clip.id });
  }
  await updateProject(id, { progress: `Renderizando ${n} Shorts…` });
}, projectFail);

// ---------- Paso 4: render de cada clip ----------
export async function renderClip(clipId, { lang } = {}) {
  const clip = await getClip(clipId);
  if (!clip) return;
  const p = await getProject(clip.project_id);
  await updateClip(clipId, { status: 'rendering', error: null });
  const dur = clip.end - clip.start;
  const words = lang ? (clip.variants[lang]?.words || []) : sliceWords(p.data.transcript?.words || [], clip.start, clip.end);
  const hook = lang ? (clip.variants[lang]?.hook || '') : clip.hook;
  const tag = `c${clip.id}${lang ? '_' + lang : ''}_${Date.now()}`;
  const assFile = path.join(WORK_DIR, `${tag}.ass`);
  const out = path.join(WORK_DIR, `${tag}.mp4`);
  try {
    fs.writeFileSync(assFile, buildASS(words, {
      hook, duration: dur, highlight: await getSetting('caption_color'),
      captionMarginV: clip.layout === 'blur' ? 560 : 420,
      captions: p.data.options?.captions !== false,
      style: clip.style || p.data.options?.captionStyle || 'clasico', keywords: lang ? [] : (clip.keywords || []),
    }));
    const ass = assFilter(assFile);
    const input = inputPath(p.source);
    // Encuadre "face": la ventana vertical sigue a la persona que habla
    let layout = clip.layout, facePlan = null;
    if (layout === 'face') {
      const W = p.data.width || (await probe(input)).width, H = p.data.height || (await probe(input)).height;
      const cached = clip.track && clip.track.start === clip.start && clip.track.end === clip.end ? clip.track : null;
      facePlan = cached ? cached.plan : null;
      if (!cached) {
        try {
          const samples = await trackFaces(input, clip.start, dur);
          facePlan = cropPlan(samples, W, H);
        } catch (e) { console.warn('caras:', e.message); }
        await updateClip(clipId, { track: { start: clip.start, end: clip.end, plan: facePlan } });
      }
      if (facePlan) facePlan.H = H;
      else layout = 'blur'; // sin caras detectadas: fondo difuminado
    }
    let vf;
    if (layout === 'face') vf = `[0:v]crop=w=${facePlan.cw}:h=${facePlan.H}:x=${cropExpr(facePlan)}:y=0,scale=1080:1920,setsar=1,${ass}[base]`;
    else if (layout === 'crop') vf = `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,${ass}[base]`;
    else vf = `[0:v]split=2[a][b];[a]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=10:2,scale=1080:1920,eq=brightness=-0.06[bg];` +
      `[b]scale=1080:1920:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,${ass}[base]`;

    // Emojis animados sobre los subtítulos cuando se dice la palabra
    const extra = [];
    let last = 'base';
    const emojiList = lang ? [] : (clip.emojis || []);
    const capY = clip.layout === 'blur' ? 1920 - 560 : 1920 - 420; // misma altura que los subtítulos
    let k = 0;
    for (const e of emojiList) {
      const w = words.find(x => normWord(x.word) === normWord(e.word));
      if (!w) continue;
      const img = await emojiImage(e.emoji).catch(() => null);
      if (!img) continue;
      const i = 1 + k++;
      extra.push('-loop', '1', '-i', img);
      const t0 = Math.max(0, w.start - 0.05).toFixed(2), t1 = (w.start + 1.3).toFixed(2);
      // aparece con un pequeño rebote de escala
      vf += `;[${i}:v]format=rgba,scale=170:170,fade=in:st=${t0}:d=0.12:alpha=1,fade=out:st=${(w.start + 1.1).toFixed(2)}:d=0.2:alpha=1[e${i}];` +
        `[${last}][e${i}]overlay=x=(W-w)/2:y=${capY - 300}-20*sin(min(1\\,(t-${t0})*6)*PI):enable='between(t,${t0},${t1})':shortest=1[o${i}]`;
      last = `o${i}`;
    }
    vf += `;[${last}]null[v]`;
    await ffmpeg(['-ss', clip.start.toFixed(3), '-i', input, ...extra, '-t', dur.toFixed(3),
      '-filter_complex', vf, '-map', '[v]', '-map', '0:a?',
      '-c:v', 'libx264', '-preset', process.env.X264_PRESET || 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-r', '30',
      '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out]);
    const ref = await saveFile(out, `short_${tag}.mp4`);
    const fresh = await getClip(clipId);
    if (lang) {
      const old = fresh.variants[lang]?.file;
      fresh.variants[lang] = { ...fresh.variants[lang], file: ref };
      await updateClip(clipId, { variants: fresh.variants, status: 'ready' });
      await removeFile(old);
    } else {
      await removeFile(fresh.file);
      await updateClip(clipId, { file: ref, status: 'ready' });
    }
  } finally {
    fs.rmSync(assFile, { force: true }); fs.rmSync(out, { force: true });
  }
  await checkDone(clip.project_id);
}

async function checkDone(projectId) {
  const r = await one(`SELECT COUNT(*) FILTER (WHERE status IN ('rendering','pending'))::int AS busy, COUNT(*) FILTER (WHERE status = 'ready')::int AS ready FROM clips WHERE project_id = $1`, [projectId]);
  if (!r.busy) await updateProject(projectId, { status: 'ready', progress: `${r.ready} Shorts listos` });
}
const clipFail = async ({ clipId }, msg) => {
  await updateClip(clipId, { status: 'error', error: msg });
  const c = await getClip(clipId);
  if (c) await checkDone(c.project_id);
};

register('clip.render', ({ clipId, lang }) => renderClip(clipId, { lang }), clipFail);

// ---------- Traducción ----------
register('clip.translate', async ({ clipId, lang }) => {
  const clip = await getClip(clipId);
  const p = await getProject(clip.project_id);
  const segs = (p.data.transcript?.segments || []).filter(s => s.end > clip.start && s.start < clip.end)
    .map(s => ({ start: Math.max(0, s.start - clip.start), end: Math.min(clip.end, s.end) - clip.start, text: s.text }));
  const res = await chatJSON('Eres un traductor profesional de subtítulos para vídeos cortos. Traduces de forma natural y breve, manteniendo el tono.',
    `Traduce al idioma "${lang}". Devuelve {"hook":"...","title":"...","segments":["texto traducido 1", ...]} con el mismo número de segmentos (${segs.length}).
Gancho: ${clip.hook}
Título: ${clip.title}
Segmentos:
${segs.map((s, i) => `${i + 1}. ${s.text}`).join('\n')}`);
  const words = [];
  segs.forEach((s, i) => {
    const parts = String(res.segments?.[i] || '').split(/\s+/).filter(Boolean);
    const step = (s.end - s.start) / Math.max(1, parts.length);
    parts.forEach((w, j) => words.push({ word: w, start: s.start + j * step, end: s.start + (j + 1) * step }));
  });
  clip.variants[lang] = { ...clip.variants[lang], hook: res.hook || '', title: res.title || '', words };
  await updateClip(clipId, { variants: clip.variants });
  await renderClip(clipId, { lang });
}, clipFail);
