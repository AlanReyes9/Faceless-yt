import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { proxyArgs } from './netproxy.js';

const require = createRequire(import.meta.url);
let staticPath = null;
try { staticPath = require('ffmpeg-static'); } catch {}
export const FFMPEG = process.env.FFMPEG_PATH || staticPath || 'ffmpeg';
export const FONTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fonts');

export class TimeoutError extends Error {}

// El ffmpeg estático (glibc estática) se cuelga si carga los módulos iconv del sistema (p. ej. al leer
// MPEG-TS de directos o listas HLS). Con GCONV_PATH apuntando a una carpeta vacía no los carga.
import os from 'node:os';
import fs from 'node:fs';
const GCONV_EMPTY = path.join(os.tmpdir(), 'faceless-gconv-empty');
try { fs.mkdirSync(GCONV_EMPTY, { recursive: true }); } catch {}
const FF_ENV = { ...process.env, GCONV_PATH: GCONV_EMPTY };

/**
 * Ejecuta un proceso. timeoutMs: lo detiene a tiempo (antes de que el servidor corte la función).
 * onStdout recibe cada trozo de salida estándar (se usa para el progreso de ffmpeg).
 */
export async function run(cmd, args, { onStderr, onStdout, allowFail = false, timeoutMs } = {}) {
  // ffmpeg nunca se conecta a internet: las entradas remotas pasan por el proxy local (ver netproxy.js)
  if (cmd === FFMPEG) args = await proxyArgs(args);
  return new Promise((resolve, reject) => {
    if (timeoutMs !== undefined && timeoutMs <= 0) return reject(new TimeoutError('No queda tiempo en esta ejecución del servidor.'));
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...(cmd === FFMPEG || /ffprobe/.test(cmd) ? { env: FF_ENV } : {}) });
    let out = '', err = '', timedOut = false;
    const timer = timeoutMs > 0 && Number.isFinite(timeoutMs) ? setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, timeoutMs) : null;
    p.stdout.on('data', d => { if (onStdout) onStdout(String(d)); else { out += d; if (out.length > 200000) out = out.slice(-100000); } });
    p.stderr.on('data', d => { err += d; if (err.length > 40000) err = err.slice(-20000); onStderr?.(String(d)); });
    p.on('error', e => { clearTimeout(timer); reject(new Error(`No se pudo ejecutar ${cmd}: ${e.message}`)); });
    p.on('close', code => {
      clearTimeout(timer);
      if (timedOut) return reject(new TimeoutError('El render superó el tiempo límite del servidor.'));
      (code === 0 || allowFail) ? resolve({ out, err, code }) : reject(new Error(`${path.basename(cmd)} falló (código ${code}): ${err.slice(-1500)}`));
    });
  });
}

/**
 * ffmpeg con progreso opcional: onProgress(segundosProcesados) usando "-progress pipe:1".
 */
export function ffmpeg(args, { onProgress, ...opts } = {}) {
  const base = ['-hide_banner', '-loglevel', 'error', '-y'];
  if (!onProgress) return run(FFMPEG, [...base, ...args], opts);
  let buf = '';
  return run(FFMPEG, [...base, '-progress', 'pipe:1', '-nostats', ...args], {
    ...opts,
    onStdout: chunk => {
      buf += chunk;
      const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) {
        const m = l.match(/^out_time_(?:us|ms)=(\d+)/);
        if (m) onProgress(Number(m[1]) / 1e6);
      }
    },
  });
}

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
