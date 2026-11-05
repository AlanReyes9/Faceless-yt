import fs from 'node:fs';
import path from 'node:path';
import { q, one, getProject, updateProject, getClip, updateClip, WORK_DIR, IS_VERCEL } from '../db.js';
import { ffmpeg, probe, run, assFilter } from './ffmpeg.js';
import { buildASS, sliceWords } from './ass.js';
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
  if (p.data.transcript?.words?.length) { // ya transcrito (reintento): saltar a la selección
    await updateProject(id, { duration: info.duration });
    return enqueue('shorts.pick', { id });
  }
  await updateProject(id, { duration: info.duration, data: { ...p.data, transcript: { language: '', segments: [], words: [] } } });
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
  t.language ||= r.language;
  await updateProject(id, { data: { ...p.data, transcript: t } });
  if (chunk + 1 < chunks) await enqueue('shorts.transcribe', { id, chunk: chunk + 1 });
  else await enqueue('shorts.pick', { id });
}, projectFail);

// ---------- Paso 3: la IA elige los clips ----------
async function pickClips(transcript, { count, minSec, maxSec, language }) {
  const lines = transcript.segments.map(s => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`).join('\n');
  const system = `Eres un editor experto en YouTube Shorts, TikTok y Reels. Encuentras los momentos con más potencial viral de un vídeo largo: historias con giro, frases polémicas, momentos graciosos, revelaciones, consejos accionables. Cada clip debe entenderse solo (sin contexto previo), empezar con algo que enganche y terminar en una frase completa.`;
  const user = `Transcripción con marcas de tiempo en segundos:
${lines}

Devuelve hasta ${count} clips que NO se solapen, de entre ${minSec} y ${maxSec} segundos cada uno, ordenados por potencial viral.
Formato JSON: {"clips":[{"start":número,"end":número,"title":"título corto para YouTube (máx 70 caracteres, con gancho)","hook":"frase de gancho de 3 a 7 palabras que se mostrará arriba los primeros 4 segundos","score":entero 1-10,"reason":"por qué funcionará"}]}
Escribe title y hook en el idioma: ${language || 'el mismo del vídeo'}.`;
  const res = await chatJSON(system, user, { maxTokens: 6000 });
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
  const opts = { count: 10, minSec: 20, maxSec: 60, layout: 'blur', ...p.data.options };
  const picked = await pickClips(p.data.transcript, { ...opts, language: opts.titleLanguage });
  if (!picked.length) throw new Error('La IA no encontró clips en la transcripción.');
  for (const old of await q('SELECT file FROM clips WHERE project_id = $1', [id])) await removeFile(old.file);
  await q('DELETE FROM clips WHERE project_id = $1', [id]);
  let n = 0;
  for (const c of picked) {
    let { start, end } = snap(p.data.transcript.words, Number(c.start), Number(c.end));
    end = Math.min(end, p.duration || end);
    if (!(end - start > 3)) continue;
    const clip = await one(`INSERT INTO clips (project_id, idx, start, "end", title, hook, score, reason, layout, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'rendering') RETURNING id`,
      [id, ++n, start, end, String(c.title || '').slice(0, 100), String(c.hook || '').slice(0, 80),
        Math.max(1, Math.min(10, Math.round(Number(c.score) || 5))), c.reason || '', opts.layout]);
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
      captionMarginV: clip.layout === 'crop' ? 420 : 560,
      captions: p.data.options?.captions !== false,
    }));
    const ass = assFilter(assFile);
    // Fondo: se reduce, se difumina y se amplía (mucho más rápido que difuminar a 1080x1920)
    const vf = clip.layout === 'crop'
      ? `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,${ass}[v]`
      : `[0:v]split=2[a][b];[a]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=10:2,scale=1080:1920,eq=brightness=-0.06[bg];` +
        `[b]scale=1080:1920:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,${ass}[v]`;
    await ffmpeg(['-ss', clip.start.toFixed(3), '-i', inputPath(p.source), '-t', dur.toFixed(3),
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
