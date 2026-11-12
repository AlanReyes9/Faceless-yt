// Grabador HLS en Node: descarga los segmentos de una lista .m3u8 en directo y los une en un archivo.
// Evita el lector HLS de ffmpeg (el binario estático falla con listas en directo) y permite continuar
// exactamente donde terminó la grabación anterior (sin huecos entre segmentos).
import fs from 'node:fs';
import crypto from 'node:crypto';

const UA = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36' };

async function get(url, type = 'text', timeoutMs = 20000) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status} al leer el directo`), { status: r.status });
      return type === 'text' ? { text: await r.text(), url: r.url || url } : Buffer.from(await r.arrayBuffer());
    } catch (e) { last = e; if (e.status === 404 || e.status === 403) break; await new Promise(r => setTimeout(r, 1000 * (i + 1))); }
  }
  throw last;
}

const attrs = s => Object.fromEntries([...s.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)].map(m => [m[1], m[2].replace(/^"|"$/g, '')]));

/** Lee una lista: si es maestra elige la mejor variante (≤ maxHeight) y su audio separado, si lo hay. */
export async function resolvePlaylist(url, maxHeight = 1080) {
  const { text, url: final } = await get(url);
  if (!text.includes('#EXT-X-STREAM-INF')) return { video: final, audio: null };
  const lines = text.split(/\r?\n/);
  const variants = [], media = [];
  lines.forEach((l, i) => {
    if (l.startsWith('#EXT-X-STREAM-INF:')) {
      const a = attrs(l.slice(18)); const uri = lines.slice(i + 1).find(x => x && !x.startsWith('#'));
      const h = Number((a.RESOLUTION || '').split('x')[1]) || 0;
      variants.push({ bw: Number(a.BANDWIDTH) || 0, h, audio: a.AUDIO, url: new URL(uri, final).href });
    } else if (l.startsWith('#EXT-X-MEDIA:')) {
      const a = attrs(l.slice(13)); if (a.TYPE === 'AUDIO' && a.URI) media.push({ group: a['GROUP-ID'], def: a.DEFAULT === 'YES', url: new URL(a.URI, final).href });
    }
  });
  if (!variants.length) throw new Error('La lista del directo no tiene variantes de vídeo.');
  const ok = variants.filter(v => !v.h || v.h <= maxHeight);
  const best = (ok.length ? ok : variants).sort((a, b) => b.h - a.h || b.bw - a.bw)[0];
  const aud = best.audio ? media.filter(m => m.group === best.audio).sort((a, b) => b.def - a.def)[0] : null;
  // Una lista maestra puede apuntar a otra maestra
  const inner = await resolvePlaylist(best.url, maxHeight);
  return { video: inner.video, audio: aud?.url || inner.audio };
}

/** Lee una lista de medios: segmentos con número de secuencia, duración, clave e inicialización (fMP4). */
async function readMedia(url) {
  const { text, url: final } = await get(url);
  const lines = text.split(/\r?\n/);
  let seq = 0, dur = 0, key = null, map = null, target = 6;
  const segs = [];
  for (const l of lines) {
    if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = Number(l.split(':')[1]) || 0;
    else if (l.startsWith('#EXT-X-TARGETDURATION:')) target = Number(l.split(':')[1]) || 6;
    else if (l.startsWith('#EXTINF:')) dur = parseFloat(l.slice(8)) || 0;
    else if (l.startsWith('#EXT-X-KEY:')) { const a = attrs(l.slice(11)); key = a.METHOD === 'NONE' ? null : { ...a, URI: a.URI && new URL(a.URI, final).href }; }
    else if (l.startsWith('#EXT-X-MAP:')) { const a = attrs(l.slice(11)); map = new URL(a.URI, final).href; }
    else if (l && !l.startsWith('#')) { segs.push({ seq, dur, url: new URL(l.trim(), final).href, key, map }); seq++; dur = 0; }
  }
  return { segs, ended: text.includes('#EXT-X-ENDLIST'), target };
}

const keyCache = new Map();
async function decrypt(buf, key, seq) {
  if (!key) return buf;
  if (key.METHOD !== 'AES-128') throw new Error('El directo usa cifrado/DRM (' + key.METHOD + '): no se puede grabar.');
  let k = keyCache.get(key.URI);
  if (!k) { k = await get(key.URI, 'buf'); keyCache.set(key.URI, k); }
  const iv = key.IV ? Buffer.from(key.IV.replace(/^0x/i, '').padStart(32, '0'), 'hex') : Buffer.from(seq.toString(16).padStart(32, '0'), 'hex');
  const d = crypto.createDecipheriv('aes-128-cbc', k, iv);
  return Buffer.concat([d.update(buf), d.final()]);
}

/**
 * Graba `seconds` segundos de una lista de medios en `out`.
 * Continúa desde `fromSeq` (exclusivo) si sigue disponible; si no, empieza cerca del final de la lista.
 * Devuelve { seconds, lastSeq, ended, gap }.
 */
export async function recordMedia(url, out, { seconds, fromSeq = null, deadline = Infinity, startBack = 3, onProgress = () => {} }) {
  const fd = fs.openSync(out, 'w');
  let got = 0, lastSeq = fromSeq, ended = false, gap = false, mapDone = null, idle = 0;
  try {
    while (got < seconds && Date.now() < deadline) {
      const pl = await readMedia(url);
      let todo;
      if (lastSeq == null) todo = pl.ended ? pl.segs : pl.segs.slice(-startBack);
      else {
        todo = pl.segs.filter(s => s.seq > lastSeq);
        if (todo.length && todo[0].seq > lastSeq + 1) gap = true; // se perdieron segmentos (la lista avanzó demasiado)
      }
      for (const s of todo) {
        if (got >= seconds || Date.now() >= deadline) break;
        if (s.map && s.map !== mapDone) { fs.writeSync(fd, await get(s.map, 'buf')); mapDone = s.map; }
        const buf = await decrypt(await get(s.url, 'buf', 30000), s.key, s.seq);
        fs.writeSync(fd, buf);
        got += s.dur; lastSeq = s.seq; idle = 0;
        onProgress(got);
      }
      if (got >= seconds) break;
      if (pl.ended && !pl.segs.some(s => s.seq > lastSeq)) { ended = true; break; }
      if (!todo.length && ++idle > Math.max(6, 60 / (pl.target / 2))) { ended = true; break; } // ~1 min sin segmentos nuevos: terminó
      await new Promise(r => setTimeout(r, Math.max(1000, pl.target * 500)));
    }
  } finally { fs.closeSync(fd); }
  return { seconds: got, lastSeq, ended, gap };
}
