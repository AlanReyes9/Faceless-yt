// Modelos de IA locales (app de escritorio): texto con llama.cpp (Qwen 2.5 7B), imágenes con stable-diffusion.cpp.
// Los programas van incluidos en la app; los modelos se descargan una sola vez en la carpeta de datos.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
import { WORK_DIR, DATA_DIR } from '../db.js';
import { modelsDir } from './localwhisper.js';

export const LOCAL_MODELS = {
  'qwen2.5-7b': { kind: 'llm', file: 'Qwen2.5-7B-Instruct-Q4_K_M.gguf', mb: 4680, label: 'Qwen 2.5 7B (texto: clips, títulos, informe…)',
    url: 'https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf' },
  'qwen3-4b': { kind: 'llm', file: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf', mb: 2497, label: 'Qwen3 4B (texto rápido: clips, títulos, informe…)',
    url: 'https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf' },
  'qwen3-0.6b': { kind: 'llm', file: 'Qwen3-0.6B-Q4_K_M.gguf', mb: 397, label: 'Qwen3 0.6B (solo pruebas)', hidden: true,
    url: 'https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q4_K_M.gguf' },
  'qwen2.5-0.5b': { kind: 'llm', file: 'qwen2.5-0.5b-instruct-q4_k_m.gguf', mb: 400, label: 'Qwen 2.5 0.5B (solo pruebas)', hidden: true,
    url: 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf' },
  // Ligera y rápida: 4 pasos en vez de 22 (unas 5 veces más rápida en equipos sin gráfica)
  sdturbo: { kind: 'image', file: 'sd_turbo-f16-q8_0.gguf', mb: 2024, label: 'SD-Turbo (imágenes rápidas en tu equipo)', turbo: true,
    url: 'https://huggingface.co/Green-Sky/SD-Turbo-GGUF/resolve/main/sd_turbo-f16-q8_0.gguf' },
  dreamshaper8: { kind: 'image', file: 'DreamShaper_8_pruned.safetensors', mb: 2130, label: 'DreamShaper 8 (imágenes de fondo para miniaturas)',
    url: 'https://huggingface.co/Lykon/DreamShaper/resolve/main/DreamShaper_8_pruned.safetensors' },
};
// Equipos sin gráfica (Mac Intel, Windows): Qwen3 4B, ~2 veces más rápido. Mac M (Metal): Qwen 2.5 7B.
export const AUTO_LLM_MODEL = process.platform === 'darwin' && process.arch === 'arm64' ? 'qwen2.5-7b' : 'qwen3-4b';
export const DEFAULT_LLM_MODEL = process.env.LOCAL_LLM_MODEL || AUTO_LLM_MODEL;
/** Modelo de texto elegido en Ajustes (auto = según el equipo). */
export async function currentLLMModel() {
  if (process.env.LOCAL_LLM_MODEL) return process.env.LOCAL_LLM_MODEL;
  const { getSetting } = await import('../settings.js');
  const v = await getSetting('local_llm').catch(() => 'auto');
  return LOCAL_MODELS[v]?.kind === 'llm' ? v : AUTO_LLM_MODEL;
}
/** Hilos: núcleos físicos en Intel/AMD (el hyperthreading frena a llama.cpp y whisper.cpp). */
// Mac M: la IA usa la gráfica del chip (Metal, incluido en la versión normal). Intel/Windows: procesador.
const appleSilicon = process.platform === 'darwin' && process.arch === 'arm64';

/** Núcleos físicos reales (macOS lo dice exactamente; en el resto se estima: la mitad en Intel/AMD por el hyperthreading). */
let _phys = null;
export function physicalCores() {
  if (_phys) return _phys;
  const n = os.cpus().length;
  if (process.platform === 'darwin') try {
    const { execFileSync } = require_('node:child_process');
    _phys = Number(String(execFileSync('sysctl', ['-n', process.arch === 'arm64' ? 'hw.perflevel0.physicalcpu' : 'hw.physicalcpu'], { timeout: 3000 })).trim()) || 0;
  } catch {}
  return (_phys ||= process.arch === 'x64' ? Math.max(1, Math.ceil(n / 2)) : Math.max(1, n - 1));
}
/** Hilos para llama.cpp / whisper.cpp / stable-diffusion.cpp: los núcleos físicos (medido: más rápido que la mitad o que todos los lógicos). */
export const cpuThreads = (max = 12) => Math.max(2, Math.min(max, physicalCores()));
export const DEFAULT_IMAGE_MODEL = 'sdturbo';
/** Modelo de imágenes local elegido en Ajustes: «sdturbo» (ligero, por defecto) o «dreamshaper8» (más calidad, más lento). */
export async function currentImageModel() {
  const { getSetting } = await import('../settings.js');
  const v = await getSetting('local_image_model').catch(() => '');
  return LOCAL_MODELS[v]?.kind === 'image' ? v : DEFAULT_IMAGE_MODEL;
}

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
/** fetch con reintentos ante cortes de red o errores temporales del servidor (502, 503…). */
export async function fetchRetry(url, opts = {}, tries = 5) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, opts);
      if (r.status < 500 && r.status !== 429) return r;
      last = r;
    } catch (e) { last = e; }
    await new Promise(res => setTimeout(res, 2000 * 2 ** i)); // 2, 4, 8, 16 s
  }
  if (last instanceof Error) throw last;
  return last;
}
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
    const r = await fetchRetry(m.url, { redirect: 'follow', headers: have ? { range: `bytes=${have}-` } : {} });
    if (!r.ok || !r.body) throw new Error(`No se pudo descargar el modelo ${m.label} (${r.status}). Comprueba tu conexión y vuelve a intentarlo.`);
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
  if (!llamaBinary()) throw new Error('La IA local de texto solo está en la app de escritorio (falta llama-server).');
  const file = await ensureModel(name, pct => onProgress?.({ stage: `Descargando la IA local (solo la primera vez)… ${pct}%`, pct: 0 }));
  const exe = llamaBinary();
  const port = await freePort();
  const gpu = appleSilicon ? ['-ngl', '99'] : process.env.LOCAL_LLM_GPU_LAYERS ? ['-ngl', process.env.LOCAL_LLM_GPU_LAYERS] : [];
  const threads = String(cpuThreads());
  const proc = spawn(exe, ['-m', file, '--host', '127.0.0.1', '--port', String(port), '-c', String(CTX), '-np', '1', '-t', threads, ...gpu],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  proc.stdout.on('data', d => { log = (log + d).slice(-4000); });
  proc.stderr.on('data', d => { log = (log + d).slice(-4000); });
  const s = { proc, port, model: name, log: () => log };
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
/** Precarga la IA de texto al abrir la app (si el modelo ya está descargado): la primera respuesta llega antes. */
export async function warmUp() {
  try {
    if (!llamaBinary()) return;
    const name = await currentLLMModel();
    if (!modelReady(name)) return;
    await startServer(name);
    console.log('[ia local] precargada:', name);
  } catch (e) { console.warn('[ia local] precarga:', e.message); }
}
export const restartLocalLLM = () => { try { server?.proc.kill(); } catch {} server = null; };

/** Chat con la IA local. Devuelve el texto de la respuesta. */
export async function chatLocal(system, user, { json = false, maxTokens = 4000, model, onProgress } = {}) {
  model ||= await currentLLMModel();
  const s = await startServer(model, onProgress);
  // El contexto tiene un límite: si la petición es enorme se recorta el centro del texto (se avisa al modelo)
  const maxChars = (CTX - maxTokens - 600) * 3.2;
  if (system.length + user.length > maxChars) {
    const keep = Math.max(2000, maxChars - system.length);
    user = user.slice(0, keep * 0.7) + '\n[…texto recortado por longitud…]\n' + user.slice(-keep * 0.3);
  }
  // Petición con node:http (sin límite de tiempo: en equipos sin gráfica la IA puede tardar más de 5 min, y fetch
  // cortaba la conexión con "fetch failed") y en streaming para mostrar el progreso.
  const body = JSON.stringify({ messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens, temperature: 0.5,
    stream: true, ...(json ? { response_format: { type: 'json_object' } } : {}) });
  const t0 = Date.now();
  onProgress?.({ stage: 'La IA local está leyendo la transcripción…', pct: 0 });
  try {
    return await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: s.port, path: '/v1/chat/completions', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
        res.setEncoding('utf8');
        let buf = '', text = '', raw = '', n = 0, lastSent = 0;
        res.on('data', chunk => {
          if (res.statusCode !== 200) { raw += chunk; return; }
          buf += chunk;
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (!line.startsWith('data:')) continue;
            const d = line.slice(5).trim();
            if (d === '[DONE]') continue;
            try {
              const j = JSON.parse(d);
              if (j.error) { req.destroy(new Error(j.error.message || JSON.stringify(j.error))); return; }
              const piece = j.choices?.[0]?.delta?.content || '';
              if (piece) { text += piece; n++; }
            } catch {}
          }
          if (n && Date.now() - lastSent > 3000) { lastSent = Date.now(); onProgress?.({ stage: `La IA local está escribiendo… ${Math.round(text.length / 5)} palabras (${Math.round((Date.now() - t0) / 60000)} min)`, pct: 0 }); }
        });
        res.on('end', () => res.statusCode === 200 ? resolve(text) : reject(new Error(`IA local (${res.statusCode}): ${raw.slice(0, 300)}`)));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(0);
      const kill = setTimeout(() => req.destroy(new Error('la IA local tardó más de 90 min')), 90 * 60 * 1000);
      req.on('close', () => clearTimeout(kill));
      req.end(body);
    });
  } catch (e) {
    // Si el proceso de la IA se cayó (p. ej. falta de memoria), se explica y se reinicia en el siguiente intento
    // el aviso de cierre del proceso puede llegar justo después del error de conexión
    for (let i = 0; i < 20 && s.proc.exitCode == null && !s.proc.killed; i++) await new Promise(r => setTimeout(r, 100));
    const dead = s.proc.exitCode != null || s.proc.killed;
    if (dead) { if (server === s) server = null;
      throw new Error('La IA local se cerró mientras trabajaba' + (/memory|alloc|oom/i.test(s.log()) ? ' por falta de memoria RAM (cierra otras apps o usa un vídeo más corto)' : '') + '. Pulsa Reintentar. Detalle: ' + s.log().split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300)); }
    throw new Error('Fallo de conexión con la IA local: ' + e.message + '. Pulsa Reintentar.');
  }
}

// ---------- Imágenes: stable-diffusion.cpp ----------
export async function imageLocal(prompt, opts = {}) {
  return imageRun(sdBinary(), prompt, opts);
}
async function imageRun(exe, prompt, { size = '1024x1536', steps, onProgress, model: wanted } = {}) {
  if (!exe) throw new Error('La generación de imágenes local solo está en la app de escritorio (falta stable-diffusion).');
  const id = LOCAL_MODELS[wanted]?.kind === 'image' ? wanted : await currentImageModel();
  const turbo = !!LOCAL_MODELS[id].turbo;
  steps = Number(steps || process.env.LOCAL_IMAGE_STEPS || (turbo ? 4 : 22));
  const model = await ensureModel(id, pct => onProgress?.(`Descargando el modelo de imágenes (solo la primera vez)… ${pct}%`));
  const [w0, h0] = String(size).split('x').map(Number);
  // SD 1.5 / SD-Turbo: ~0,4 / ~0,33 megapíxeles en múltiplos de 64 (después se escala al tamaño final)
  const ratio = (w0 || 1) / (h0 || 1), px = turbo ? 330000 : 400000;
  const w = Math.round(Math.sqrt(px * ratio) / 64) * 64, h = Math.round(Math.sqrt(px / ratio) / 64) * 64;
  const out = path.join(WORK_DIR, `sd_${crypto.randomBytes(5).toString('hex')}.png`);
  const neg = 'text, letters, words, watermark, logo, signature, blurry, lowres, deformed, extra fingers, bad anatomy, ugly';
  await new Promise((resolve, reject) => {
    // SD-Turbo: sin guía (cfg 1) y muestreo euler_a; el texto negativo no se usa con cfg 1
    const args = turbo ? ['-m', model, '-p', prompt.slice(0, 600), '-W', String(w), '-H', String(h), '--steps', String(steps), '--cfg-scale', '1', '--sampling-method', 'euler_a']
      : ['-m', model, '-p', prompt.slice(0, 900), '-n', neg, '-W', String(w), '-H', String(h), '--steps', String(steps), '--cfg-scale', '6.5', '--sampling-method', 'dpm++2m'];
    const p = spawn(exe, [...args, '-t', String(cpuThreads(16)), '-o', out], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let log = '';
    const on = d => { const s = String(d); log = (log + s).slice(-3000); const m = s.match(/(\d+)\/(\d+)\s*-/); if (m) onProgress?.(`Generando la imagen en tu equipo… ${Math.round(m[1] / m[2] * 100)}%`); };
    p.stdout.on('data', on); p.stderr.on('data', on);
    p.on('error', e => reject(new Error('No se pudo ejecutar stable-diffusion: ' + e.message)));
    p.on('close', code => code === 0 && fs.existsSync(out) ? resolve() : reject(new Error('La generación local de la imagen falló: ' + log.split('\n').filter(Boolean).slice(-2).join(' '))));
  });
  try { return fs.readFileSync(out); } finally { fs.rmSync(out, { force: true }); }
}
