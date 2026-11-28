// Efecto 2.5D (paralaje) para las imágenes de las historias: se calcula la profundidad de la imagen con una IA pequeña
// (Depth Anything V2 Small, licencia Apache 2.0, ~27 MB, sin internet tras la primera descarga) y se separa en dos capas:
// lo cercano (personaje) y el fondo. Al animar, la capa cercana se mueve más que el fondo → sensación de profundidad.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { FFMPEG, ffmpeg } from './ffmpeg.js';
import { modelsDir } from '../ai/localwhisper.js';
import { fetchRetry } from '../ai/localmodels.js';

const require = createRequire(import.meta.url);
const URLS = ['https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model_quantized.onnx',
  'https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model.onnx'];
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

let sessP = null;
async function session() {
  if (!sessP) sessP = (async () => {
    const ort = require('onnxruntime-web');
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = pathToFileURL(path.dirname(require.resolve('onnxruntime-web')) + path.sep).href;
    ort.env.logLevel = 'error';
    const dir = path.join(modelsDir(), 'depth'); fs.mkdirSync(dir, { recursive: true });
    let last;
    for (const url of URLS) {
      const file = path.join(dir, path.basename(url));
      try {
        if (!fs.existsSync(file)) {
          const r = await fetchRetry(url, { redirect: 'follow' });
          if (!r.ok) throw new Error(`descarga ${r.status}`);
          fs.writeFileSync(file + '.part', Buffer.from(await r.arrayBuffer())); fs.renameSync(file + '.part', file);
        }
        return { ort, s: await ort.InferenceSession.create(file, { logSeverityLevel: 3, graphOptimizationLevel: 'all' }) };
      } catch (e) { last = e; console.warn('[2.5D] modelo', path.basename(url), e.message); }
    }
    throw last;
  })().catch(e => { sessP = null; throw e; });
  return sessP;
}

const readRGB = (file, w, h) => new Promise((resolve, reject) => {
  const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', `scale=${w}:${h}:flags=bicubic`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
  const ch = []; p.stdout.on('data', d => ch.push(d)); p.on('error', reject);
  p.on('close', c => c === 0 ? resolve(Buffer.concat(ch)) : reject(new Error('No se pudo leer la imagen.')));
});

/** Mapa de profundidad (0 = lejos, 255 = cerca) de tamaño w×h (múltiplos de 14). */
export async function depthMap(file, w = 266, h = 476) {
  const { ort, s } = await session();
  const rgb = await readRGB(file, w, h);
  const n = w * h, data = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) data[c * n + i] = (rgb[i * 3 + c] / 255 - MEAN[c]) / STD[c];
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', data, [1, 3, h, w]) });
  const t = out[s.outputNames[0]], d = t.data;
  const [oh, ow] = t.dims.slice(-2);
  let lo = Infinity, hi = -Infinity;
  for (const v of d) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const g = Buffer.alloc(ow * oh);
  for (let i = 0; i < ow * oh; i++) g[i] = Math.round((d[i] - lo) / ((hi - lo) || 1) * 255);
  return { w: ow, h: oh, gray: g };
}

/**
 * Separa la imagen en dos capas: fondo (con el hueco del personaje relleno de forma suave) y primer plano con transparencia.
 * Devuelve { bg, fg } (rutas PNG) del tamaño W×H, o null si la imagen no tiene un primer plano claro.
 */
export async function makeLayers(img, dir, W, H) {
  const dm = await depthMap(img);
  // umbral: lo más cercano (~30-40 % de la imagen); si el primer plano es casi todo o casi nada, no hay paralaje claro
  const sorted = Buffer.from(dm.gray).sort();
  const thr = sorted[Math.floor(sorted.length * 0.62)];
  const mask = Buffer.alloc(dm.gray.length);
  let on = 0;
  for (let i = 0; i < mask.length; i++) if (dm.gray[i] > thr) { mask[i] = 255; on++; }
  const frac = on / mask.length;
  if (frac < 0.08 || frac > 0.7) return null;
  const pgm = path.join(dir, 'mask.pgm');
  fs.writeFileSync(pgm, Buffer.concat([Buffer.from(`P5\n${dm.w} ${dm.h}\n255\n`), mask]));
  const fg = path.join(dir, 'fg.png'), bg = path.join(dir, 'bg.png');
  // primer plano: imagen + máscara suavizada como transparencia
  await ffmpeg(['-i', img, '-i', pgm, '-filter_complex',
    `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},format=rgba[c];[1:v]scale=${W}:${H},format=gray,gblur=sigma=${Math.round(W / 270)}[m];[c][m]alphamerge`, '-frames:v', '1', fg]);
  // fondo: donde estaba el personaje se pone la imagen muy difuminada (al moverse no se ve el «doble»)
  await ffmpeg(['-i', img, '-i', pgm, '-filter_complex',
    `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},split[a][b];[b]gblur=sigma=${Math.round(W / 40)},format=rgba[bl];` +
    `[1:v]scale=${W}:${H},format=gray,gblur=sigma=${Math.round(W / 45)},lut=y='min(255,val*3)'[m];[bl][m]alphamerge[blm];[a][blm]overlay`, '-frames:v', '1', bg]);
  return { bg, fg };
}

/**
 * Filtro de ffmpeg para animar las dos capas durante `frames` fotogramas.
 * bgIn / fgIn: etiquetas de entrada (imágenes en bucle); mode 0-3 = acercar, alejar, desplazar a la derecha / izquierda.
 */
export function parallaxFilter({ bgIn, fgIn, W, H, frames, mode = 0, out = 'pv' }) {
  const W1 = Math.round(W * 1.2 / 2) * 2, H1 = Math.round(H * 1.2 / 2) * 2, N = Math.max(1, frames);
  const zb = ['1+0.04*on/N', '1.05-0.04*on/N', '1.03', '1.03'][mode % 4].replace(/N/g, N);
  const zf = ['1+0.13*on/N', '1.14-0.12*on/N', '1.06', '1.06'][mode % 4].replace(/N/g, N);
  const pan = (k, dir) => dir ? `+(${dir}*${k}*iw*(on/${N}-0.5))` : '';
  const dir = [0, 0, 1, -1][mode % 4];
  const zx = k => `'max(0,min(iw-iw/zoom,(iw-iw/zoom)/2${pan(k, dir)}))'`;
  const zy = `'(ih-ih/zoom)/2'`;
  return `${bgIn}scale=${W1}:${H1}:force_original_aspect_ratio=increase,crop=${W1}:${H1},zoompan=z='${zb}':x=${zx(0.03)}:y=${zy}:d=1:s=${W}x${H}:fps=30[pbg];` +
    `${fgIn}format=rgba,scale=${W1}:${H1}:force_original_aspect_ratio=increase,crop=${W1}:${H1},zoompan=z='${zf}':x=${zx(0.09)}:y=${zy}:d=1:s=${W}x${H}:fps=30,format=rgba[pfg];` +
    `[pbg][pfg]overlay=0:0:format=auto,format=yuv420p,setsar=1[${out}]`;
}
