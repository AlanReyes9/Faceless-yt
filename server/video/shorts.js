import fs from 'node:fs';
import { downloadVideo } from './ytdlp.js';
import path from 'node:path';
import { q, one, getProject, updateProject, getClip, updateClip, WORK_DIR, IS_VERCEL } from '../db.js';
import { ffmpeg, probe, run, assFilter } from './ffmpeg.js';
import { buildASS, sliceWords, normWord } from './ass.js';
import { trackFaces, trackSpeakers, cropPlan, cropExpr } from './face.js';
import { buildSignals } from './signals.js';
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
  await updateProject(id, { status: 'processing', error: null, progress: 'Preparando el vídeo…', percent: 1 });
  let source = p.source;
  if (!source && p.source_url) {
    if (IS_VERCEL) throw new Error('En Vercel no se pueden descargar enlaces (YouTube bloquea los servidores en la nube). Sube el archivo de vídeo directamente. (400)');
    await updateProject(id, { progress: 'Obteniendo el vídeo del enlace…' });
    for (const n of fs.readdirSync(WORK_DIR)) if (n.startsWith(`dl_${id}.`)) fs.rmSync(path.join(WORK_DIR, n), { force: true }); // restos de un intento anterior
    const file = await downloadVideo(p.source_url, WORK_DIR, `dl_${id}`,
      (pct, text) => updateProject(id, { progress: text, percent: Math.max(1, Math.round(pct * 0.1)) }).catch(() => {}));
    await updateProject(id, { progress: 'Guardando el vídeo…', percent: 10 });
    source = await saveFile(file, `source_${id}.mp4`);
    fs.rmSync(file, { force: true });
    await updateProject(id, { source });
  }
  const info = await probe(inputPath(source));
  if (!info.hasAudio) throw new Error('El vídeo no tiene audio, no se puede transcribir. (400)');
  // Los cambios de plano se detectan durante la transcripción (misma lectura del vídeo)
  p.data = { ...p.data, cuts: p.data.cuts || [], width: info.width, height: info.height };
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
  await updateProject(id, { progress: `Transcribiendo audio (${chunk + 1}/${chunks})…`, percent: Math.round(5 + 45 * chunk / chunks) });
  const r = await transcribeChunk(inputPath(p.source), { offset: chunk * CHUNK_SECONDS, len: CHUNK_SECONDS, language: p.data.options?.language });
  const t = p.data.transcript || { segments: [], words: [] };
  // Evita duplicar si este paso se reintenta
  const from = chunk * CHUNK_SECONDS;
  t.segments = t.segments.filter(s => s.start < from).concat(r.segments);
  t.words = t.words.filter(w => w.start < from).concat(r.words);
  t.energy = (t.energy || []).filter(e => e.t < from).concat(r.energy || []);
  p.data.cuts = (p.data.cuts || []).filter(c => c < from).concat(r.cuts || []);
  t.language ||= r.language;
  await updateProject(id, { data: { ...p.data, transcript: t } });
  if (chunk + 1 < chunks) await enqueue('shorts.transcribe', { id, chunk: chunk + 1 });
  else await enqueue('shorts.pick', { id });
}, projectFail);

// ---------- Paso 3: la IA elige los clips ----------
export async function pickClips(transcript, sig, { count, minSec, maxSec, language }) {
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

export function snap(words, start, end) {
  const near = (arr, t, k) => arr.filter(w => Math.abs(w[k] - t) < 1.5).sort((a, b) => Math.abs(a[k] - t) - Math.abs(b[k] - t))[0];
  const s = near(words, start, 'start'), e = near(words, end, 'end');
  return { start: Math.max(0, (s?.start ?? start) - 0.1), end: (e?.end ?? end) + 0.25 };
}

register('shorts.pick', async ({ id }) => {
  const p = await getProject(id);
  if (!p.data.transcript?.segments?.length) throw new Error('No se detectó voz en el vídeo. (400)');
  await updateProject(id, { progress: 'La IA está buscando los mejores momentos…', percent: 50 });
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
  await updateProject(id, { progress: `Renderizando ${n} Shorts…`, percent: 55 });
}, projectFail);

// ---------- Paso 4: render de cada clip ----------
// Calidad según el intento: si un render se pasa de tiempo, el siguiente intento es más rápido.
function quality(attempt = 1) {
  const base = process.env.X264_PRESET || (IS_VERCEL ? 'superfast' : 'veryfast');
  if (attempt <= 1) return { preset: base, crf: 22, W: 1080, H: 1920 };
  if (attempt === 2) return { preset: 'ultrafast', crf: 24, W: 1080, H: 1920 };
  return { preset: 'ultrafast', crf: 25, W: 720, H: 1280 };
}

/** Guarda el progreso de un clip (como mucho cada 2 s para no saturar la base de datos). */
function progressWriter(clipId) {
  let last = 0;
  return async (stage, pct, force = false) => {
    if (!force && Date.now() - last < 2000) return;
    last = Date.now();
    await updateClip(clipId, { stage, progress: Math.max(0, Math.min(100, Math.round(pct))) }).catch(() => {});
  };
}

export async function renderClip(clipId, { lang } = {}, ctx = { attempt: 1, remaining: () => Infinity }) {
  const clip = await getClip(clipId);
  if (!clip) return;
  const p = await getProject(clip.project_id);
  // Trozos de vídeo que forman el clip: normalmente el original; en directos, uno o dos segmentos grabados
  const dur = clip.end - clip.start;
  const parts = clip.src ? JSON.parse(clip.src) : [{ ref: p.source, ss: clip.start, dur }];
  if (parts.some(x => !x.ref) || p.data.sourceDeletedAt) throw new Error('El vídeo original se borró para ahorrar espacio; no se puede volver a renderizar. (410)');
  const inputs = parts.map(x => inputPath(x.ref));
  const prog = progressWriter(clipId);
  await updateClip(clipId, { status: 'rendering', error: null });
  await prog(ctx.attempt > 1 ? `Reintento ${ctx.attempt} (modo rápido)…` : 'Preparando…', 0, true);
  const allWords = p.type === 'live' ? await liveWords(p.id, clip.start, clip.end) : (p.data.transcript?.words || []);
  const words = lang ? (clip.variants[lang]?.words || []) : sliceWords(allWords, clip.start, clip.end);
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
    const input = inputs[0];
    // Recorre los trozos del clip aplicando un análisis y uniendo los resultados en una sola línea de tiempo
    const overParts = async fn => {
      const outAll = []; let acc = 0;
      for (const [i, part] of parts.entries()) {
        const r = await fn(inputs[i], part, acc);
        if (!r) return null;
        outAll.push(...r.map(x => ({ ...x, t: x.t + acc })));
        acc += part.dur;
      }
      return outAll;
    };
    // Encuadre "face": la ventana vertical sigue a la persona que habla
    let layout = clip.layout, facePlan = null;
    if (layout === 'face') {
      const W = p.data.width || (await probe(input)).width, H = p.data.height || (await probe(input)).height;
      // v2: encuadre en quien habla (los encuadres guardados con la versión anterior se recalculan)
      const cached = clip.track && clip.track.v === 2 && clip.track.start === clip.start && clip.track.end === clip.end ? clip.track : null;
      facePlan = cached ? cached.plan : null;
      if (!cached) {
        try {
          let samples = await overParts((inp, part) => trackFaces(inp, part.ss, part.dur, {
            onProgress: f => prog('Detectando caras', f * 40),
            timeoutMs: Math.max(30000, Math.min(150000, ctx.remaining() - 20000)),
          }));
          // Varias personas en plano: se encuadra a quien está hablando
          const multi = samples.filter(x => x.n >= 2).length >= samples.length * 0.3;
          if (multi) {
            try {
              const voice = sliceWords(allWords, clip.start, clip.end);
              const t0 = Date.now();
              const spk = await overParts((inp, part, acc) => trackSpeakers(inp, part.ss, part.dur, {
                words: voice.filter(w => w.start >= acc && w.start < acc + part.dur).map(w => ({ ...w, start: w.start - acc, end: w.end - acc })),
                onProgress: f => prog('Detectando quién habla', 40 + f * 60),
                timeoutMs: Math.max(30000, Math.min(150000, ctx.remaining() - 60000)),
              }));
              if (spk?.some(x => x.cx != null)) {
                samples = spk;
                const changes = spk.reduce((n, x, i) => n + (i && x.speaker !== spk[i - 1].speaker ? 1 : 0), 0);
                console.log(`[caras] clip ${clipId}: ${new Set(spk.map(x => x.speaker)).size} persona(s), ${changes} cambio(s) de hablante en ${((Date.now() - t0) / 1000).toFixed(1)} s`);
              }
            } catch (e) { console.warn('hablante:', e.message); } // si falla, se usa la cara principal
          }
          facePlan = cropPlan(samples, W, H);
        } catch (e) { console.warn('caras:', e.message); }
        await updateClip(clipId, { track: { v: 2, start: clip.start, end: clip.end, plan: facePlan } });
        // En Vercel el render va en un paso nuevo para tener el tiempo completo
        if (ctx.remaining() < 200000) {
          await prog('En cola para renderizar', 0, true);
          await enqueue('clip.render', { clipId, lang });
          return 'requeued';
        }
      }
      if (facePlan) facePlan.H = H;
      else layout = 'blur'; // sin caras detectadas: fondo difuminado
    }
    let vf;
    // Los subtítulos y emojis se diseñan a 1080x1920; en modo rápido se escala al final
    const Q = quality(ctx.attempt);
    // Varios trozos: se unen (vídeo y audio) antes de aplicar el encuadre
    const vin = parts.length > 1 ? '[cv]' : '[0:v]';
    const pre = parts.length > 1 ? `${parts.map((_, i) => `[${i}:v][${i}:a]`).join('')}concat=n=${parts.length}:v=1:a=1[cv][ca];` : '';
    if (layout === 'face') vf = `[0:v]crop=w=${facePlan.cw}:h=${facePlan.H}:x=${cropExpr(facePlan)}:y=0,scale=1080:1920,setsar=1,${ass}[base]`;
    else if (layout === 'crop') vf = `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,${ass}[base]`;
    else vf = `[0:v]split=2[a][b];[a]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=10:2,scale=1080:1920,eq=brightness=-0.06[bg];` +
      `[b]scale=1080:1920:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,${ass}[base]`;
    vf = pre + vf.replace('[0:v]', vin);

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
      const i = parts.length + k++;
      extra.push('-loop', '1', '-i', img);
      const t0 = Math.max(0, w.start - 0.05).toFixed(2), t1 = (w.start + 1.3).toFixed(2);
      // aparece con un pequeño rebote de escala
      vf += `;[${i}:v]format=rgba,scale=170:170,fade=in:st=${t0}:d=0.12:alpha=1,fade=out:st=${(w.start + 1.1).toFixed(2)}:d=0.2:alpha=1[e${i}];` +
        `[${last}][e${i}]overlay=x=(W-w)/2:y=${capY - 300}-20*sin(min(1\\,(t-${t0})*6)*PI):enable='between(t,${t0},${t1})':shortest=1[o${i}]`;
      last = `o${i}`;
    }
    vf += Q.W !== 1080 ? `;[${last}]scale=${Q.W}:${Q.H}[v]` : `;[${last}]null[v]`;
    if (ctx.remaining() < 45000) { // no empezar un render sin tiempo suficiente: va a una ejecución nueva
      await prog('En cola para renderizar', 0, true);
      await enqueue('clip.render', { clipId, lang });
      return 'requeued';
    }
    await prog('Renderizando', 0, true);
    const inArgs = parts.flatMap((x, i) => ['-ss', x.ss.toFixed(3), ...(parts.length > 1 ? ['-t', x.dur.toFixed(3)] : []), '-i', inputs[i]]);
    await ffmpeg(['-threads', '0', ...inArgs, ...extra, '-t', dur.toFixed(3),
      '-filter_complex', vf, '-map', '[v]', '-map', parts.length > 1 ? '[ca]' : '0:a?',
      '-c:v', 'libx264', '-preset', Q.preset, '-crf', String(Q.crf), '-pix_fmt', 'yuv420p', '-r', '30',
      '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out], {
      onProgress: sec => prog('Renderizando', (sec / dur) * 95),
      timeoutMs: ctx.remaining() - 15000, // parar antes de que el servidor corte la función
    });
    await prog('Guardando', 97, true);
    const ref = await saveFile(out, `short_${tag}.mp4`);
    const fresh = await getClip(clipId);
    if (lang) {
      const old = fresh.variants[lang]?.file;
      fresh.variants[lang] = { ...fresh.variants[lang], file: ref };
      await updateClip(clipId, { variants: fresh.variants, status: 'ready', progress: 100, stage: null });
      await removeFile(old);
    } else {
      await removeFile(fresh.file);
      await updateClip(clipId, { file: ref, status: 'ready', progress: 100, stage: null });
    }
  } finally {
    fs.rmSync(assFile, { force: true }); fs.rmSync(out, { force: true });
  }
  await checkDone(clip.project_id);
}

/** Palabras de un directo entre dos instantes (se guardan por segmento). */
export async function liveWords(projectId, start, end) {
  const rows = await q('SELECT words FROM live_segments WHERE project_id = $1 AND start < $3 AND start + dur > $2 ORDER BY seg', [projectId, start, end]);
  return rows.flatMap(r => r.words || []);
}

export async function checkDone(projectId) {
  const pr = await getProject(projectId);
  if (pr?.type === 'live' && !pr.data.live?.ended) return; // el directo sigue: el proyecto continúa en curso
  const r = await one(`SELECT COUNT(*) FILTER (WHERE status IN ('rendering','pending'))::int AS busy,
      COUNT(*) FILTER (WHERE status = 'ready')::int AS ready, COUNT(*) FILTER (WHERE status = 'error')::int AS failed
    FROM clips WHERE project_id = $1`, [projectId]);
  if (r.busy) return;
  if (!r.ready && r.failed) {
    await updateProject(projectId, { status: 'error', error: `No se pudo renderizar ningún Short (${r.failed} con error). Pulsa "Reintentar" para volver a renderizarlos.`, progress: null });
  } else {
    await updateProject(projectId, { status: 'ready', ready_at: new Date().toISOString(), error: null, percent: 100, progress: `${r.ready} Shorts listos${r.failed ? ` · ${r.failed} con error` : ''}` });
  }
}
const clipFail = async ({ clipId }, msg) => {
  await updateClip(clipId, { status: 'error', error: msg, stage: null });
  const c = await getClip(clipId);
  if (c) await checkDone(c.project_id);
};

register('clip.render', ({ clipId, lang }, ctx) => renderClip(clipId, { lang }, ctx), clipFail);

// ---------- Traducción ----------
register('clip.translate', async ({ clipId, lang }, ctx) => {
  const clip = await getClip(clipId);
  const p = await getProject(clip.project_id);
  const allSegs = p.type === 'live' ? (await q('SELECT segments FROM live_segments WHERE project_id = $1 ORDER BY seg', [p.id])).flatMap(r => r.segments || []) : (p.data.transcript?.segments || []);
  const segs = allSegs.filter(s => s.end > clip.start && s.start < clip.end)
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
  await enqueue('clip.render', { clipId, lang }); // el render va en su propio paso
}, clipFail);
