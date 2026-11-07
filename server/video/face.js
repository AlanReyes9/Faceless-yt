// Detección de caras (UltraFace RFB-320, ONNX en WASM) y plan de reencuadre vertical que sigue a quien habla.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FFMPEG } from './ffmpeg.js';
import { localUrl } from './netproxy.js';

const require = createRequire(import.meta.url);
const MODEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'models', 'ultraface-rfb-320.onnx');
const IW = 320, IH = 240;

let sessionP = null;
async function session() {
  if (!sessionP) sessionP = (async () => {
    const ort = require('onnxruntime-web');
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = path.dirname(require.resolve('onnxruntime-web')) + path.sep;
    ort.env.logLevel = 'error';
    const s = await ort.InferenceSession.create(MODEL, { logSeverityLevel: 3, graphOptimizationLevel: 'all' });
    return { ort, s };
  })().catch(e => { sessionP = null; throw e; });
  return sessionP;
}

const iou = (a, b) => {
  const w = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)), h = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const i = w * h;
  return i / ((a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - i || 1);
};

/** Detecta caras en un fotograma RGB 320x240. Devuelve cajas normalizadas [0..1]. */
export async function detectFaces(rgb, threshold = 0.7) {
  const { ort, s } = await session();
  const data = new Float32Array(3 * IW * IH);
  for (let i = 0, n = IW * IH; i < n; i++) {
    data[i] = (rgb[i * 3] - 127) / 128;
    data[n + i] = (rgb[i * 3 + 1] - 127) / 128;
    data[2 * n + i] = (rgb[i * 3 + 2] - 127) / 128;
  }
  const out = await s.run({ input: new ort.Tensor('float32', data, [1, 3, IH, IW]) });
  const scores = out.scores.data, boxes = out.boxes.data;
  const cand = [];
  for (let i = 0; i < scores.length / 2; i++) {
    const sc = scores[i * 2 + 1];
    if (sc > threshold) cand.push({ x1: boxes[i * 4], y1: boxes[i * 4 + 1], x2: boxes[i * 4 + 2], y2: boxes[i * 4 + 3], score: sc });
  }
  cand.sort((a, b) => b.score - a.score);
  const keep = [];
  for (const c of cand) if (!keep.some(k => iou(k, c) > 0.3)) keep.push(c);
  return keep.filter(f => f.x2 - f.x1 > 0.02);
}

/**
 * Lee fotogramas reducidos de [start, start+dur].
 * keyOnly: solo fotogramas clave (muy rápido: no decodifica el resto). Devuelve [{t, img}].
 */
async function frames(input, start, dur, { fps = 2, keyOnly = false, timeoutMs } = {}) {
  input = await localUrl(input);
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', keyOnly ? 'info' : 'error',
      ...(keyOnly ? ['-skip_frame', 'nokey'] : []), '-ss', String(start), '-i', input, '-t', String(dur),
      '-vf', keyOnly ? `scale=${IW}:${IH},showinfo` : `fps=${fps},scale=${IW}:${IH}`,
      ...(keyOnly ? ['-fps_mode', 'passthrough'] : []), '-an', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'];
    const p = spawn(FFMPEG, args);
    const chunks = []; let err = '';
    const timer = timeoutMs ? setTimeout(() => p.kill('SIGKILL'), timeoutMs) : null;
    p.stdout.on('data', d => chunks.push(d));
    p.stderr.on('data', d => { err += d; if (err.length > 2e6) err = err.slice(-1e6); });
    p.on('error', reject);
    p.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('ffmpeg (caras): ' + err.slice(-500)));
      const buf = Buffer.concat(chunks), size = IW * IH * 3, list = [];
      const times = keyOnly ? [...err.matchAll(/pts_time:\s*([\d.]+)/g)].map(m => parseFloat(m[1])) : [];
      for (let o = 0, i = 0; o + size <= buf.length; o += size, i++) {
        list.push({ t: keyOnly ? Math.max(0, (times[i] ?? i) - (times[0] ?? 0)) : i / fps, img: buf.subarray(o, o + size) });
      }
      resolve(list);
    });
  });
}

/**
 * Analiza un tramo y devuelve muestras [{t, cx, cy, size}] (t relativo al inicio, coordenadas normalizadas)
 * eligiendo en cada instante a la persona principal (la cara más grande, con continuidad para no saltar).
 * onProgress(0..1). Primero intenta con fotogramas clave; si hay pocos, decodifica a 2 fps.
 */
export async function trackFaces(input, start, dur, { fps = 2, onProgress, timeoutMs } = {}) {
  let imgs = await frames(input, start, dur, { keyOnly: true, timeoutMs }).catch(() => []);
  if (imgs.length < Math.max(3, dur / 2.5)) imgs = await frames(input, start, dur, { fps, timeoutMs });
  const samples = [];
  let prev = null;
  for (let i = 0; i < imgs.length; i++) {
    const faces = await detectFaces(imgs[i].img);
    let pick = null;
    if (faces.length) {
      const area = f => (f.x2 - f.x1) * (f.y2 - f.y1);
      const biggest = faces.reduce((a, b) => area(b) > area(a) ? b : a);
      pick = biggest;
      if (prev) { // continuidad: seguir con la misma persona si sigue siendo relevante
        const near = faces.find(f => Math.abs((f.x1 + f.x2) / 2 - prev.cx) < 0.12 && area(f) > area(biggest) * 0.6);
        if (near) pick = near;
      }
    }
    const t = imgs[i].t;
    const smp = pick ? { t, cx: (pick.x1 + pick.x2) / 2, cy: (pick.y1 + pick.y2) / 2, size: pick.x2 - pick.x1 } : { t, cx: null };
    if (pick) prev = smp;
    samples.push(smp);
    if (i % 5 === 0) onProgress?.(i / imgs.length);
  }
  onProgress?.(1);
  return samples;
}

/**
 * Convierte las muestras en fotogramas clave de la ventana de recorte.
 * - zona muerta: no se mueve por pequeños cambios (evita temblores)
 * - cambios grandes (otra persona): corte seco
 * - cambios medios: desplazamiento suave de 0,6 s
 * Devuelve { cw, keys:[{t, x, cut}] } en píxeles de la fuente, o null si no hay caras.
 */
export function cropPlan(samples, W, H) {
  const cw = Math.min(W, Math.round((H * 9 / 16) / 2) * 2);
  if (cw >= W - 2) return null; // la fuente ya es vertical
  const found = samples.filter(s => s.cx != null);
  if (found.length < Math.max(1, samples.length * 0.25)) return null;
  // rellenar huecos con el último valor conocido y suavizar con mediana de 3
  let last = found[0].cx;
  const xs = samples.map(s => (last = s.cx ?? last));
  const med = xs.map((_, i) => [xs[i - 1] ?? xs[i], xs[i], xs[i + 1] ?? xs[i]].sort((a, b) => a - b)[1]);
  const toX = cx => Math.max(0, Math.min(W - cw, Math.round(cx * W - cw / 2)));
  const keys = [{ t: 0, x: toX(med[0]), cut: true }];
  let cur = med[0];
  for (let i = 1; i < med.length; i++) {
    const d = Math.abs(med[i] - cur);
    if (d < 0.07) continue;
    // confirmar que el cambio se mantiene (2 muestras) antes de moverse
    if (i + 1 < med.length && Math.abs(med[i + 1] - cur) < 0.07) continue;
    cur = med[i];
    keys.push({ t: samples[i].t, x: toX(cur), cut: d > 0.25 });
  }
  return { cw, keys };
}

/** Expresión de ffmpeg para la x del recorte a partir de los fotogramas clave. */
export function cropExpr(plan, ease = 0.6) {
  const { keys } = plan;
  let expr = String(keys[keys.length - 1].x);
  for (let i = keys.length - 1; i >= 1; i--) {
    const a = keys[i - 1], b = keys[i];
    // antes de b.t se mantiene a.x; si no es corte, transición suave entre b.t y b.t+ease
    const hold = `if(lt(t\\,${b.t.toFixed(2)})\\,${a.x}\\,`;
    const tail = b.cut ? expr : `if(lt(t\\,${(b.t + ease).toFixed(2)})\\,${a.x}+(${b.x - a.x})*(t-${b.t.toFixed(2)})/${ease}\\,${expr})`;
    expr = hold + tail + ')';
  }
  return expr;
}

/** Comprobación rápida de que el detector carga y se ejecuta (para diagnóstico). */
export async function faceSelfTest() {
  try { await detectFaces(new Uint8Array(IW * IH * 3)); return true; } catch (e) { console.warn('faceSelfTest', e.message); return false; }
}
