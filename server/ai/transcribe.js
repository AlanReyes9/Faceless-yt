import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ffmpeg, run, FFMPEG } from '../video/ffmpeg.js';
import { getSetting, requireKey } from '../settings.js';
import { WORK_DIR, q, one } from '../db.js';
import { apiError } from './llm.js';
import { audioEnergy, sceneCuts } from '../video/signals.js';
import { proxyBytes } from '../video/netproxy.js';
import { transcribeLocal, localAvailable } from './localwhisper.js';

// 15 min de mp3 mono 32 kbps ≈ 3,6 MB (< 25 MB límite de Whisper) y cabe en un paso de 300 s
export const CHUNK_SECONDS = 15 * 60;

/** Proveedor efectivo: 'local' (whisper.cpp en el equipo), 'openai' o 'groq'. */
export async function transcribeProvider() {
  const p = await getSetting('transcribe_provider');
  if (p === 'local' && !localAvailable()) return 'openai';
  return p || (localAvailable() ? 'local' : 'openai');
}

async function whisper(file, language, onProgress) {
  const provider = await transcribeProvider();
  if (provider === 'local') return transcribeLocal(file, { language, model: await getSetting('whisper_model'), onProgress });
  const isGroq = provider === 'groq';
  const key = await requireKey(isGroq ? 'groq_key' : 'openai_key', 'transcribir el audio');
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(file)], { type: 'audio/mpeg' }), path.basename(file));
  form.append('model', isGroq ? (await getSetting('groq_whisper_model') || 'whisper-large-v3') : 'whisper-1');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  form.append('timestamp_granularities[]', 'segment');
  if (language) form.append('language', language);
  const url = isGroq ? (process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1') + '/audio/transcriptions' : (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1') + '/audio/transcriptions';
  const r = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer ' + key }, body: form, signal: AbortSignal.timeout(150000) })
    .catch(e => { throw new Error(e.name === 'TimeoutError' ? 'La transcripción tardó demasiado en responder (más de 2,5 min).' : 'No se pudo conectar con el servicio de transcripción: ' + e.message); });
  const text = await r.text();
  if (!r.ok) throw new Error(`Error de transcripción (${r.status}): ${apiError(text)}`);
  return JSON.parse(text);
}

/**
 * Transcribe un trozo [offset, offset+len] de un vídeo/audio (ruta o URL).
 * Devuelve { language, segments:[{start,end,text}], words:[{word,start,end}] } con tiempos absolutos.
 */
// Caché de transcripciones: el mismo archivo (mismo tamaño y mismo principio/final), mismo trozo y mismo motor → no se paga dos veces
async function cacheKey(input, offset, len, language) {
  try {
    if (/^https?:/.test(String(input))) return null;
    const st = fs.statSync(input);
    if (st.size < 1e5) return null;
    const fd = fs.openSync(input, 'r'), a = Buffer.alloc(1 << 20), b = Buffer.alloc(1 << 20);
    try { fs.readSync(fd, a, 0, a.length, 0); fs.readSync(fd, b, 0, b.length, Math.max(0, st.size - b.length)); } finally { fs.closeSync(fd); }
    const prov = await transcribeProvider(), model = prov === 'local' ? await getSetting('whisper_model') : prov === 'groq' ? await getSetting('groq_whisper_model') : 'whisper-1';
    return crypto.createHash('sha1').update(a).update(b).update(`${st.size}|${offset}|${len}|${language || ''}|${prov}|${model}`).digest('hex');
  } catch { return null; }
}

export async function transcribeChunk(input, opts = {}) {
  const { offset = 0, len = CHUNK_SECONDS, language } = opts;
  const key = await cacheKey(input, offset, len, language);
  if (key) {
    const hit = await one('SELECT data FROM transcript_cache WHERE key = $1', [key]).catch(() => null);
    if (hit?.data?.segments) { console.log(`[transcribir ${offset}s] reutilizada la transcripción guardada (no se vuelve a pagar)`); return hit.data; }
  }
  const r = await transcribeChunkRaw(input, opts);
  if (key && r?.segments?.length) {
    await q('INSERT INTO transcript_cache (key, data) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, created_at = now()', [key, JSON.stringify(r)]).catch(() => {});
    await q("DELETE FROM transcript_cache WHERE created_at < now() - interval '60 days'").catch(() => {});
  }
  return r;
}

async function transcribeChunkRaw(input, { offset = 0, len = CHUNK_SECONDS, language, onProgress } = {}) {
  const out = path.join(WORK_DIR, `audio_${crypto.randomBytes(5).toString('hex')}.mp3`);
  try {
    const log = (m, t) => console.log(`[transcribir ${offset}s] ${m}${t ? ` en ${((Date.now() - t) / 1000).toFixed(1)} s` : ''} · descargado ${(proxyBytes() / 1e6).toFixed(0)} MB`);
    // 1) Audio (imprescindible): sin decodificar el vídeo
    let t = Date.now();
    // aresample async+first_pts=0: si el audio empieza más tarde que la imagen (habitual en directos y vídeos de móvil),
    // se rellena con silencio para que los tiempos de las palabras coincidan con el vídeo (si no, los subtítulos se adelantan)
    await ffmpeg(['-ss', String(offset), '-t', String(len), '-i', input, '-vn', '-map', '0:a:0', '-af', 'aresample=async=1:first_pts=0', '-ac', '1', '-ar', '16000', '-b:a', '32k', out],
      { timeoutMs: 150000 });
    log(`audio extraído (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`, t);
    // 2) Whisper + energía del audio, y en paralelo los cambios de plano (opcional: si tarda, se omite)
    t = Date.now();
    const cutsP = sceneCuts(input, { offset, len, timeoutMs: 40000 }).then(c => { log(`cambios de plano: ${c.length}`, t); return c; }).catch(() => []);
    const [r, energy] = await Promise.all([
      whisper(out, language, onProgress).then(x => { log('Whisper respondió', t); return x; }),
      audioEnergy(out, offset).catch(() => []),
    ]);
    const cuts = await cutsP;
    const segments = (r.segments || []).map(s => ({ start: s.start + offset, end: s.end + offset, text: s.text.trim() }));
    let words = (r.words || []).map(w => ({ word: w.word.trim(), start: w.start + offset, end: w.end + offset }));
    if (!words.length) words = approximateWords(segments);
    else punctuateWords(words, segments);
    return { language: r.language || language || '', segments, words, energy, cuts };
  } finally { fs.rmSync(out, { force: true }); }
}

/** Tiempos por palabra de una locución corta; si no hay clave de transcripción, se aproximan. */
export async function wordTimings(audioFile, text, duration) {
  try {
    const provider = await transcribeProvider();
    if (provider === 'local' || await getSetting(provider === 'groq' ? 'groq_key' : 'openai_key')) {
      const r = await whisper(audioFile);
      const words = (r.words || []).map(w => ({ word: w.word.trim(), start: w.start, end: w.end }));
      if (words.length) return words;
    }
  } catch (e) { console.warn('wordTimings:', e.message); }
  return approximateWords([{ start: 0, end: duration, text }]);
}

/**
 * Whisper da las palabras sueltas sin puntuación, pero las frases (segmentos) sí la llevan: se copia a cada palabra
 * («¿hasta», «todo?», «capital.»). Así los subtítulos se cortan por frases y los clips empiezan y acaban en frases enteras.
 */
export function punctuateWords(words, segments) {
  const n = s => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9ñ]/g, '');
  let wi = 0;
  for (const s of segments) {
    const toks = String(s.text || '').split(/\s+/).filter(Boolean);
    let ti = 0;
    while (wi < words.length && words[wi].start < s.end - 0.02 && ti < toks.length) {
      const w = words[wi], nw = n(w.word);
      for (let j = ti; j < Math.min(toks.length, ti + 4); j++) if (nw && n(toks[j]) === nw) { w.word = toks[j]; ti = j + 1; break; }
      wi++;
    }
  }
  return words;
}

export function approximateWords(segments) {
  const words = [];
  for (const s of segments) {
    const parts = s.text.split(/\s+/).filter(Boolean);
    const total = parts.reduce((a, w) => a + w.length + 1, 0) || 1;
    let t = s.start;
    for (const w of parts) {
      const d = (s.end - s.start) * (w.length + 1) / total;
      words.push({ word: w, start: t, end: t + d });
      t += d;
    }
  }
  return words;
}
