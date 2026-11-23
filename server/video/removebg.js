// Quitar el fondo de una foto (sin internet): modelo U²-Net (licencia Apache 2.0) con onnxruntime-web.
// Devuelve un PNG con fondo transparente del mismo tamaño que la foto original.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { run, FFMPEG } from './ffmpeg.js';

const require = createRequire(import.meta.url);
const MODELS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'models');
const S = 320; // entrada del modelo

let sessionP = null;
async function session() {
  if (!sessionP) sessionP = (async () => {
    const ort = require('onnxruntime-web');
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = path.dirname(require.resolve('onnxruntime-web')) + path.sep;
    ort.env.logLevel = 'error';
    // "silueta" (U²-Net reducido, mejor borde) si está; si no, "u2netp" (pequeño)
    const file = ['silueta.onnx', 'u2netp.onnx'].map(f => path.join(MODELS, f)).find(f => fs.existsSync(f));
    if (!file) throw new Error('Falta el modelo para quitar el fondo.');
    return { ort, s: await ort.InferenceSession.create(file, { logSeverityLevel: 3, graphOptimizationLevel: 'all' }) };
  })().catch(e => { sessionP = null; throw e; });
  return sessionP;
}

/** Lee una imagen como RGB crudo con ffmpeg (opcionalmente reescalada). */
async function readRGB(file, w, h) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, ...(w ? ['-vf', `scale=${w}:${h}`] : []), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
      { env: { ...process.env, GCONV_PATH: process.env.GCONV_PATH || '/nonexistent' } });
    const ch = []; p.stdout.on('data', d => ch.push(d)); p.on('error', reject);
    p.on('close', code => code === 0 ? resolve(Buffer.concat(ch)) : reject(new Error('No se pudo leer la imagen.')));
  });
}

/**
 * Quita el fondo de `input` y guarda un PNG transparente en `output`.
 * La máscara del modelo (320×320) se escala al tamaño de la foto con ffmpeg y se usa como canal alfa.
 */
export async function removeBackground(input, output) {
  const { err } = await run(FFMPEG, ['-hide_banner', '-i', input], { allowFail: true });
  const m = err.match(/Stream #.*Video:.*?,\s*(\d{2,5})x(\d{2,5})[\s,]/);
  if (!m) throw new Error('No se pudo leer la imagen.');
  const W = +m[1], H = +m[2];
  const { ort, s } = await session();
  // entrada: RGB normalizado como en U²-Net (media/desviación de ImageNet, escalado al máximo)
  const rgb = await readRGB(input, S, S);
  const n = S * S, data = new Float32Array(3 * n);
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  let max = 1; for (let i = 0; i < rgb.length; i++) if (rgb[i] > max) max = rgb[i];
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) data[c * n + i] = (rgb[i * 3 + c] / max - mean[c]) / std[c];
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', data, [1, 3, S, S]) });
  const pred = out[s.outputNames[0]].data;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) { if (pred[i] < lo) lo = pred[i]; if (pred[i] > hi) hi = pred[i]; }
  const mask = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    const v = (pred[i] - lo) / (hi - lo || 1);
    // borde más limpio: lo casi transparente fuera, lo casi opaco dentro
    mask[i] = Math.round(255 * Math.min(1, Math.max(0, (v - 0.12) / 0.76)));
  }
  const maskFile = output + '.mask.gray';
  fs.writeFileSync(maskFile, mask);
  try {
    // máscara escalada a la foto + suavizado ligero del borde → canal alfa
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input,
      '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${S}x${S}`, '-i', maskFile,
      '-filter_complex', `[1:v]scale=${W}:${H}:flags=bicubic,gblur=sigma=${Math.max(0.6, W / 900).toFixed(2)}[a];[0:v]format=rgba[c];[c][a]alphamerge`,
      '-frames:v', '1', output], { timeoutMs: 60000 });
  } finally { fs.rmSync(maskFile, { force: true }); }
  return output;
}
