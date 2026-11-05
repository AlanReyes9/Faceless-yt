import { spawn } from 'node:child_process';

export function run(cmd, args, { onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; if (err.length > 20000) err = err.slice(-10000); onStderr?.(String(d)); });
    p.on('error', e => reject(new Error(`No se pudo ejecutar ${cmd}: ${e.message}`)));
    p.on('close', code => code === 0 ? resolve(out) : reject(new Error(`${cmd} falló (código ${code}): ${err.slice(-1500)}`)));
  });
}

export const ffmpeg = (args, opts) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], opts);

export async function probe(file) {
  const out = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const j = JSON.parse(out);
  const v = j.streams.find(s => s.codec_type === 'video');
  return {
    duration: parseFloat(j.format.duration) || 0,
    width: v?.width || 0, height: v?.height || 0,
    hasAudio: j.streams.some(s => s.codec_type === 'audio'),
  };
}

/** Escapa una ruta para usarla dentro de un filtro de ffmpeg (subtitles=..., ass=...). */
export function filterPath(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}
