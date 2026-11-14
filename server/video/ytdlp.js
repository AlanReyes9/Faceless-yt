// yt-dlp con progreso real, vigilancia de bloqueos y ajustes para la app de escritorio:
// - usa el ffmpeg incluido para unir vídeo y audio (--ffmpeg-location)
// - YouTube necesita un motor de JavaScript (Deno/Node): en la app de escritorio se usa el Node de Electron
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { FFMPEG, probe } from './ffmpeg.js';

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
  // Se prefiere H.264 + AAC hasta 1080p (lo lee cualquier ffmpeg); el vídeo y el audio van por separado y se unen
  await ytdlp(['-f', 'bv*+ba/b', '-S', 'res:1080,vcodec:h264,acodec:aac', '--merge-output-format', 'mp4', '-o', tmpl, url], {
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
  const file = path.join(dir, f);
  const info = await probe(file).catch(() => ({}));
  if (!info.hasVideo) {
    fs.rmSync(file, { force: true });
    throw new Error('Del enlace solo se pudo descargar el audio, sin imagen (YouTube no dio el vídeo). Pulsa Reintentar; si vuelve a pasar, descarga el vídeo y súbelo como archivo.');
  }
  return file;
}

/** Busca vídeos cortos de YouTube (Shorts y clips ≤ maxSec). Devuelve [{ id, url, title, channel, duration, views, thumb }]. */
export async function searchShorts(query, { n = 24, maxSec = 90 } = {}) {
  const q = String(query || '').trim().slice(0, 120);
  if (!q) return [];
  // A la vez: Shorts del hashtag (#gatosgraciosos) y búsqueda con el filtro "menos de 4 minutos" (sp=EgIYAQ==)
  const list = async args => { try { const { out } = await ytdlp(args, { stallMs: 60000, timeoutMs: 90000 }); return JSON.parse(out.slice(out.indexOf('{'))).entries || []; } catch { return []; } };
  const tag = q.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]/gu, '');
  const [a, b] = await Promise.all([
    tag ? list(['--flat-playlist', '-J', '--playlist-end', String(Math.min(60, n * 2)), `https://www.youtube.com/hashtag/${encodeURIComponent(tag)}/shorts`]) : [],
    list(['--flat-playlist', '-J', '--playlist-end', String(Math.min(90, n * 3)), `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=EgIYAQ%3D%3D`]),
  ]);
  const seen = new Set();
  const uniq = arr => arr.filter(e => e.id && e.ie_key !== 'YoutubeTab' && !seen.has(e.id) && seen.add(e.id));
  const shorts = uniq(a); // del hashtag: todos son Shorts (sin duración en la lista)
  const rest = uniq(b).filter(e => e.duration && e.duration <= 240).sort((x, y) => (x.duration > maxSec) - (y.duration > maxSec));
  const pick = [...shorts, ...rest].slice(0, n);
  if (!pick.length) throw new Error('No se encontraron vídeos (o YouTube no respondió). Prueba otras palabras.');
  return pick.map(e => ({ id: e.id, url: !e.duration || e.duration <= 180 ? `https://www.youtube.com/shorts/${e.id}` : `https://www.youtube.com/watch?v=${e.id}`,
    title: e.title || '', channel: e.channel || e.uploader || '', duration: e.duration || null, views: e.view_count || null,
    thumb: `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg` }));
}
