import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let staticPath = null;
try { staticPath = require('ffmpeg-static'); } catch {}
export const FFMPEG = process.env.FFMPEG_PATH || staticPath || 'ffmpeg';
export const FONTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fonts');

export function run(cmd, args, { onStderr, allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; if (err.length > 40000) err = err.slice(-20000); onStderr?.(String(d)); });
    p.on('error', e => reject(new Error(`No se pudo ejecutar ${cmd}: ${e.message}`)));
    p.on('close', code => (code === 0 || allowFail) ? resolve({ out, err, code }) : reject(new Error(`${path.basename(cmd)} falló (código ${code}): ${err.slice(-1500)}`)));
  });
}

export const ffmpeg = (args, opts) => run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], opts);

/** Duración, tamaño y audio leyendo la salida de "ffmpeg -i" (no necesita ffprobe). Acepta URLs. */
export async function probe(input) {
  const { err } = await run(FFMPEG, ['-hide_banner', '-i', input], { allowFail: true });
  const d = err.match(/Duration: (\d+):(\d+):([\d.]+)/);
  const v = err.match(/Stream #.*Video:.*?,\s*(\d{2,5})x(\d{2,5})[\s,]/);
  if (!d && !v) throw new Error('No se pudo leer el archivo de vídeo/audio. ' + (err.split('\n').find(l => /error|Invalid|No such/i.test(l)) || ''));
  return {
    duration: d ? (+d[1]) * 3600 + (+d[2]) * 60 + parseFloat(d[3]) : 0,
    width: v ? +v[1] : 0, height: v ? +v[2] : 0,
    hasAudio: /Stream #.*Audio:/.test(err),
  };
}

/** Escapa una ruta para usarla dentro de un filtro de ffmpeg. */
export function filterPath(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}
/** Filtro de subtítulos ASS con las fuentes incluidas en el proyecto. */
export const assFilter = file => `ass='${filterPath(file)}':fontsdir='${filterPath(FONTS_DIR)}'`;
