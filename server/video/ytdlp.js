// yt-dlp con progreso real, vigilancia de bloqueos y ajustes para la app de escritorio:
// - usa el ffmpeg incluido para unir vídeo y audio (--ffmpeg-location)
// - YouTube necesita un motor de JavaScript (Deno/Node): en la app de escritorio se usa el Node de Electron
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { FFMPEG } from './ffmpeg.js';

const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';

/** Argumentos comunes: ffmpeg incluido y motor JS (si la app lo proporciona). */
export function baseArgs() {
  const a = ['--no-warnings', '--newline', '--no-playlist'];
  if (FFMPEG !== 'ffmpeg' && fs.existsSync(FFMPEG)) a.push('--ffmpeg-location', FFMPEG);
  if (process.env.YTDLP_JS_RUNTIME) a.push('--js-runtimes', process.env.YTDLP_JS_RUNTIME);
  return a;
}

/**
 * Ejecuta yt-dlp. Si pasa `stallMs` sin ninguna salida nueva, lo detiene con un error claro.
 * onLine recibe cada línea (stdout y stderr).
 */
export function ytdlp(args, { onLine = () => {}, stallMs = 180000, timeoutMs = 4 * 3600e3 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(YTDLP, [...baseArgs(), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', last = Date.now(), reason = null;
    const feed = (d, isErr) => {
      last = Date.now();
      const s = String(d);
      if (isErr) { err += s; if (err.length > 20000) err = err.slice(-10000); } else { out += s; if (out.length > 200000) out = out.slice(-100000); }
      for (const line of s.split(/\r?\n|\r/)) if (line.trim()) onLine(line.trim());
    };
    p.stdout.on('data', d => feed(d, false));
    p.stderr.on('data', d => feed(d, true));
    const started = Date.now();
    const watch = setInterval(() => {
      if (Date.now() - last > stallMs) reason = `yt-dlp no avanzó en ${Math.round(stallMs / 60000)} min`;
      else if (Date.now() - started > timeoutMs) reason = 'la descarga superó el tiempo máximo';
      if (reason) { clearInterval(watch); p.kill('SIGKILL'); }
    }, 5000);
    p.on('error', e => { clearInterval(watch); reject(new Error(`No se pudo ejecutar yt-dlp: ${e.message}`)); });
    p.on('close', code => {
      clearInterval(watch);
      if (code === 0 && !reason) return resolve({ out, err });
      const msg = (err.match(/ERROR:.*$/m)?.[0] || err.trim().split('\n').slice(-3).join(' ') || '').slice(0, 400);
      if (/not a bot|Sign in to confirm/i.test(msg)) return reject(new Error('YouTube pide verificar que no eres un bot. Prueba de nuevo más tarde o sube el archivo de vídeo. (' + msg + ')'));
      reject(new Error(reason ? `${reason}. ${msg}` : `yt-dlp falló: ${msg || 'código ' + code}`));
    });
  });
}

/** Descarga un vídeo (≤1080p, mp4) en `dir` con el prefijo `name`. onProgress(pct, texto). Devuelve la ruta del archivo. */
export async function downloadVideo(url, dir, name, onProgress = () => {}) {
  const tmpl = path.join(dir, `${name}.%(ext)s`);
  let lastPct = -1, phase = 0, lastSent = 0;
  await ytdlp(['-f', 'bv*[height<=1080]+ba/b[height<=1080]/b', '--merge-output-format', 'mp4', '-o', tmpl, url], {
    onLine: line => {
      if (/^\[download\] Destination:/.test(line) && lastPct >= 0) phase++; // segundo archivo (audio)
      const m = line.match(/^\[download\]\s+([\d.]+)%(?:\s+of\s+~?\s*([\d.]+\w+))?(?:.*?at\s+([\d.]+\w+\/s))?(?:.*?ETA\s+([\d:]+))?/);
      if (m) {
        lastPct = Number(m[1]);
        if (Date.now() - lastSent > 2000 || lastPct >= 100) {
          lastSent = Date.now();
          onProgress(lastPct, `Descargando ${phase ? 'audio' : 'vídeo'}… ${lastPct.toFixed(0)}%${m[2] ? ' de ' + m[2] : ''}${m[3] ? ' · ' + m[3] : ''}${m[4] ? ' · quedan ' + m[4] : ''}`);
        }
      } else if (/^\[Merger\]|^\[VideoConvertor\]|^\[FixupM3u8\]/.test(line)) onProgress(100, 'Uniendo vídeo y audio…');
      else if (/^\[(youtube|twitch|kick|generic)[^\]]*\]/i.test(line) && lastPct < 0) onProgress(0, 'Obteniendo el vídeo del enlace…');
    },
  });
  const f = fs.readdirSync(dir).find(n => n.startsWith(`${name}.`) && !/\.(part|ytdl|temp)$/.test(n) && !/\.f\d+\./.test(n));
  if (!f) throw new Error('yt-dlp no generó ningún archivo.');
  return path.join(dir, f);
}
