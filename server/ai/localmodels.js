// Modelos de IA locales (app de escritorio): texto con llama.cpp (Qwen 2.5 7B), imágenes con stable-diffusion.cpp.
// Los programas van incluidos en la app; los modelos se descargan una sola vez en la carpeta de datos.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { WORK_DIR } from '../db.js';
import { modelsDir } from './localwhisper.js';

export const LOCAL_MODELS = {
  'qwen2.5-7b': { kind: 'llm', file: 'Qwen2.5-7B-Instruct-Q4_K_M.gguf', mb: 4680, label: 'Qwen 2.5 7B (texto: clips, títulos, informe…)',
    url: 'https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf' },
  'qwen2.5-0.5b': { kind: 'llm', file: 'qwen2.5-0.5b-instruct-q4_k_m.gguf', mb: 400, label: 'Qwen 2.5 0.5B (solo pruebas)', hidden: true,
    url: 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf' },
  dreamshaper8: { kind: 'image', file: 'DreamShaper_8_pruned.safetensors', mb: 2130, label: 'DreamShaper 8 (imágenes de fondo para miniaturas)',
    url: 'https://huggingface.co/Lykon/DreamShaper/resolve/main/DreamShaper_8_pruned.safetensors' },
};
export const DEFAULT_LLM_MODEL = process.env.LOCAL_LLM_MODEL || 'qwen2.5-7b';
export const DEFAULT_IMAGE_MODEL = 'dreamshaper8';

const bin = names => {
  const dirs = [process.env.LOCAL_BIN_DIR, ...(process.env.PATH || '').split(path.delimiter)].filter(Boolean);
  for (const d of dirs) for (const n of names) { const f = path.join(d, process.platform === 'win32' ? n + '.exe' : n); try { if (fs.statSync(f).isFile()) return f; } catch {} }
  return null;
};
export const llamaBinary = () => process.env.LLAMA_SERVER || bin(['llama-server']);
export const sdBinary = () => process.env.SD_CLI || bin(['sd', 'sd-cli']);
export const localLLMAvailable = () => !!llamaBinary();
export const localImageAvailable = () => !!sdBinary();

export const modelFile = name => path.join(modelsDir(), LOCAL_MODELS[name].file);
export const modelReady = name => { try { return fs.statSync(modelFile(name)).size > LOCAL_MODELS[name].mb * 0.9e6; } catch { return false; } };

// ---------- Descarga (una vez, con progreso y reanudación) ----------
const downloads = new Map();
export const downloadStatus = name => { const d = downloads.get(name); return d ? { pct: d.pct, error: d.error, active: !d.done } : null; };
export function ensureModel(name, onProgress = () => {}) {
  const m = LOCAL_MODELS[name];
  if (!m) return Promise.reject(new Error('Modelo desconocido: ' + name));
  if (modelReady(name)) return Promise.resolve(modelFile(name));
  const cur = downloads.get(name);
  if (cur && !cur.done) { cur.listeners.add(onProgress); return cur.promise; }
  const st = { pct: 0, done: false, error: null, listeners: new Set([onProgress]) };
  st.promise = (async () => {
    fs.mkdirSync(modelsDir(), { recursive: true });
    const final = modelFile(name), part = final + '.part';
    let have = 0; try { have = fs.statSync(part).size; } catch {}
    const r = await fetch(m.url, { redirect: 'follow', headers: have ? { range: `bytes=${have}-` } : {} });
    if (!r.ok || !r.body) throw new Error(`No se pudo descargar el modelo ${m.label} (${r.status}).`);
    if (r.status !== 206) have = 0; // el servidor no admite reanudar: desde el principio
    const total = have + (Number(r.headers.get('content-length')) || m.mb * 1e6);
    const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
    let got = have, last = -1;
    for await (const chunk of r.body) {
      got += chunk.length;
      if (!out.write(chunk)) await new Promise(res => out.once('drain', res));
      const pct = Math.min(99, Math.floor(got / total * 100));
      if (pct !== last) { last = pct; st.pct = pct; for (const l of st.listeners) { try { l(pct); } catch {} } }
    }
    await new Promise((res, rej) => out.end(e => e ? rej(e) : res()));
    if (got < m.mb * 0.9e6) throw new Error('La descarga del modelo quedó incompleta; vuelve a intentarlo (continuará donde se quedó).');
    fs.renameSync(part, final);
    st.pct = 100;
    return final;
  })().then(p => { st.done = true; return p; }, e => { st.done = true; st.error = e.message; throw e; });
  downloads.set(name, st);
  return st.promise;
}

// ---------- Texto: llama-server en segundo plano (API compatible con OpenAI) ----------
let server = null; // { proc, port, model, ready }
const freePort = () => new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const CTX = Number(process.env.LOCAL_LLM_CTX || 32768);

async function startServer(name, onProgress) {
  if (server && server.model === name && !server.proc.killed && server.proc.exitCode == null) return server.ready;
  if (server) { try { server.proc.kill(); } catch {} server = null; }
  const exe = llamaBinary();
  if (!exe) throw new Error('La IA local de texto solo está en la app de escritorio (falta llama-server).');
  const file = await ensureModel(name, pct => onProgress?.({ stage: `Descargando la IA local (solo la primera vez)… ${pct}%`, pct: 0 }));
  const port = await freePort();
  const gpu = process.platform === 'darwin' && process.arch === 'arm64' ? ['-ngl', '99'] : process.env.LOCAL_LLM_GPU_LAYERS ? ['-ngl', process.env.LOCAL_LLM_GPU_LAYERS] : [];
  const threads = String(Math.max(2, Math.min(12, os.cpus().length - 1)));
  const proc = spawn(exe, ['-m', file, '--host', '127.0.0.1', '--port', String(port), '-c', String(CTX), '-np', '1', '-t', threads, ...gpu],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  proc.stdout.on('data', d => { log = (log + d).slice(-4000); });
  proc.stderr.on('data', d => { log = (log + d).slice(-4000); });
  const s = { proc, port, model: name };
  s.ready = (async () => {
    onProgress?.({ stage: 'Cargando la IA local…', pct: 0 });
    for (let i = 0; i < 600; i++) { // hasta 5 min (equipos lentos)
      if (proc.exitCode != null) throw new Error('La IA local no pudo arrancar: ' + log.split('\n').filter(Boolean).slice(-3).join(' '));
      try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return s; } catch {}
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error('La IA local tardó demasiado en arrancar.');
  })();
  s.ready.catch(() => { if (server === s) server = null; });
  server = s;
  proc.on('exit', () => { if (server === s) server = null; });
  return s.ready;
}
process.on('exit', () => { try { server?.proc.kill(); } catch {} });

/** Chat con la IA local. Devuelve el texto de la respuesta. */
export async function chatLocal(system, user, { json = false, maxTokens = 4000, model = DEFAULT_LLM_MODEL, onProgress } = {}) {
  const s = await startServer(model, onProgress);
  // El contexto tiene un límite: si la petición es enorme se recorta el centro del texto (se avisa al modelo)
  const maxChars = (CTX - maxTokens - 600) * 3.2;
  if (system.length + user.length > maxChars) {
    const keep = Math.max(2000, maxChars - system.length);
    user = user.slice(0, keep * 0.7) + '\n[…texto recortado por longitud…]\n' + user.slice(-keep * 0.3);
  }
  const r = await fetch(`http://127.0.0.1:${s.port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens, temperature: 0.5,
      ...(json ? { response_format: { type: 'json_object' } } : {}) }),
    signal: AbortSignal.timeout(45 * 60 * 1000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`IA local (${r.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text).choices?.[0]?.message?.content || '';
}

// ---------- Imágenes: stable-diffusion.cpp ----------
export async function imageLocal(prompt, { size = '1024x1536', steps = Number(process.env.LOCAL_IMAGE_STEPS || 22), onProgress } = {}) {
  const exe = sdBinary();
  if (!exe) throw new Error('La generación de imágenes local solo está en la app de escritorio (falta stable-diffusion).');
  const model = await ensureModel(DEFAULT_IMAGE_MODEL, pct => onProgress?.(`Descargando el modelo de imágenes (solo la primera vez)… ${pct}%`));
  const [w0, h0] = String(size).split('x').map(Number);
  // SD 1.5: ~0,4 megapíxeles en múltiplos de 64 (después se escala al tamaño final)
  const ratio = (w0 || 1) / (h0 || 1);
  const w = Math.round(Math.sqrt(400000 * ratio) / 64) * 64, h = Math.round(Math.sqrt(400000 / ratio) / 64) * 64;
  const out = path.join(WORK_DIR, `sd_${crypto.randomBytes(5).toString('hex')}.png`);
  const neg = 'text, letters, words, watermark, logo, signature, blurry, lowres, deformed, extra fingers, bad anatomy, ugly';
  await new Promise((resolve, reject) => {
    const p = spawn(exe, ['-m', model, '-p', prompt.slice(0, 900), '-n', neg, '-W', String(w), '-H', String(h), '--steps', String(steps), '--cfg-scale', '6.5',
      '--sampling-method', 'dpm++2m', '-t', String(Math.max(2, os.cpus().length - 1)), '-o', out], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let log = '';
    const on = d => { const s = String(d); log = (log + s).slice(-3000); const m = s.match(/(\d+)\/(\d+)\s*-/); if (m) onProgress?.(`Generando la imagen en tu equipo… ${Math.round(m[1] / m[2] * 100)}%`); };
    p.stdout.on('data', on); p.stderr.on('data', on);
    p.on('error', e => reject(new Error('No se pudo ejecutar stable-diffusion: ' + e.message)));
    p.on('close', code => code === 0 && fs.existsSync(out) ? resolve() : reject(new Error('La generación local de la imagen falló: ' + log.split('\n').filter(Boolean).slice(-2).join(' '))));
  });
  try { return fs.readFileSync(out); } finally { fs.rmSync(out, { force: true }); }
}
