import fs from 'node:fs';
import path from 'node:path';
import { ffmpeg, probe } from '../video/ffmpeg.js';
import { getSetting, requireKey } from '../settings.js';
import { apiError } from './llm.js';

const CHUNK_SECONDS = 20 * 60; // 20 min de mp3 mono 32 kbps ≈ 4,8 MB (< 25 MB límite de Whisper)

async function transcribeFile(file, provider, language) {
  const isGroq = provider === 'groq';
  const key = requireKey(isGroq ? 'groq_key' : 'openai_key', 'transcribir el audio');
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(file)], { type: 'audio/mpeg' }), path.basename(file));
  form.append('model', isGroq ? 'whisper-large-v3-turbo' : 'whisper-1');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  form.append('timestamp_granularities[]', 'segment');
  if (language) form.append('language', language);
  const url = isGroq ? 'https://api.groq.com/openai/v1/audio/transcriptions' : 'https://api.openai.com/v1/audio/transcriptions';
  const r = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer ' + key }, body: form });
  const text = await r.text();
  if (!r.ok) throw new Error(`Error de transcripción (${r.status}): ${apiError(text)}`);
  return JSON.parse(text);
}

/**
 * Transcribe un vídeo/audio completo con marcas de tiempo por palabra.
 * Devuelve { language, segments:[{start,end,text}], words:[{word,start,end}] }
 */
export async function transcribe(mediaPath, workDir, { language, onProgress } = {}) {
  const provider = getSetting('transcribe_provider');
  fs.mkdirSync(workDir, { recursive: true });
  const { duration } = await probe(mediaPath);
  const chunks = Math.max(1, Math.ceil(duration / CHUNK_SECONDS));
  const result = { language: language || '', segments: [], words: [] };

  for (let i = 0; i < chunks; i++) {
    const offset = i * CHUNK_SECONDS;
    onProgress?.(`Transcribiendo audio (${i + 1}/${chunks})…`);
    const out = path.join(workDir, `audio_${i}.mp3`);
    await ffmpeg(['-ss', String(offset), '-t', String(CHUNK_SECONDS), '-i', mediaPath, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', out]);
    const r = await transcribeFile(out, provider, language);
    if (!result.language && r.language) result.language = r.language;
    for (const s of r.segments || []) result.segments.push({ start: s.start + offset, end: s.end + offset, text: s.text.trim() });
    for (const w of r.words || []) result.words.push({ word: w.word.trim(), start: w.start + offset, end: w.end + offset });
    fs.rmSync(out, { force: true });
  }
  // Si el proveedor no da palabras, las aproximamos repartiendo cada segmento.
  if (!result.words.length) result.words = approximateWords(result.segments);
  return result;
}

export function approximateWords(segments) {
  const words = [];
  for (const s of segments) {
    const parts = s.text.split(/\s+/).filter(Boolean);
    const step = (s.end - s.start) / Math.max(1, parts.length);
    parts.forEach((w, i) => words.push({ word: w, start: s.start + i * step, end: s.start + (i + 1) * step }));
  }
  return words;
}
