import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ffmpeg, run, FFMPEG } from '../video/ffmpeg.js';
import { getSetting, requireKey } from '../settings.js';
import { WORK_DIR } from '../db.js';
import { apiError } from './llm.js';
import { audioEnergy } from '../video/signals.js';

// 15 min de mp3 mono 32 kbps ≈ 3,6 MB (< 25 MB límite de Whisper) y cabe en un paso de 300 s
export const CHUNK_SECONDS = 15 * 60;

async function whisper(file, language) {
  const provider = await getSetting('transcribe_provider');
  const isGroq = provider === 'groq';
  const key = await requireKey(isGroq ? 'groq_key' : 'openai_key', 'transcribir el audio');
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(file)], { type: 'audio/mpeg' }), path.basename(file));
  form.append('model', isGroq ? 'whisper-large-v3-turbo' : 'whisper-1');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  form.append('timestamp_granularities[]', 'segment');
  if (language) form.append('language', language);
  const url = isGroq ? 'https://api.groq.com/openai/v1/audio/transcriptions' : (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1') + '/audio/transcriptions';
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
export async function transcribeChunk(input, { offset = 0, len = CHUNK_SECONDS, language } = {}) {
  const out = path.join(WORK_DIR, `audio_${crypto.randomBytes(5).toString('hex')}.mp3`);
  try {
    // Una sola lectura del vídeo: extrae el audio y, a la vez, detecta cambios de plano en los fotogramas clave
    const { err } = await run(FFMPEG, ['-hide_banner', '-loglevel', 'info', '-y', '-skip_frame:v', 'nokey',
      '-ss', String(offset), '-t', String(len), '-i', input,
      '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', out,
      '-map', '0:v:0?', '-an', '-vf', 'scale=160:90,select=gt(scene\\,0.35),showinfo', '-fps_mode', 'passthrough', '-f', 'null', '-'],
      { timeoutMs: 150000 });
    const cuts = [...err.matchAll(/Parsed_showinfo.*?pts_time:\s*([\d.]+)/g)].map(m => +(parseFloat(m[1]) + offset).toFixed(2));
    const [r, energy] = await Promise.all([whisper(out, language), audioEnergy(out, offset).catch(() => [])]);
    const segments = (r.segments || []).map(s => ({ start: s.start + offset, end: s.end + offset, text: s.text.trim() }));
    let words = (r.words || []).map(w => ({ word: w.word.trim(), start: w.start + offset, end: w.end + offset }));
    if (!words.length) words = approximateWords(segments);
    return { language: r.language || language || '', segments, words, energy, cuts };
  } finally { fs.rmSync(out, { force: true }); }
}

/** Tiempos por palabra de una locución corta; si no hay clave de transcripción, se aproximan. */
export async function wordTimings(audioFile, text, duration) {
  try {
    const provider = await getSetting('transcribe_provider');
    if (await getSetting(provider === 'groq' ? 'groq_key' : 'openai_key')) {
      const r = await whisper(audioFile);
      const words = (r.words || []).map(w => ({ word: w.word.trim(), start: w.start, end: w.end }));
      if (words.length) return words;
    }
  } catch (e) { console.warn('wordTimings:', e.message); }
  return approximateWords([{ start: 0, end: duration, text }]);
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
