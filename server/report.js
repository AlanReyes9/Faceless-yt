// Informe del vídeo después del análisis: títulos, descripción, hashtags/SEO, capítulos, mejoras,
// mejores fotogramas para la miniatura, transcripción descargable y preguntas a la IA sobre el vídeo.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { getProject, updateProject, q, WORK_DIR } from './db.js';
import { chat, chatJSON } from './ai/llm.js';
import { register, enqueue } from './jobs.js';
import { FFMPEG } from './video/ffmpeg.js';
import { localUrl } from './video/netproxy.js';
import { detectFaces } from './video/face.js';
import { inputPath, saveBuffer, publicUrl } from './storage.js';

const mmss = t => { t = Math.max(0, Math.round(t)); const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0'); };

/** Transcripción condensada con marcas de tiempo (para el modelo de texto). */
function condensed(p, maxChars = 60000) {
  const segs = p.data.transcript?.segments || [];
  let txt = segs.map(s => `[${mmss(s.start)}] ${s.text}`).join('\n');
  if (txt.length > maxChars) { // vídeos muy largos: se reparte a lo largo de todo el vídeo
    const step = Math.ceil(segs.length / (maxChars / 90));
    txt = segs.filter((_, i) => i % step === 0).map(s => `[${mmss(s.start)}] ${s.text}`).join('\n');
  }
  return txt;
}

export async function buildReport(id) {
  const p = await getProject(id);
  if (!p.data.transcript?.segments?.length) throw new Error('El vídeo aún no está transcrito.');
  const lang = p.data.options?.titleLanguage || p.data.transcript.language || 'el idioma del vídeo';
  const clips = await q('SELECT idx, start, "end", title FROM clips WHERE project_id = $1 ORDER BY start', [id]);
  const r = await chatJSON('Eres un experto en YouTube, SEO y retención. Analizas transcripciones y das recomendaciones concretas y accionables.',
    `Vídeo: "${p.title}" · duración ${mmss(p.duration || 0)}.
Transcripción con tiempos:
"""${condensed(p)}"""
Clips ya elegidos: ${clips.map(c => `${mmss(c.start)}-${mmss(c.end)} "${c.title}"`).join(' | ') || 'ninguno'}.
Responde en ${lang}. JSON:
{"summary":"resumen del vídeo en 3-4 frases",
 "titles":["8 títulos para YouTube con gancho, distintos enfoques (curiosidad, número, polémica…), máx. 70 caracteres"],
 "description":"descripción SEO de 2-3 párrafos con llamada a la acción",
 "hashtags":["10 hashtags con #"], "tags":["15 etiquetas/palabras clave de búsqueda"],
 "chapters":[{"t":segundos,"title":"capítulo"}],
 "improvements":[{"area":"Gancho|Ritmo|Audio|Imagen|Retención|Llamada a la acción","tip":"mejora concreta, citando el minuto si aplica"}],
 "mood":"tono del vídeo en 2-3 palabras"}
Los capítulos empiezan en 0, son 4-10 y siguen el orden del vídeo.`, { maxTokens: 5000 });
  const report = { ...r, chapters: (r.chapters || []).map(c => ({ t: Math.max(0, Number(c.t) || 0), title: String(c.title || '') })).sort((a, b) => a.t - b.t), at: new Date().toISOString() };
  const fresh = await getProject(id);
  await updateProject(id, { data: { ...fresh.data, report } });
  return report;
}

register('shorts.report', async ({ id }) => { await buildReport(id); }, () => {});

// ---------- Mejores fotogramas para la miniatura (caras grandes, nitidez y luz) ----------
async function grab(input, t, w = 640, h = 360) {
  input = await localUrl(input);
  return new Promise((resolve, reject) => {
    const pr = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', input, '-frames:v', '1', '-vf', `scale=${w}:${h}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
    const ch = []; pr.stdout.on('data', d => ch.push(d)); pr.on('error', reject);
    pr.on('close', () => { const b = Buffer.concat(ch); b.length >= w * h * 3 ? resolve(b) : reject(new Error('sin fotograma')); });
  });
}
async function grabJpg(input, t) {
  input = await localUrl(input);
  return new Promise((resolve, reject) => {
    const pr = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', input, '-frames:v', '1', '-q:v', '3', '-f', 'mjpeg', 'pipe:1']);
    const ch = []; pr.stdout.on('data', d => ch.push(d)); pr.on('error', reject); pr.on('close', () => resolve(Buffer.concat(ch)));
  });
}
function quality(rgb, w = 640, h = 360) {
  let sum = 0, lap = 0, n = 0;
  const g = i => rgb[i * 3] * 0.3 + rgb[i * 3 + 1] * 0.59 + rgb[i * 3 + 2] * 0.11;
  for (let y = 1; y < h - 1; y += 2) for (let x = 1; x < w - 1; x += 2) {
    const i = y * w + x, c = g(i);
    sum += c; lap += Math.abs(4 * c - g(i - 1) - g(i + 1) - g(i - w) - g(i + w)); n++;
  }
  return { bright: sum / n / 255, sharp: lap / n };
}
export async function bestFrames(id, { n = 6, samples = 30 } = {}) {
  const p = await getProject(id);
  if (!p.source) throw new Error('El vídeo original ya no está disponible.');
  const dur = p.duration || 60, input = inputPath(p.source);
  const W = p.data.width || 1920, H = p.data.height || 1080;
  const fw = 640, fh = Math.round(640 * H / W / 2) * 2;
  const cands = [];
  for (let i = 0; i < samples; i++) {
    const t = dur * (i + 0.5) / samples;
    try {
      const rgb = await grab(input, t, fw, fh);
      const faces = fh === 360 ? await detectFaces(rgb) : [];
      const { bright, sharp } = quality(rgb, fw, fh);
      const big = faces.reduce((m, f) => Math.max(m, (f.x2 - f.x1) * (f.y2 - f.y1)), 0);
      const score = sharp / 20 + (faces.length ? 2 + Math.min(3, big * 40) : 0) - Math.abs(bright - 0.5) * 3;
      cands.push({ t, faces: faces.length, score });
    } catch {}
  }
  cands.sort((a, b) => b.score - a.score);
  const pick = [];
  for (const c of cands) if (!pick.some(x => Math.abs(x.t - c.t) < dur / samples * 1.5)) pick.push(c);
  const frames = [];
  for (const c of pick.slice(0, n)) {
    const jpg = await grabJpg(input, c.t);
    if (jpg.length < 1000) continue;
    frames.push({ t: +c.t.toFixed(2), faces: c.faces, ref: await saveBuffer(jpg, `frame_${id}_${Math.round(c.t)}.jpg`, 'image/jpeg') });
  }
  const fresh = await getProject(id);
  await updateProject(id, { data: { ...fresh.data, frames } });
  return frames;
}

// ---------- Transcripción descargable ----------
const srtTime = t => { const ms = Math.round(t * 1000); const h = Math.floor(ms / 3600000), m = Math.floor(ms % 3600000 / 60000), s = Math.floor(ms % 60000 / 1000); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
export function transcriptFile(p, fmt) {
  const segs = p.data.transcript?.segments || [];
  if (fmt === 'srt') return segs.map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${s.text.trim()}\n`).join('\n');
  return segs.map(s => `[${mmss(s.start)}] ${s.text.trim()}`).join('\n');
}

// ---------- Rutas ----------
export function mountReport(app, h) {
  app.post('/api/projects/:id/report', h(async (req, res) => res.json(await buildReport(Number(req.params.id)))));
  app.post('/api/projects/:id/frames', h(async (req, res) => {
    const frames = await bestFrames(Number(req.params.id));
    res.json(frames.map(f => ({ ...f, url: publicUrl(f.ref) })));
  }));
  app.get('/api/projects/:id/transcript.:fmt', h(async (req, res) => {
    const p = await getProject(req.params.id);
    if (req.params.fmt === 'json') return res.json({ language: p.data.transcript?.language || '', segments: p.data.transcript?.segments || [] });
    const fmt = req.params.fmt === 'srt' ? 'srt' : 'txt';
    res.set('content-type', 'text/plain; charset=utf-8').set('content-disposition', `attachment; filename="${String(p.title || 'transcripcion').replace(/[^\w.-]+/g, '_')}.${fmt}"`);
    res.send(transcriptFile(p, fmt));
  }));
  app.post('/api/projects/:id/ask', h(async (req, res) => {
    const p = await getProject(req.params.id);
    const question = String(req.body?.question || '').trim().slice(0, 1000);
    if (!question) throw new Error('Escribe una pregunta.');
    const history = (req.body?.history || []).slice(-6).map(m => `${m.role === 'user' ? 'Usuario' : 'Asistente'}: ${String(m.text).slice(0, 1500)}`).join('\n');
    const answer = await chat('Eres un asistente que responde preguntas sobre un vídeo usando su transcripción. Cita los minutos [mm:ss] cuando sea útil. Si algo no aparece en la transcripción, dilo.',
      `Vídeo: "${p.title}". Transcripción:\n"""${condensed(p, 80000)}"""\n${history ? 'Conversación previa:\n' + history + '\n' : ''}Pregunta: ${question}`, { maxTokens: 1500 });
    res.json({ answer });
  }));
  // Usar un fotograma como fondo de una miniatura (abre el módulo Miniaturas)
  app.post('/api/projects/:id/frame-thumb', h(async (req, res) => {
    const p = await getProject(req.params.id);
    const f = (p.data.frames || []).find(x => x.ref === req.body?.ref);
    if (!f) throw new Error('Fotograma no encontrado.');
    const { one: one2 } = await import('./db.js');
    const t = await one2(`INSERT INTO thumbnails (title, format, style, niche, refs, ideas, items) VALUES ($1,'youtube','impacto','','[]','[]','[]') RETURNING id`, [p.title || 'Miniatura']);
    res.json({ thumbId: t.id, base: f.ref });
  }));
}

export { enqueue };
