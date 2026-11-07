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
      const entry = map.get(req.url.slice(1).split('?')[0]);
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
setInterval(() => { const lim = Date.now() - 6 * 3600e3; for (const [k, v] of map) if (v.at < lim) map.delete(k); }, 600000).unref();

/** Convierte una URL remota en una local servida por el proxy. Las rutas locales no cambian. */
export async function localUrl(input) {
  if (!/^https?:\/\//.test(input) || /^http:\/\/127\.0\.0\.1:/.test(input)) return input;
  await start();
  const id = crypto.randomBytes(9).toString('hex');
  map.set(id, { url: input, at: Date.now() });
  return `http://127.0.0.1:${port}/${id}`;
}

/** Reescribe los argumentos de ffmpeg: cada "-i <url remota>" pasa por el proxy local. */
export async function proxyArgs(args) {
  const out = [...args];
  for (let i = 0; i < out.length - 1; i++) if (out[i] === '-i') out[i + 1] = await localUrl(out[i + 1]);
  return out;
}
