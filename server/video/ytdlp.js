// yt-dlp con progreso real, vigilancia de bloqueos y ajustes para la app de escritorio:
// - usa el ffmpeg incluido para unir vídeo y audio (--ffmpeg-location)
// - YouTube necesita un motor de JavaScript (Deno/Node): en la app de escritorio se usa el Node de Electron
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { FFMPEG, probe } from './ffmpeg.js';
import { getSetting, setSettings } from '../settings.js';

// ---------- Cookies del navegador (YouTube a veces pide «verificar que no eres un bot») ----------
const HOME = os.homedir(), LAD = process.env.LOCALAPPDATA || '', AD = process.env.APPDATA || '';
const BROWSER_DIRS = process.platform === 'darwin' ? {
  chrome: `${HOME}/Library/Application Support/Google/Chrome`, safari: `${HOME}/Library/Containers/com.apple.Safari`,
  firefox: `${HOME}/Library/Application Support/Firefox`, edge: `${HOME}/Library/Application Support/Microsoft Edge`, brave: `${HOME}/Library/Application Support/BraveSoftware/Brave-Browser`,
} : process.platform === 'win32' ? {
  firefox: `${AD}\\Mozilla\\Firefox`, chrome: `${LAD}\\Google\\Chrome\\User Data`, edge: `${LAD}\\Microsoft\\Edge\\User Data`, brave: `${LAD}\\BraveSoftware\\Brave-Browser\\User Data`,
} : { chrome: `${HOME}/.config/google-chrome`, firefox: `${HOME}/.mozilla/firefox`, brave: `${HOME}/.config/BraveSoftware/Brave-Browser` };
// Safari guarda las cookies en una carpeta protegida de macOS: solo se usa si la app tiene permiso para leerla
const canRead = f => { try { fs.closeSync(fs.openSync(f, 'r')); return true; } catch { return false; } };
const installedBrowsers = () => Object.entries(BROWSER_DIRS).filter(([b, d]) => d && fs.existsSync(d) &&
  (b !== 'safari' || canRead(`${d}/Data/Library/Cookies/Cookies.binarycookies`))).map(([b]) => b);
const needsCookies = msg => /not a bot|Sign in to confirm|--cookies|cookies-from-browser|confirm your age|members-only|This video is private|login required/i.test(msg);
const BROWSER_NAMES = { chrome: 'Chrome', safari: 'Safari', firefox: 'Firefox', edge: 'Edge', brave: 'Brave' };


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
export async function ytdlp(args, opts = {}) {
  const mode = (process.env.YTDLP_NO_COOKIES ? 'no' : await getSetting('ytdlp_cookies').catch(() => 'auto')) || 'auto';
  const learned = mode === 'auto' ? await getSetting('ytdlp_cookies_learned').catch(() => '') : '';
  const first = mode !== 'auto' && mode !== 'no' ? mode : learned || null;
  try {
    return await ytdlpOnce(first ? ['--cookies-from-browser', first, ...args] : args, opts);
  } catch (e) {
    if (e.cancelled) throw e;
    const raw = e.raw || e.message;
    // No se pudieron LEER las cookies de ese navegador (permiso de macOS, llavero, navegador abierto…)
    if (first && cookieAccessErr(raw)) {
      if (mode !== 'auto') throw browserHelp(first, raw);
      await setSettings({ ytdlp_cookies_learned: '' }).catch(() => {});
      return ytdlpAuto(args, opts, { skip: [first], failed: { [first]: raw } });
    }
    if (mode !== 'auto' || !needsCookies(raw)) throw cookieHelp(e, mode, first);
    return ytdlpAuto(args, opts, { skip: first ? [first] : [], triedPlain: !first, botErr: e });
  }
}
/** Automático: sin cookies (si no se probó) y después con las cookies de cada navegador que se pueda leer. */
async function ytdlpAuto(args, opts, { skip = [], triedPlain = false, botErr = null, failed = {} }) {
  if (!triedPlain) {
    try { return await ytdlpOnce(args, opts); }
    catch (e) { if (e.cancelled) throw e; if (!needsCookies(e.raw || e.message)) throw e; botErr = e; }
  }
  for (const b of installedBrowsers().filter(x => !skip.includes(x))) {
    opts.onLine?.(`YouTube pide verificación: probando con las cookies de ${BROWSER_NAMES[b]}…`);
    try {
      const r = await ytdlpOnce(['--cookies-from-browser', b, ...args], opts);
      await setSettings({ ytdlp_cookies_learned: b }).catch(() => {});
      console.log(`[yt-dlp] funcionó con las cookies de ${b}: se usarán a partir de ahora`);
      return r;
    } catch (e2) { if (e2.cancelled) throw e2; failed[b] = String(e2.raw || e2.message); console.warn(`[yt-dlp] cookies de ${b}: ${failed[b].slice(0, 160)}`); }
  }
  throw cookieHelp(botErr || Object.assign(new Error('Sign in to confirm you’re not a bot'), { raw: 'Sign in to confirm you’re not a bot' }), 'auto', null, failed);
}
const cookieAccessErr = msg => /Operation not permitted|Permission denied|could not find .*cookies|cookies database|failed to (decrypt|read|find)|keyring|keychain|Secret ?Storage|Safe Storage|unsupported browser|database is locked/i.test(msg);
/** Qué hacer cuando no se pueden leer las cookies de un navegador concreto. */
function browserHelp(b, raw) {
  const name = BROWSER_NAMES[b] || b;
  const how = b === 'safari' ? 'macOS no deja leer las cookies de Safari sin permiso: ve a Ajustes del Sistema → Privacidad y seguridad → Acceso total al disco, activa «Clippers Pro» y vuelve a abrir la app. O, más fácil, elige Chrome o Firefox en Ajustes → «Cookies del navegador para YouTube».'
    : b === 'chrome' || b === 'brave' || b === 'edge' ? (process.platform === 'darwin' ? `Cuando macOS pida la contraseña para «${name} Safe Storage», escríbela y pulsa «Permitir siempre».` : `Cierra ${name} del todo y vuelve a intentarlo (con ${name} abierto no se pueden leer sus cookies).`)
    : 'Abre ese navegador, inicia sesión en YouTube y vuelve a intentarlo.';
  return Object.assign(new Error(`No se pudieron leer las cookies de ${name}. ${how}`), { raw });
}
/** Mensaje claro cuando YouTube exige iniciar sesión / verificar que no eres un bot. */
function cookieHelp(e, mode, used, failed = {}) {
  if (!needsCookies(e.raw || e.message)) return e;
  const notes = Object.entries(failed).filter(([, m]) => cookieAccessErr(m)).map(([b]) => b === 'safari' ? 'Safari necesita «Acceso total al disco» para Clippers Pro (Ajustes del Sistema → Privacidad y seguridad)' : `no se pudieron leer las cookies de ${BROWSER_NAMES[b] || b}`);
  const list = installedBrowsers().map(b => BROWSER_NAMES[b]).join(', ') || 'ninguno encontrado';
  return Object.assign(new Error(`YouTube pide verificar que no eres un bot. Abre YouTube en tu navegador (${list}) con tu sesión iniciada y vuelve a intentarlo` +
    `${mode === 'no' ? '; activa también «Cookies del navegador para YouTube» en Ajustes' : used ? ` (se usaron las cookies de ${BROWSER_NAMES[used] || used})` : ''}.` +
    `${notes.length ? ' Problemas: ' + notes.join('; ') + '.' : ''}` +
    `${process.platform === 'darwin' ? ' Con Chrome, macOS puede pedir tu contraseña para leer sus cookies: acéptalo. Safari necesita dar «Acceso total al disco» a Clippers Pro.' : process.platform === 'win32' ? ' En Windows, Chrome debe estar cerrado para leer sus cookies (Firefox funciona aunque esté abierto).' : ''}`), { raw: e.raw || e.message });
}

function ytdlpOnce(args, { onLine = () => {}, stallMs = 180000, timeoutMs = 4 * 3600e3, signal, fullOutput = false } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(YTDLP, [...baseArgs(), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', last = Date.now(), reason = null;
    const feed = (d, isErr) => {
      last = Date.now();
      const s = String(d);
      if (isErr) { err += s; if (err.length > 20000) err = err.slice(-10000); } else { out += s; if (!fullOutput && out.length > 200000) out = out.slice(-100000); } // con -J se necesita el JSON completo (puede pasar de 1 MB)
      if (!fullOutput || isErr) for (const line of s.split(/\r?\n|\r/)) if (line.trim()) onLine(line.trim());
    };
    if (signal) { if (signal.aborted) p.kill('SIGKILL'); signal.addEventListener('abort', () => { reason = 'cancelado'; p.kill('SIGKILL'); }, { once: true }); }
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
      if (reason === 'cancelado') return reject(Object.assign(new Error('Descarga cancelada.'), { cancelled: true }));
      const msg = (err.match(/ERROR:.*$/m)?.[0] || err.trim().split('\n').slice(-3).join(' ') || '').slice(0, 400);
      if (/not a bot|Sign in to confirm/i.test(msg)) return reject(Object.assign(new Error('YouTube pide verificar que no eres un bot. (' + msg + ')'), { raw: msg }));
      reject(Object.assign(new Error(reason ? `${reason}. ${msg}` : `yt-dlp falló: ${msg || 'código ' + code}`), { raw: msg }));
    });
  });
}

const MB = b => b / 1048576;
const toBytes = (n, u) => Number(n) * ({ B: 1, KIB: 1024, KB: 1000, MIB: 1048576, MB: 1e6, GIB: 1073741824, GB: 1e9 }[String(u).toUpperCase()] || 1);
const hms = t => { const [h, m, s] = String(t).split(':').map(Number); return h * 3600 + m * 60 + (s || 0); };

/** JSON de yt-dlp -J: la línea que empieza por '{' (ignora cualquier otra salida). */
export function parseOut(out) {
  const line = out.split(/\r?\n/).filter(l => l.trimStart().startsWith('{')).sort((a, b) => b.length - a.length)[0];
  if (!line) throw new Error('yt-dlp no devolvió la información del vídeo.');
  return JSON.parse(line);
}

/** Información de un enlace antes de descargar: título, canal, duración y tamaño aproximado por calidad. */
export async function linkInfo(url) {
  const { out } = await ytdlp(['-J', url], { stallMs: 60000, timeoutMs: 120000, fullOutput: true });
  const j = parseOut(out);
  const dur = j.duration || 0;
  const fmts = j.formats || [];
  const size = f => f.filesize || f.filesize_approx || (f.tbr && dur ? f.tbr * 1000 / 8 * dur : 0);
  const audio = fmts.filter(f => f.vcodec === 'none' && f.acodec !== 'none').sort((a, b) => size(b) - size(a))[0];
  const heights = [...new Set(fmts.filter(f => f.height && f.vcodec !== 'none').map(f => f.height))].filter(h => h >= 240).sort((a, b) => a - b);
  const pick = [240, 360, 480, 720, 1080, 1440, 2160].filter(h => heights.some(x => x >= h * 0.9 && x <= h * 1.1) || h === Math.max(...heights));
  const qualities = pick.map(h => {
    const vids = fmts.filter(f => f.height && f.height <= h * 1.1 && f.height >= h * 0.9 && f.vcodec !== 'none');
    const best = vids.sort((a, b) => (/avc|h264/.test(b.vcodec || '') - /avc|h264/.test(a.vcodec || '')) || size(b) - size(a))[0];
    const bytes = best ? size(best) + (best.acodec === 'none' && audio ? size(audio) : 0) : 0;
    return { height: h, label: `${h}p`, mb: bytes ? Math.round(MB(bytes)) : null };
  }).filter(q => q.height <= 1080 || pick.length === 1);
  return {
    title: j.title || '', channel: j.channel || j.uploader || '', platform: j.extractor_key || j.extractor || '', duration: dur,
    thumbnail: j.thumbnail || null, live: j.live_status === 'is_live', webpage: j.webpage_url || url,
    qualities: qualities.length ? qualities : [{ height: 720, label: '720p', mb: null }],
  };
}

/**
 * Descarga un vídeo (mp4, H.264 + AAC) en `dir` con el prefijo `name`.
 * opts: { height (calidad máx.), from, to (segundos: solo un tramo), estMB (tamaño estimado), signal (cancelar) }
 * onProgress(pct, texto, { gotMB, totalMB, speed }). Devuelve la ruta del archivo.
 */
export async function downloadVideo(url, dir, name, onProgress = () => {}, opts = {}) {
  const tmpl = path.join(dir, `${name}.%(ext)s`);
  const H = Number(opts.height) || 1080;
  const section = opts.to > (opts.from || 0) ? [Math.max(0, opts.from || 0), opts.to] : null;
  const secDur = section ? section[1] - section[0] : 0;
  let lastPct = -1, phase = 0, lastSent = 0, doneMB = 0;
  const send = (pct, text, extra, force) => { if (force || Date.now() - lastSent > 1500) { lastSent = Date.now(); onProgress(pct, text, extra); } };
  const args = ['-f', `bv*[height<=${H}]+ba/b[height<=${H}]/bv*+ba/b`, '-S', `res:${H},vcodec:h264,acodec:aac`, '--merge-output-format', 'mp4', '-o', tmpl,
    // Más rápido: 8 fragmentos a la vez (YouTube DASH, Twitch, Kick) y trozos de 10 MB (evita la limitación de velocidad de YouTube)
    '-N', '8', '--http-chunk-size', '10M'];
  if (section) args.push('--download-sections', `*${section[0]}-${section[1]}`);
  await ytdlp([...args, url], {
    signal: opts.signal,
    onLine: line => {
      if (/^\[download\] Destination:/.test(line) && lastPct >= 0) phase++; // segundo archivo (audio)
      const m = line.match(/^\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+)(\w+)(?:.*?at\s+([\d.]+\w+\/s))?(?:.*?ETA\s+([\d:]+))?/);
      if (m) {
        lastPct = Number(m[1]);
        const total = MB(toBytes(m[2], m[3])), got = total * lastPct / 100;
        if (lastPct >= 100) doneMB = Math.max(doneMB, phase ? doneMB : total);
        const g = (phase ? doneMB : 0) + got, tt = (phase ? doneMB : 0) + total;
        send(phase ? 90 + lastPct * 0.1 : lastPct * 0.9, `Descargando ${phase ? 'audio' : 'vídeo'}… ${g.toFixed(0)} MB de ~${tt.toFixed(0)} MB${m[4] ? ' · ' + m[4].replace('iB', 'B') : ''}${m[5] ? ' · quedan ' + m[5] : ''}`,
          { gotMB: g, totalMB: opts.estMB || tt, speed: m[4] || '' }, lastPct >= 100);
        return;
      }
      // Tramo: yt-dlp descarga con ffmpeg (progreso por tiempo descargado)
      const f = section && line.match(/size=\s*([\d.]+)\s*([kKmMgG]i?B).*?time=\s*([\d:.]+).*?(?:speed=\s*([\d.]+x))?/);
      if (f) {
        const sec = hms(f[3]), got = MB(toBytes(f[1], f[2]));
        const pct = Math.min(99, sec / secDur * 100);
        const total = pct > 3 ? got / (pct / 100) : (opts.estMB || 0);
        send(pct, `Descargando el tramo… ${got.toFixed(0)} MB de ~${(total || 0).toFixed(0)} MB${f[4] ? ' · ' + f[4] : ''}`, { gotMB: got, totalMB: total, speed: f[4] || '' });
        return;
      }
      if (/^\[Merger\]|^\[VideoConvertor\]|^\[FixupM3u8\]/.test(line)) send(100, 'Uniendo vídeo y audio…', null, true);
      else if (/^\[(youtube|twitch|kick|generic|tiktok|instagram)[^\]]*\]/i.test(line) && lastPct < 0) send(0, 'Obteniendo el vídeo del enlace…', null);
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
  const list = async args => { try { const { out } = await ytdlp(args, { stallMs: 60000, timeoutMs: 90000, fullOutput: true }); return parseOut(out).entries || []; } catch { return []; } };
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
