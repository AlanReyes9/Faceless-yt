// Transcripción LOCAL con whisper.cpp (gratis, sin internet tras descargar el modelo, el audio no sale del equipo).
// La app de escritorio incluye el programa whisper-cli; el modelo se descarga una vez en la carpeta de datos.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { DATA_DIR, WORK_DIR } from '../db.js';
import { ffmpeg } from '../video/ffmpeg.js';

export const WHISPER_MODELS = {
  base: { file: 'ggml-base.bin', mb: 142, label: 'Base (rápido, ~150 MB)' },
  small: { file: 'ggml-small.bin', mb: 466, label: 'Small (recomendado, ~500 MB)' },
  medium: { file: 'ggml-medium.bin', mb: 1500, label: 'Medium (máxima precisión, ~1,5 GB)' },
  'large-v3-turbo': { file: 'ggml-large-v3-turbo-q5_0.bin', mb: 547, label: 'Large v3 Turbo (muy preciso, ~550 MB; mejor con Mac M1–M4)' },
};
const MODEL_URL = f => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${f}`;

export const modelsDir = () => process.env.WHISPER_MODELS_DIR || path.join(DATA_DIR, 'models');
export function whisperBinary() {
  const exe = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
  const cands = [process.env.WHISPER_CLI, ...(process.env.PATH || '').split(path.delimiter).map(d => d && path.join(d, exe))].filter(Boolean);
  return cands.find(f => { try { return fs.statSync(f).isFile(); } catch { return false; } }) || null;
}
export const localAvailable = () => !!whisperBinary();
export const modelPath = name => path.join(modelsDir(), (WHISPER_MODELS[name] || WHISPER_MODELS.small).file);
export const modelReady = name => { try { return fs.statSync(modelPath(name)).size > 10e6; } catch { return false; } };

// ---------- Descarga del modelo (una vez), con progreso ----------
const downloads = new Map(); // name -> { pct, mb, error, promise }
export const downloadStatus = name => { const d = downloads.get(name); return d ? { pct: d.pct, error: d.error, active: !d.done } : null; };
export function ensureModel(name, onProgress = () => {}) {
  if (!WHISPER_MODELS[name]) name = 'small';
  if (modelReady(name)) return Promise.resolve(modelPath(name));
  const cur = downloads.get(name);
  if (cur && !cur.done) { cur.listeners.add(onProgress); return cur.promise; }
  const st = { pct: 0, done: false, error: null, listeners: new Set([onProgress]) };
  st.promise = (async () => {
    fs.mkdirSync(modelsDir(), { recursive: true });
    const final = modelPath(name), part = final + '.part';
    const { fetchRetry } = await import('./localmodels.js');
    const r = await fetchRetry(MODEL_URL(WHISPER_MODELS[name].file), { redirect: 'follow' });
    if (!r.ok || !r.body) throw new Error(`No se pudo descargar el modelo de transcripción (${r.status}).`);
    const total = Number(r.headers.get('content-length')) || WHISPER_MODELS[name].mb * 1e6;
    const out = fs.createWriteStream(part);
    let got = 0, last = 0;
    for await (const chunk of r.body) {
      got += chunk.length;
      if (!out.write(chunk)) await new Promise(res => out.once('drain', res));
      const pct = Math.min(99, Math.round(got / total * 100));
      if (pct !== last) { last = pct; st.pct = pct; for (const l of st.listeners) { try { l(pct); } catch {} } }
    }
    await new Promise((res, rej) => out.end(err => err ? rej(err) : res()));
    if (got < 10e6) throw new Error('La descarga del modelo quedó incompleta.');
    fs.renameSync(part, final);
    st.pct = 100;
    return final;
  })().then(p => { st.done = true; return p; }, e => { st.done = true; st.error = e.message; throw e; });
  downloads.set(name, st);
  return st.promise;
}

// ---------- Transcripción ----------
const LANG = { spanish: 'es', english: 'en', portuguese: 'pt', french: 'fr', italian: 'it', german: 'de' };

/**
 * Transcribe un archivo de audio con whisper-cli. Devuelve el mismo formato que la API de Whisper:
 * { language, segments:[{start,end,text}], words:[{word,start,end}] } (tiempos relativos al audio).
 */
export async function transcribeLocal(audioFile, { language, model, onProgress = () => {}, timeoutMs, fast = process.env.WHISPER_FAST !== '0' } = {}) {
  const bin = whisperBinary();
  if (!bin) throw new Error('La transcripción local no está disponible en esta instalación (falta whisper-cli). Usa la app de escritorio o elige OpenAI/Groq en Ajustes.');
  const mp = await ensureModel(model, pct => onProgress({ stage: `Descargando el modelo de transcripción (solo la primera vez)… ${pct}%`, pct: 0 }));
  const tag = crypto.randomBytes(5).toString('hex');
  const wav = path.join(WORK_DIR, `wl_${tag}.wav`), outBase = path.join(WORK_DIR, `wl_${tag}`);
  try {
    await ffmpeg(['-i', audioFile, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], { timeoutMs: 120000 });
    const lang = !language ? 'auto' : (LANG[String(language).toLowerCase()] || String(language).slice(0, 2).toLowerCase());
    const n = os.cpus().length, threads = String(Math.max(2, Math.min(8, process.arch === 'x64' ? Math.ceil(n / 2) : n - 1))); // núcleos físicos en Intel/AMD
    // -ml 1 + -sow: un segmento por palabra (tiempos por palabra); -oj: salida JSON
    // -bs 1 -bo 1: búsqueda simple en vez de "beam search" de 5 (varias veces más rápido en el procesador y casi igual de preciso)
    // -fa: atención rápida (flash attention)
    const args = ['-m', mp, '-f', wav, '-l', lang, '-t', threads, ...(fast ? ['-bs', '1', '-bo', '1', '-fa'] : []), '-ml', '1', '-sow', '-oj', '-of', outBase, '-pp', '-np'];
    await runWhisper(bin, args, onProgress, timeoutMs);
    return finish(parseWords(outBase), outBase, lang);
  } finally {
    for (const f of [wav, outBase + '.json']) fs.rmSync(f, { force: true });
  }
}

function runWhisper(bin, args, onProgress, timeoutMs) {
    return new Promise((resolve, reject) => {
      const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let err = '';
      const timer = timeoutMs ? setTimeout(() => { p.kill('SIGKILL'); reject(new Error('La transcripción local tardó demasiado.')); }, timeoutMs) : null;
      const onData = d => {
        const s = String(d); err = (err + s).slice(-4000);
        const m = s.match(/progress\s*=\s*(\d+)%/g);
        if (m) onProgress({ stage: 'Transcribiendo en tu equipo', pct: Number(m[m.length - 1].match(/\d+/)[0]) });
      };
      p.stdout.on('data', onData); p.stderr.on('data', onData);
      p.on('error', e => { clearTimeout(timer); reject(new Error('No se pudo ejecutar whisper-cli: ' + e.message)); });
      p.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`whisper-cli falló (código ${code}): ${err.split('\n').filter(Boolean).slice(-3).join(' ')}`)); });
    });
}

let lastJson = null;
function parseWords(outBase) {
    const j = lastJson = JSON.parse(fs.readFileSync(outBase + '.json', 'utf8'));
    const words = [];
    for (const s of j.transcription || []) {
      const text = String(s.text || '').trim();
      if (!text || /^\[.*\]$|^\(.*\)$/.test(text)) continue; // [música], (risas)…
      const start = (s.offsets?.from ?? 0) / 1000, end = (s.offsets?.to ?? 0) / 1000;
      // con -sow algunos segmentos traen signos sueltos: se pegan a la palabra anterior
      if (/^[.,!?;:…)"»]+$/.test(text) && words.length) { words[words.length - 1].word += text; words[words.length - 1].end = end; continue; }
      words.push({ word: text, start, end: Math.max(end, start + 0.05) });
    }
    return words;
}

function finish(words, outBase, lang) {
    const j = lastJson || {};
    // Frases: se cortan en puntuación, en pausas largas o cada ~14 palabras
    const segments = [];
    let cur = [];
    words.forEach((w, i) => {
      cur.push(w);
      const next = words[i + 1];
      if (!next || /[.!?…]$/.test(w.word) || next.start - w.end > 0.9 || cur.length >= 14) {
        segments.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map(x => x.word).join(' ') });
        cur = [];
      }
    });
    return { language: j.result?.language || lang, segments, words };
}
