// IA de voz local (sin internet, gratis): voces neuronales Piper en español ejecutadas con onnxruntime-web.
// Los modelos se descargan una vez (60-115 MB cada uno) de huggingface.co/rhasspy/piper-voices.
// Licencias de las voces: Claude (Apache 2.0), Ald (Unlicense), Dave FX (CC0), Sharvard (CC BY 3.0), Daniela (CC BY-SA 4.0).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { modelsDir } from './localwhisper.js';
import { fetchRetry } from './localmodels.js';
import { phonemize } from './es-g2p.js';
import { ffmpeg } from '../video/ffmpeg.js';

const require = createRequire(import.meta.url);
const HF = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/';

/** Voces locales: id → datos (id con «#M»/«#F» = hablante de un modelo con dos voces). */
export const PIPER_VOICES = {
  'es_MX-claude-high': { label: 'Claude (México, mujer)', gender: 'female', latam: true, path: 'es/es_MX/claude/high/es_MX-claude-high', mb: 63 },
  'es_MX-ald-medium': { label: 'Ald (México, hombre)', gender: 'male', latam: true, path: 'es/es_MX/ald/medium/es_MX-ald-medium', mb: 63 },
  'es_AR-daniela-high': { label: 'Daniela (Argentina, mujer)', gender: 'female', latam: true, path: 'es/es_AR/daniela/high/es_AR-daniela-high', mb: 114 },
  'es_ES-davefx-medium': { label: 'Dave (España, hombre)', gender: 'male', latam: false, path: 'es/es_ES/davefx/medium/es_ES-davefx-medium', mb: 63 },
  'es_ES-sharvard-medium#M': { label: 'Sharvard (España, hombre)', gender: 'male', latam: false, path: 'es/es_ES/sharvard/medium/es_ES-sharvard-medium', mb: 77, speaker: 0 },
  'es_ES-sharvard-medium#F': { label: 'Sharvard (España, mujer)', gender: 'female', latam: false, path: 'es/es_ES/sharvard/medium/es_ES-sharvard-medium', mb: 77, speaker: 1 },
};
const dir = () => path.join(modelsDir(), 'piper');
const files = v => { const b = path.join(dir(), path.basename(v.path)); return { onnx: b + '.onnx', json: b + '.onnx.json' }; };
export const piperReady = id => { const v = PIPER_VOICES[id]; if (!v) return false; const f = files(v); try { return fs.statSync(f.onnx).size > v.mb * 0.9e6 && fs.existsSync(f.json); } catch { return false; } };

// ---------- Descarga (una vez por voz) ----------
const downloads = new Map();
export const piperDownloadStatus = id => downloads.get(PIPER_VOICES[id]?.path) || null;
export function ensurePiperVoice(id, onProgress = () => {}) {
  const v = PIPER_VOICES[id];
  if (!v) return Promise.reject(new Error('Voz local desconocida: ' + id));
  if (piperReady(id)) return Promise.resolve(files(v));
  const cur = downloads.get(v.path);
  if (cur && !cur.done) return cur.promise;
  const st = { pct: 0, done: false, error: null };
  st.promise = (async () => {
    fs.mkdirSync(dir(), { recursive: true });
    const f = files(v);
    const j = await fetchRetry(HF + v.path + '.onnx.json', { redirect: 'follow' });
    if (!j.ok) throw new Error(`No se pudo descargar la voz ${v.label} (${j.status}).`);
    fs.writeFileSync(f.json, Buffer.from(await j.arrayBuffer()));
    const r = await fetchRetry(HF + v.path + '.onnx', { redirect: 'follow' });
    if (!r.ok || !r.body) throw new Error(`No se pudo descargar la voz ${v.label} (${r.status}). Comprueba tu conexión.`);
    const total = Number(r.headers.get('content-length')) || v.mb * 1e6;
    const part = f.onnx + '.part', out = fs.createWriteStream(part);
    let got = 0;
    for await (const chunk of r.body) {
      got += chunk.length;
      if (!out.write(chunk)) await new Promise(res => out.once('drain', res));
      const pct = Math.min(99, Math.floor(got / total * 100));
      if (pct !== st.pct) { st.pct = pct; try { onProgress(pct); } catch {} }
    }
    await new Promise((res, rej) => out.end(e => e ? rej(e) : res()));
    if (got < v.mb * 0.9e6) throw new Error('La descarga de la voz quedó incompleta; vuelve a intentarlo.');
    fs.renameSync(part, f.onnx);
    st.pct = 100;
    return f;
  })().then(x => { st.done = true; return x; }, e => { st.done = true; st.error = e.message; throw e; });
  downloads.set(v.path, st);
  return st.promise;
}

// ---------- Inferencia ----------
const sessions = new Map(); // ruta del modelo → { ort, s, cfg }
async function session(v) {
  const f = await ensurePiperVoice(Object.keys(PIPER_VOICES).find(k => PIPER_VOICES[k] === v));
  if (!sessions.has(f.onnx)) {
    if (sessions.size >= 3) sessions.delete(sessions.keys().next().value); // como mucho 3 voces en memoria
    sessions.set(f.onnx, (async () => {
      const ort = require('onnxruntime-web');
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.wasmPaths = pathToFileURL(path.dirname(require.resolve('onnxruntime-web')) + path.sep).href;
      ort.env.logLevel = 'error';
      const cfg = JSON.parse(fs.readFileSync(f.json, 'utf8'));
      return { ort, cfg, s: await ort.InferenceSession.create(f.onnx, { logSeverityLevel: 3, graphOptimizationLevel: 'all' }) };
    })().catch(e => { sessions.delete(f.onnx); throw e; }));
  }
  return sessions.get(f.onnx);
}

function wav16(samples, rate) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  return b;
}

/** Genera la voz con Piper. speed: 1 = normal, 1.15 = más rápida. */
export async function piperTTS(text, outFile, id = 'es_MX-claude-high', { speed = 1 } = {}) {
  const v = PIPER_VOICES[id] || PIPER_VOICES['es_MX-claude-high'];
  const { ort, s, cfg } = await session(v);
  const map = cfg.phoneme_id_map, rate = cfg.audio?.sample_rate || 22050, inf = cfg.inference || {};
  const pad = map._?.[0] ?? 0, bos = map['^']?.[0] ?? 1, eos = map.$?.[0] ?? 2;
  const chunks = [];
  for (const ph of phonemize(text, { latam: v.latam })) {
    const ids = [bos, pad];
    for (const p of ph) for (const ch of [...p]) { const id2 = map[ch]?.[0]; if (id2 != null) ids.push(id2, pad); }
    ids.push(eos);
    if (ids.length < 5) continue;
    const feeds = {
      input: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
      input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
      scales: new ort.Tensor('float32', Float32Array.from([inf.noise_scale ?? 0.667, (inf.length_scale ?? 1) / (Number(speed) || 1), inf.noise_w ?? 0.8]), [3]),
    };
    if ((cfg.num_speakers || 1) > 1) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([BigInt(v.speaker || 0)]), [1]);
    const res = await s.run(feeds);
    chunks.push(res[s.outputNames[0]].data, new Float32Array(Math.round(rate * 0.22))); // pausa entre frases
  }
  if (!chunks.length) throw new Error('No hay texto que leer.');
  const all = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
  const wav = outFile + '.wav';
  fs.writeFileSync(wav, wav16(all, rate));
  try { await ffmpeg(['-y', '-i', wav, '-ar', '44100', '-ac', '1', '-b:a', '128k', outFile]); }
  finally { fs.rmSync(wav, { force: true }); }
  return outFile;
}
