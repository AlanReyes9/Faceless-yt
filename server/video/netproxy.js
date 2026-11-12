// Proxy HTTP local para ffmpeg: ffmpeg lee http://127.0.0.1:<puerto>/<id> (sin TLS ni DNS)
// y Node descarga los trozos pedidos (Range) desde R2 / Blob / cualquier URL https.
// Evita los fallos de red de los binarios estáticos de ffmpeg (TLS/DNS) y funciona en cualquier servidor.
import http from 'node:http';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';

const map = new Map(); // id -> { url, at }
let served = 0;
/** Bytes descargados por el proxy (diagnóstico). */
export const proxyBytes = () => served;
let ready = null, port = 0;

function start() {
  return (ready ||= new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const entry = map.get(req.url.slice(1).split(/[/?]/)[0]);
      if (!entry) { res.writeHead(404).end(); return; }
      entry.at = Date.now();
      const ac = new AbortController();
      res.on('close', () => ac.abort());
      try {
        const isHead = req.method === 'HEAD';
        // HEAD con una URL firmada para GET no es válido en S3: se pide el primer byte y se responde con el tamaño
        const headers = {};
        if (isHead) headers.range = 'bytes=0-0';
        else if (req.headers.range) headers.range = req.headers.range;
        const r = await fetch(entry.url, { headers, signal: ac.signal });
        // Listas HLS (directos): se reescriben sus URLs para que cada segmento también pase por el proxy
        const ctype = r.headers.get('content-type') || '';
        if (!isHead && (/mpegurl/i.test(ctype) || /\.m3u8(\?|$)/i.test(entry.url)) && r.ok) {
          const text = await rewriteM3u8(await r.text(), r.url || entry.url);
          res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-cache' });
          return res.end(text);
        }
        const out = {};
        for (const h of ['content-type', 'last-modified', 'etag']) if (r.headers.get(h)) out[h] = r.headers.get(h);
        out['accept-ranges'] = 'bytes';
        if (isHead) {
          const total = (r.headers.get('content-range') || '').split('/')[1] || r.headers.get('content-length');
          if (total) out['content-length'] = total;
          res.writeHead(r.ok ? 200 : r.status, out).end();
          r.body?.cancel().catch(() => {});
          return;
        }
        for (const h of ['content-length', 'content-range']) if (r.headers.get(h)) out[h] = r.headers.get(h);
        res.writeHead(r.status, out);
        if (!r.body) return res.end();
        Readable.fromWeb(r.body).on('data', c => { served += c.length; }).on('error', () => res.destroy()).pipe(res);
      } catch (e) {
        if (!res.headersSent) res.writeHead(502).end(); else res.destroy();
      }
    });
    server.keepAliveTimeout = 60000;
    server.on('error', e => { ready = null; reject(e); });
    server.listen(0, '127.0.0.1', () => { port = server.address().port; server.unref(); resolve(); });
  }));
}

// Limpieza de entradas viejas (las URL firmadas duran horas; aquí basta con 6 h)
setInterval(() => { const lim = Date.now() - 6 * 3600e3; for (const [k, v] of map) if (v.at < lim) { map.delete(k); byUrl.delete(v.url); } }, 600000).unref();

const byUrl = new Map(); // url -> id (para no crear entradas nuevas en cada refresco de una lista en directo)

/** Convierte una URL remota en una local servida por el proxy. Las rutas locales no cambian. */
export async function localUrl(input) {
  if (!/^https?:\/\//.test(input) || /^http:\/\/127\.0\.0\.1:/.test(input)) return input;
  await start();
  let id = byUrl.get(input);
  if (!id || !map.has(id)) {
    id = crypto.randomBytes(9).toString('hex');
    map.set(id, { url: input, at: Date.now() });
    byUrl.set(input, id);
  }
  // se conserva el nombre del archivo (con su extensión): el lector HLS de ffmpeg rechaza segmentos sin extensión conocida
  let name = 'f';
  try { name = decodeURIComponent(new URL(input).pathname.split('/').pop() || 'f').replace(/[^\w.-]+/g, '_').slice(-80) || 'f'; } catch {}
  return `http://127.0.0.1:${port}/${id}/${name}`;
}

/** Reescribe una lista m3u8: segmentos, sublistas y claves pasan a URLs del proxy. */
async function rewriteM3u8(text, base) {
  const abs = u => { try { return new URL(u, base).href; } catch { return u; } };
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (line && !line.startsWith('#')) { out.push(await localUrl(abs(line.trim()))); continue; }
    const m = line.match(/URI="([^"]+)"/);
    out.push(m ? line.replace(m[0], `URI="${await localUrl(abs(m[1]))}"`) : line);
  }
  return out.join('\n');
}

/** Reescribe los argumentos de ffmpeg: cada "-i <url remota>" pasa por el proxy local. */
export async function proxyArgs(args) {
  const out = [...args];
  for (let i = 0; i < out.length - 1; i++) if (out[i] === '-i') out[i + 1] = await localUrl(out[i + 1]);
  return out;
}
