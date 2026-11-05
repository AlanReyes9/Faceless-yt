import fs from 'node:fs';
import path from 'node:path';
import { db, getProject, updateProject, getClip, updateClip, OUTPUT_DIR, WORK_DIR, UPLOADS_DIR } from '../db.js';
import { ffmpeg, probe, run, filterPath } from './ffmpeg.js';
import { buildASS, sliceWords } from './ass.js';
import { transcribe } from '../ai/transcribe.js';
import { chatJSON } from '../ai/llm.js';
import { getSetting } from '../settings.js';
import { enqueue } from '../jobs.js';

/** Descarga un vídeo desde una URL (YouTube, etc.) con yt-dlp. */
async function downloadSource(project) {
  const out = path.join(UPLOADS_DIR, `p${project.id}_source.%(ext)s`);
  updateProject(project.id, { progress: 'Descargando vídeo…' });
  await run('yt-dlp', ['-f', 'bv*[height<=1080]+ba/b[height<=1080]/b', '--merge-output-format', 'mp4', '-o', out, '--no-playlist', project.source_url]);
  const file = fs.readdirSync(UPLOADS_DIR).find(f => f.startsWith(`p${project.id}_source.`));
  if (!file) throw new Error('yt-dlp no generó ningún archivo.');
  const full = path.join(UPLOADS_DIR, file);
  updateProject(project.id, { source_path: full });
  return full;
}

/** Pide a la IA los mejores momentos del vídeo. */
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

/** Ajusta los límites del clip a inicio/fin de palabra para no cortar a mitad. */
function snap(words, start, end) {
  const s = words.filter(w => Math.abs(w.start - start) < 1.5).sort((a, b) => Math.abs(a.start - start) - Math.abs(b.start - start))[0];
  const e = words.filter(w => Math.abs(w.end - end) < 1.5).sort((a, b) => Math.abs(a.end - end) - Math.abs(b.end - end))[0];
  return { start: Math.max(0, (s?.start ?? start) - 0.1), end: (e?.end ?? end) + 0.25 };
}

/** Flujo completo: (descarga) → transcripción → selección con IA → render de todos los clips. */
export async function processShortsProject(id) {
  let p = getProject(id);
  try {
    updateProject(id, { status: 'processing', error: null });
    const src = p.source_path || await downloadSource(p);
    const info = await probe(src);
    updateProject(id, { duration: info.duration });
    p = getProject(id);

    const work = path.join(WORK_DIR, `p${id}`);
    if (!p.data.transcript) {
      const transcript = await transcribe(src, work, { language: p.data.options?.language, onProgress: m => updateProject(id, { progress: m }) });
      p.data.transcript = transcript;
      updateProject(id, { data: p.data });
    }
    const opts = { count: 10, minSec: 20, maxSec: 60, layout: 'blur', ...p.data.options };
    updateProject(id, { progress: 'La IA está buscando los mejores momentos…' });
    const picked = await pickClips(p.data.transcript, { ...opts, language: opts.titleLanguage });
    if (!picked.length) throw new Error('La IA no encontró clips en la transcripción.');

    db.prepare('DELETE FROM clips WHERE project_id = ?').run(id);
    const ins = db.prepare('INSERT INTO clips (project_id, idx, start, end, title, hook, score, reason, layout) VALUES (?,?,?,?,?,?,?,?,?)');
    picked.forEach((c, i) => {
      let { start, end } = snap(p.data.transcript.words, Number(c.start), Number(c.end));
      end = Math.min(end, info.duration);
      if (!(end - start > 3)) return;
      ins.run(id, i + 1, start, end, String(c.title || '').slice(0, 100), String(c.hook || '').slice(0, 80),
        Math.max(1, Math.min(10, Math.round(Number(c.score) || 5))), c.reason || '', opts.layout);
    });
    const clips = db.prepare('SELECT id FROM clips WHERE project_id = ? ORDER BY idx').all(id);
    for (let i = 0; i < clips.length; i++) {
      updateProject(id, { progress: `Renderizando clip ${i + 1} de ${clips.length}…` });
      await renderClip(clips[i].id).catch(() => {});
    }
    updateProject(id, { status: 'ready', progress: `${clips.length} Shorts listos` });
  } catch (e) {
    updateProject(id, { status: 'error', error: e.message, progress: null });
  }
}

/** Renderiza un clip vertical 1080x1920. lang = variante traducida (opcional). */
export async function renderClip(clipId, { lang } = {}) {
  const clip = getClip(clipId);
  const p = getProject(clip.project_id);
  updateClip(clipId, { status: 'rendering', error: null });
  try {
    const dur = clip.end - clip.start;
    const words = lang ? (clip.variants[lang]?.words || []) : sliceWords(p.data.transcript?.words || [], clip.start, clip.end);
    const hook = lang ? (clip.variants[lang]?.hook || '') : clip.hook;
    const work = path.join(WORK_DIR, `p${p.id}`);
    fs.mkdirSync(work, { recursive: true });
    const assFile = path.join(work, `clip${clip.id}${lang ? '_' + lang : ''}.ass`);
    fs.writeFileSync(assFile, buildASS(words, {
      hook, duration: dur, highlight: getSetting('caption_color'),
      captionMarginV: clip.layout === 'crop' ? 420 : 560,
      captions: p.data.options?.captions !== false,
    }));

    const ass = `ass='${filterPath(assFile)}'`;
    const vf = clip.layout === 'crop'
      ? `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,${ass}[v]`
      : `[0:v]split=2[a][b];[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=40,eq=brightness=-0.06[bg];` +
        `[b]scale=1080:1920:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,${ass}[v]`;

    const name = `p${p.id}_c${clip.id}${lang ? '_' + lang : ''}_${Date.now()}.mp4`;
    const out = path.join(OUTPUT_DIR, name);
    await ffmpeg(['-ss', clip.start.toFixed(3), '-i', p.source_path, '-t', dur.toFixed(3),
      '-filter_complex', vf, '-map', '[v]', '-map', '0:a?',
      '-c:v', 'libx264', '-preset', process.env.X264_PRESET || 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-r', '30',
      '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out]);

    const fresh = getClip(clipId);
    if (lang) {
      const old = fresh.variants[lang]?.file;
      fresh.variants[lang] = { ...fresh.variants[lang], file: name };
      updateClip(clipId, { variants: fresh.variants, status: 'ready' });
      if (old) fs.rmSync(path.join(OUTPUT_DIR, old), { force: true });
    } else {
      if (fresh.file) fs.rmSync(path.join(OUTPUT_DIR, fresh.file), { force: true });
      updateClip(clipId, { file: name, status: 'ready' });
    }
  } catch (e) {
    updateClip(clipId, { status: 'error', error: e.message });
    throw e;
  }
}

/** Traduce los subtítulos y el gancho de un clip y genera la versión en otro idioma. */
export async function translateClip(clipId, lang) {
  const clip = getClip(clipId);
  const p = getProject(clip.project_id);
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
  clip.variants[lang] = { hook: res.hook || '', title: res.title || '', words };
  updateClip(clipId, { variants: clip.variants });
  await renderClip(clipId, { lang });
}

export const queueRender = (clipId, opts) => enqueue(`clip ${clipId}`, () => renderClip(clipId, opts));
export const queueTranslate = (clipId, lang) => enqueue(`translate ${clipId}`, () => translateClip(clipId, lang));
export const queueProject = id => enqueue(`project ${id}`, () => processShortsProject(id));
