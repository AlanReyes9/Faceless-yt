// Plantilla "Gaming": la cámara del jugador (facecam) arriba y la partida abajo, recortada al centro con todo el alto.
// La facecam se localiza sola: la cara que aparece en el mismo sitio en casi todos los fotogramas (las caras del juego
// se mueven) y, a partir de ella, el recuadro de la cámara buscando sus bordes, que no cambian entre fotogramas.
import { spawn } from 'node:child_process';
import { FFMPEG } from './ffmpeg.js';
import { detectFaces } from './face.js';
import { localUrl } from './netproxy.js';

const FW = 640, FH = 360; // fotogramas de análisis

function grab(input, t) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, t)), '-i', input, '-frames:v', '1',
      '-vf', `scale=${FW}:${FH}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { env: { ...process.env, GCONV_PATH: process.env.GCONV_PATH || '/nonexistent' } });
    const ch = []; p.stdout.on('data', d => ch.push(d)); p.on('error', reject);
    p.on('close', () => { const b = Buffer.concat(ch); b.length >= FW * FH * 3 ? resolve(b) : reject(new Error('sin fotograma')); });
  });
}
const median = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

/**
 * Busca la facecam en un tramo del vídeo. Devuelve { x, y, w, h } normalizado (0–1) o null si no hay cámara fija.
 */
export async function detectFacecam(input, { from = 0, dur = 60, samples = 16 } = {}) {
  input = await localUrl(input);
  const frames = [], faces = [];
  for (let i = 0; i < samples; i++) {
    const t = from + dur * (i + 0.5) / samples;
    try {
      const rgb = await grab(input, t);
      frames.push(rgb);
      faces.push((await detectFaces(rgb, 0.6)).map(f => ({ cx: (f.x1 + f.x2) / 2, cy: (f.y1 + f.y2) / 2, w: f.x2 - f.x1, h: f.y2 - f.y1 })));
    } catch {}
  }
  if (frames.length < 4) return null;
  // Agrupar caras por posición: la facecam está siempre en el mismo sitio
  const clusters = [];
  faces.forEach((list, fi) => list.forEach(f => {
    const c = clusters.find(c => Math.hypot(c.cx - f.cx, (c.cy - f.cy) * FH / FW) < 0.06 && Math.abs(c.w - f.w) < Math.max(0.04, c.w * 0.5));
    if (c) { c.items.push(f); c.frames.add(fi); c.cx = median(c.items.map(x => x.cx)); c.cy = median(c.items.map(x => x.cy)); c.w = median(c.items.map(x => x.w)); }
    else clusters.push({ cx: f.cx, cy: f.cy, w: f.w, items: [f], frames: new Set([fi]) });
  }));
  const best = clusters.filter(c => c.frames.size >= Math.max(3, frames.length * 0.4)).sort((a, b) => b.frames.size - a.frames.size)[0];
  if (!best) return null;
  const fw = median(best.items.map(x => x.w)), fh = median(best.items.map(x => x.h));
  // Una cara que ocupa media pantalla no es una facecam: es un vídeo de cámara (mejor la plantilla "quien habla")
  if (fw > 0.3) return null;
  // Recuadro estimado de la cámara (cabeza y hombros) y ajuste a sus bordes reales
  const w = fw * 2.8, h = fh * 2.6;
  const x = best.cx - w / 2, y = best.cy - h * 0.42;
  const r = refine(frames, { x, y, w, h }, { x: best.cx - fw / 2, y: best.cy - fh / 2, w: fw, h: fh });
  return clampRect(r);
}

/** Ajusta el recuadro a los bordes más marcados y estables alrededor de la cara (los del marco de la cámara). */
function refine(frames, est, face) {
  // gradientes medios en el tiempo: los bordes del recuadro de la cámara no se mueven, el juego sí
  const gx = new Float32Array(FW * FH), gy = new Float32Array(FW * FH), mean = new Float32Array(FW * FH), dev = new Float32Array(FW * FH);
  const lum = (rgb, i) => rgb[i * 3] * 0.3 + rgb[i * 3 + 1] * 0.59 + rgb[i * 3 + 2] * 0.11;
  for (const rgb of frames) for (let i = 0; i < FW * FH; i++) mean[i] += lum(rgb, i) / frames.length;
  for (const rgb of frames) for (let i = 0; i < FW * FH; i += 1) dev[i] += Math.abs(lum(rgb, i) - mean[i]) / frames.length;
  for (const rgb of frames) {
    const g = i => rgb[i * 3] * 0.3 + rgb[i * 3 + 1] * 0.59 + rgb[i * 3 + 2] * 0.11;
    for (let yy = 1; yy < FH - 1; yy++) for (let xx = 1; xx < FW - 1; xx++) {
      const i = yy * FW + xx;
      gx[i] += Math.abs(g(i + 1) - g(i - 1)); gy[i] += Math.abs(g(i + FW) - g(i - FW));
    }
  }
  const n = frames.length, px = v => Math.round(v * FW), py = v => Math.round(v * FH);
  const fl = px(face.x), fr = px(face.x + face.w), ft = py(face.y), fb = py(face.y + face.h), fcx = (fl + fr) >> 1, fcy = (ft + fb) >> 1;
  const ew = px(est.w), eh = py(est.h);
  // Umbral de "borde fuerte" según el propio vídeo
  const all = []; for (let i = 0; i < gx.length; i += 37) all.push(gx[i] / n, gy[i] / n);
  const T = Math.max(18, median(all) * 4);
  // El marco de la cámara es una línea recta continua: se mide qué parte del tramo cubre (la cara solo da bordes cortos)
  const cy0 = Math.max(1, ft), cy1 = Math.min(FH - 2, fb), cx0 = Math.max(1, fl), cx1 = Math.min(FW - 2, fr); // dentro de la cámara seguro
  const colCov = x => { let k = 0; for (let yy = cy0; yy <= cy1; yy++) if (gx[yy * FW + x] / n > T) k++; return k / Math.max(1, cy1 - cy0 + 1); };
  const rowCov = y => { let k = 0; for (let xx = cx0; xx <= cx1; xx++) if (gy[y * FW + xx] / n > T) k++; return k / Math.max(1, cx1 - cx0 + 1); };
  // Cuánto se mueve la imagen a un lado y al otro del posible borde: el juego (fuera) cambia mucho, la habitación (dentro) poco
  const sideDev = (v, vertical, side) => {
    let s2 = 0, k = 0;
    for (let d = 2; d <= 7; d++) {
      const p = v + side * d;
      if (vertical ? (p < 0 || p >= FW) : (p < 0 || p >= FH)) continue;
      if (vertical) for (let yy = cy0; yy <= cy1; yy++) { s2 += dev[yy * FW + p]; k++; }
      else for (let xx = cx0; xx <= cx1; xx++) { s2 += dev[p * FW + xx]; k++; }
    }
    return k ? s2 / k : 0;
  };
  // inward: hacia dónde queda la cámara (+1 a la derecha/abajo, -1 a la izquierda/arriba)
  const pick = (from, to, fn, inward) => {
    const vertical = fn === colCov, lim = vertical ? FW - 2 : FH - 2;
    from = Math.max(1, from); to = Math.min(lim, to);
    let best = null;
    for (let v = from; v <= to; v++) {
      const c = fn(v); if (c < 0.6) continue;
      const din = sideDev(v, vertical, inward), dout = sideDev(v, vertical, -inward);
      const contrast = (dout - din) / (dout + din + 2);
      const score = c * contrast;
      if (contrast > 0.15 && (!best || score > best.score)) best = { v, score };
    }
    return best ? best.v : null;
  };
  const L = pick(fl - ew, fcx, colCov, 1), R = pick(fcx, fr + ew, colCov, -1);
  const Tp = pick(ft - eh, fcy, rowCov, 1), B = pick(fcy, fb + eh, rowCov, -1);
  let x = L != null ? L / FW : est.x, y = Tp != null ? Tp / FH : est.y;
  let r = (R != null ? R / FW : est.x + est.w), b = (B != null ? B / FH : est.y + est.h);
  // si un borde no se encontró, se mantiene la proporción a partir del opuesto
  if (L == null && R != null) x = r - est.w; if (R == null && L != null) r = x + est.w;
  if (Tp == null && B != null) y = b - est.h; if (B == null && Tp != null) b = y + est.h;
  return { x, y, w: r - x, h: b - y, edges: [L, R, Tp, B].filter(v => v != null).length };
}
const clampRect = r => {
  const x = Math.max(0, Math.min(0.98, r.x)), y = Math.max(0, Math.min(0.98, r.y));
  return { x, y, w: Math.max(0.05, Math.min(1 - x, r.w)), h: Math.max(0.05, Math.min(1 - y, r.h)) };
};

/**
 * Filtro de ffmpeg de la plantilla Gaming (vin → [base]): arriba la facecam (con fondo difuminado y esquinas
 * redondeadas) y abajo la partida escalada a todo el alto de su zona y recortada al centro.
 */
export function gamingFilter({ vin = '[0:v]', W, H, cam, OW = 1080, OH = 1920, ass, top = 0.355 }) {
  const TH = Math.round(OH * top / 2) * 2, GH = OH - TH;
  const game = `scale=${OW}:${GH}:force_original_aspect_ratio=increase,crop=${OW}:${GH},setsar=1`;
  if (!cam) return `${vin}${game},pad=${OW}:${OH}:0:${TH}:black,setsar=1${ass ? ',' + ass : ''}[base]`;
  const ev = v => Math.max(2, Math.round(v / 2) * 2);
  // se recorta un 2 % por cada lado para quitar el marco que suele llevar la cámara en el directo
  const ix = cam.w * 0.02, iy = cam.h * 0.02;
  const cw = ev((cam.w - 2 * ix) * W), ch = ev((cam.h - 2 * iy) * H), cx = Math.min(W - cw, ev((cam.x + ix) * W)), cy = Math.min(H - ch, ev((cam.y + iy) * H));
  // tamaño de la cámara: lo más grande posible dentro de la franja superior, con margen
  const pad = Math.round(TH * 0.07), maxW = OW - 2 * pad, maxH = TH - 2 * pad;
  const s = Math.min(maxW / cw, maxH / ch), fw = ev(cw * s), fh = ev(ch * s), R = Math.round(Math.min(fw, fh) * 0.06);
  const crop = `crop=${cw}:${ch}:${cx}:${cy}`;
  const round = `format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte(pow(max(0,max(${R}-X,X-(W-1-${R}))),2)+pow(max(0,max(${R}-Y,Y-(H-1-${R}))),2),${R * R}),255,0)'`;
  return `${vin}split=3[gm][c1][c2];` +
    `[gm]${game}[game];` +
    `[c1]${crop},scale=${OW / 4}:${TH / 4}:force_original_aspect_ratio=increase,crop=${OW / 4}:${TH / 4},boxblur=8:2,scale=${OW}:${TH},eq=brightness=-0.08:saturation=1.2[tbg];` +
    `[c2]${crop},scale=${fw}:${fh},${round}[cam];` +
    `[tbg][cam]overlay=(W-w)/2:(H-h)/2[top];` +
    `[top][game]vstack=inputs=2,setsar=1${ass ? ',' + ass : ''}[base]`;
}

/**
 * Pantalla dividida: el recuadro `a` del original arriba y el `b` abajo (cada uno llena su mitad, recortado al centro).
 * top = fracción de la altura para la parte de arriba (0.5 = mitad y mitad).
 */
export function splitFilter({ vin = '[0:v]', W, H, a, b, OW = 1080, OH = 1920, ass, top = 0.5 }) {
  const ev = v => Math.max(2, Math.round(v / 2) * 2);
  const TH = ev(OH * top), BH = OH - TH;
  const crop = r => { const cw = ev(r.w * W), ch = ev(r.h * H); return `crop=${Math.min(W, cw)}:${Math.min(H, ch)}:${Math.min(W - cw, ev(r.x * W))}:${Math.min(H - ch, ev(r.y * H))}`; };
  const fill = (w, h) => `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`;
  return `${vin}split=2[sa][sb];[sa]${crop(a)},${fill(OW, TH)}[st];[sb]${crop(b)},${fill(OW, BH)}[sbm];[st][sbm]vstack=inputs=2,setsar=1${ass ? ',' + ass : ''}[base]`;
}
