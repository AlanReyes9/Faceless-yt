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
    const smp = pick ? { t, n: faces.length, cx: (pick.x1 + pick.x2) / 2, cy: (pick.y1 + pick.y2) / 2, size: pick.x2 - pick.x1 } : { t, n: 0, cx: null };
    if (pick) prev = smp;
    samples.push(smp);
    if (i % 5 === 0) onProgress?.(i / imgs.length);
  }
  onProgress?.(1);
  return samples;
}

// ---------------------------------------------------------------------------
// Hablante activo: con varias personas en plano, se encuadra a la que está hablando.
// Se mide el movimiento de la boca de cada cara entre fotogramas consecutivos (restando el de la frente,
// para no confundirlo con movimientos de cabeza o de cámara) y solo cuenta mientras hay voz.
// ---------------------------------------------------------------------------
const AW = 640, AH = 360; // resolución de análisis (más detalle en la boca que 320x240)

/** Lee fotogramas AW×AH uno a uno (sin cargar el clip entero en memoria) y llama a onFrame(t, rgb). */
async function streamFrames(input, start, dur, fps, onFrame, timeoutMs) {
  input = await localUrl(input);
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', String(start), '-i', input, '-t', String(dur),
      '-vf', `fps=${fps},scale=${AW}:${AH}`, '-an', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
    const size = AW * AH * 3;
    let buf = Buffer.alloc(0), i = 0, err = '', chain = Promise.resolve(), failed = null;
    const timer = timeoutMs ? setTimeout(() => p.kill('SIGKILL'), timeoutMs) : null;
    p.stdout.on('data', d => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= size) {
        const frame = Buffer.from(buf.subarray(0, size)); buf = buf.subarray(size);
        const t = i++ / fps;
        p.stdout.pause();
        chain = chain.then(() => onFrame(t, frame)).catch(e => { failed = e; }).finally(() => p.stdout.resume());
      }
    });
    p.stderr.on('data', d => { err += d; if (err.length > 1e5) err = err.slice(-5e4); });
    p.on('error', reject);
    p.on('close', code => {
      clearTimeout(timer);
      chain.then(() => (code !== 0 && !i) ? reject(new Error('ffmpeg (hablante): ' + err.slice(-300))) : failed ? reject(failed) : resolve(i));
    });
  });
}

/** Reduce un fotograma AW×AH a 320×240 (vecino más cercano) para el detector. */
function toDetector(rgb) {
  const out = new Uint8Array(IW * IH * 3);
  for (let y = 0; y < IH; y++) {
    const sy = Math.floor(y * AH / IH) * AW;
    for (let x = 0; x < IW; x++) {
      const si = (sy + Math.floor(x * AW / IW)) * 3, di = (y * IW + x) * 3;
      out[di] = rgb[si]; out[di + 1] = rgb[si + 1]; out[di + 2] = rgb[si + 2];
    }
  }
  return out;
}
const toGray = rgb => { const g = new Uint8Array(AW * AH); for (let i = 0; i < g.length; i++) g[i] = (rgb[i * 3] * 77 + rgb[i * 3 + 1] * 150 + rgb[i * 3 + 2] * 29) >> 8; return g; };

/** Diferencia media de gris entre dos fotogramas dentro de un rectángulo normalizado. */
function regionDiff(a, b, x1, y1, x2, y2) {
  const X1 = Math.max(0, Math.floor(x1 * AW)), X2 = Math.min(AW, Math.ceil(x2 * AW));
  const Y1 = Math.max(0, Math.floor(y1 * AH)), Y2 = Math.min(AH, Math.ceil(y2 * AH));
  let sum = 0, n = 0;
  for (let y = Y1; y < Y2; y++) for (let x = X1; x < X2; x++) { const k = y * AW + x; sum += Math.abs(a[k] - b[k]); n++; }
  return n ? sum / n : 0;
}

/**
 * Sigue a todas las caras y decide quién habla en cada momento.
 * words: palabras con tiempos relativos al inicio del tramo (para saber cuándo hay voz).
 * Devuelve muestras [{t, cx, cy, size, speaker}] listas para cropPlan, o null si no hay suficiente información.
 */
export async function trackSpeakers(input, start, dur, { words = [], fps = 8, onProgress, timeoutMs } = {}) {
  const tracks = [];        // { id, cx, cy, w, h, x1, y1, x2, y2, seen, score: Map(segundo -> puntuación) }
  let prevGray = null, nextId = 1;
  const frames = [];        // por fotograma: { t, pos: Map(id -> {cx, cy, size}) }
  const total = Math.max(1, Math.round(dur * fps));
  const speaking = t => words.some(w => t >= w.start - 0.15 && t <= w.end + 0.15);

  await streamFrames(input, start, dur, fps, async (t, rgb) => {
    const gray = toGray(rgb);
    const faces = await detectFaces(toDetector(rgb), 0.65);
    const pos = new Map();
    const used = new Set();
    for (const f of faces) {
      const cx = (f.x1 + f.x2) / 2, cy = (f.y1 + f.y2) / 2, w = f.x2 - f.x1;
      // emparejar con la pista más cercana (misma persona en el fotograma anterior)
      let best = null, bd = Infinity;
      for (const tr of tracks) {
        if (used.has(tr.id) || t - tr.seen > 1.5) continue;
        const d = Math.hypot(tr.cx - cx, tr.cy - cy);
        if (d < Math.max(0.08, tr.w * 0.8) && d < bd) { bd = d; best = tr; }
      }
      const fresh = !best;
      const tr = best || { id: nextId++, score: new Map(), frames: 0 };
      if (fresh) tracks.push(tr);
      used.add(tr.id);
      const wasSeenLast = !fresh && t - tr.seen < 1.5 / fps + 0.01;
      Object.assign(tr, { cx, cy, w, x1: f.x1, y1: f.y1, x2: f.x2, y2: f.y2, seen: t });
      tr.frames++;
      pos.set(tr.id, { cx, cy, size: w });
      // movimiento de boca (parte baja de la cara) menos movimiento de frente (parte alta)
      if (prevGray && wasSeenLast && speaking(t)) {
        const h = f.y2 - f.y1, mx1 = cx - w * 0.28, mx2 = cx + w * 0.28;
        const mouth = regionDiff(prevGray, gray, mx1, f.y1 + h * 0.62, mx2, f.y1 + h * 0.95);
        const brow = regionDiff(prevGray, gray, mx1, f.y1 + h * 0.08, mx2, f.y1 + h * 0.30);
        const sc = Math.max(0, mouth - brow * 1.1);
        const sec = Math.floor(t);
        tr.score.set(sec, (tr.score.get(sec) || 0) + sc);
      }
    }
    prevGray = gray;
    frames.push({ t, pos });
    if (frames.length % 10 === 0) onProgress?.(Math.min(0.99, frames.length / total));
  }, timeoutMs);
  onProgress?.(1);

  if (process.env.DEBUG_SPEAKER) for (const tr of tracks) console.log("pista", tr.id, "cx", tr.cx.toFixed(2), "fotogramas", tr.frames, "boca/s:", [...Array(Math.ceil(dur)).keys()].map(s => (tr.score.get(s) || 0).toFixed(1)).join(" "));
  // Personas relevantes: presentes en al menos el 20 % del tramo
  const people = tracks.filter(tr => tr.frames >= frames.length * 0.2);
  if (!frames.length || !people.length) return null;
  if (people.length === 1) {
    const only = people[0].id;
    return frames.map(f => ({ t: f.t, ...(f.pos.get(only) || { cx: null }), speaker: only }));
  }

  // Decisión por segundos con histéresis: solo se cambia si la otra persona habla claramente más
  const secs = Math.ceil(dur);
  const totalScore = id => [...people.find(p => p.id === id).score.values()].reduce((a, b) => a + b, 0);
  let current = people.reduce((a, b) => totalScore(b.id) > totalScore(a.id) ? b : a).id; // quien más habla en general
  // empezar por quien habla en los primeros segundos, si hay señal
  const firstSecs = id => [0, 1, 2].reduce((a, s) => a + (people.find(p => p.id === id).score.get(s) || 0), 0);
  const opener = people.reduce((a, b) => firstSecs(b.id) > firstSecs(a.id) ? b : a);
  if (firstSecs(opener.id) > 0) current = opener.id;
  const speakerAt = new Array(secs).fill(current);
  let challenger = null, streak = 0;
  for (let sec = 0; sec < secs; sec++) {
    const sc = id => people.find(p => p.id === id).score.get(sec) || 0;
    const cur = sc(current);
    const top = people.reduce((a, b) => sc(b.id) > sc(a.id) ? b : a);
    const strong = sc(top.id) > Math.max(cur * 1.6, 1.5); // dominio claro y por encima del ruido
    if (top.id !== current && strong) {
      streak = challenger === top.id ? streak + 1 : 1;
      challenger = top.id;
      if (streak >= 2 || sc(top.id) > cur * 4 + 3) { current = top.id; challenger = null; streak = 0; }
    } else { challenger = null; streak = 0; }
    speakerAt[sec] = current;
  }
  // Muestras: posición de la persona elegida en cada fotograma (si no se ve, se mantiene la última)
  const lastPos = new Map();
  return frames.map(f => {
    for (const [id, pp] of f.pos) lastPos.set(id, pp);
    const id = speakerAt[Math.min(secs - 1, Math.floor(f.t))];
    const pp = f.pos.get(id) || lastPos.get(id);
    return pp ? { t: f.t, ...pp, speaker: id } : { t: f.t, cx: null, speaker: id };
  });
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
