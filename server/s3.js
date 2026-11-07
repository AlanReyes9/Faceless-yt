// Cliente mínimo para almacenamiento compatible con S3 (Cloudflare R2, Backblaze B2, MinIO, AWS S3…).
// Firma AWS SigV4 con URLs prefirmadas, sin dependencias externas.
import crypto from 'node:crypto';

const env = k => process.env[k] || '';
export const S3 = {
  endpoint: env('S3_ENDPOINT').replace(/\/+$/, ''),      // p. ej. https://<cuenta>.r2.cloudflarestorage.com
  bucket: env('S3_BUCKET'),
  accessKeyId: env('S3_ACCESS_KEY_ID'),
  secretAccessKey: env('S3_SECRET_ACCESS_KEY'),
  region: env('S3_REGION') || 'auto',                     // R2 usa "auto"; B2 usa la región del endpoint (us-west-004…)
};
export const s3Configured = () => !!(S3.endpoint && S3.bucket && S3.accessKeyId && S3.secretAccessKey);

const hmac = (key, s) => crypto.createHmac('sha256', key).update(s).digest();
const sha256hex = s => crypto.createHash('sha256').update(s).digest('hex');
// Codificación estricta RFC 3986 que exige SigV4
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const encKey = key => key.split('/').map(enc).join('/');

/**
 * URL prefirmada para GET / PUT / DELETE / HEAD de un objeto. Válida `expires` segundos (máx. 7 días).
 * Estilo "path" (endpoint/bucket/clave), compatible con R2, B2 y MinIO.
 */
export function presign(method, key, { expires = 21600, query = {}, now = new Date() } = {}) {
  const url = new URL(S3.endpoint);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');   // 20261107T120000Z
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${S3.region}/s3/aws4_request`;
  const path = `${url.pathname.replace(/\/$/, '')}/${enc(S3.bucket)}/${encKey(key)}`;
  const params = {
    ...query,
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${S3.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(Math.min(604800, expires)),
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalQuery = Object.keys(params).sort().map(k => `${enc(k)}=${enc(params[k])}`).join('&');
  const canonicalRequest = [method, path, canonicalQuery, `host:${url.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const kDate = hmac('AWS4' + S3.secretAccessKey, day);
  const kSigning = hmac(hmac(hmac(kDate, S3.region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return `${url.protocol}//${url.host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

async function check(r, what) {
  if (r.ok) return r;
  const text = await r.text().catch(() => '');
  const msg = text.match(/<Message>([^<]+)<\/Message>/)?.[1] || text.slice(0, 200);
  throw new Error(`Almacenamiento S3 (${what}, ${r.status}): ${msg}`);
}

/** Sube un objeto (Buffer o stream con tamaño conocido). */
export async function putObject(key, body, { contentType = 'application/octet-stream', size } = {}) {
  const headers = { 'content-type': contentType };
  if (size != null) headers['content-length'] = String(size);
  const r = await fetch(presign('PUT', key, { expires: 3600 }), { method: 'PUT', headers, body, duplex: 'half' });
  await check(r, 'subir');
}
export async function deleteObject(key) {
  const r = await fetch(presign('DELETE', key, { expires: 600 }), { method: 'DELETE' });
  if (r.status !== 404) await check(r, 'borrar');
}
export async function headObject(key) {
  const r = await fetch(presign('HEAD', key, { expires: 600 }), { method: 'HEAD' });
  await check(r, 'consultar');
  return { size: Number(r.headers.get('content-length')) || 0, type: r.headers.get('content-type') };
}

/**
 * Configura CORS del bucket para que el navegador pueda subir y reproducir vídeos desde `origins`.
 * Requiere un token con permisos de administración del bucket; si no, se hace a mano en el panel.
 */
export async function putBucketCors(origins) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><CORSConfiguration><CORSRule>${origins.map(o => `<AllowedOrigin>${o}</AllowedOrigin>`).join('')}` +
    '<AllowedMethod>GET</AllowedMethod><AllowedMethod>PUT</AllowedMethod><AllowedMethod>HEAD</AllowedMethod>' +
    '<AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><ExposeHeader>Content-Length</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds></CORSRule></CORSConfiguration>';
  // La configuración del bucket va en /bucket?cors (clave vacía)
  const url = new URL(S3.endpoint);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${S3.region}/s3/aws4_request`;
  const path = `${url.pathname.replace(/\/$/, '')}/${enc(S3.bucket)}`;
  const md5 = crypto.createHash('md5').update(xml).digest('base64');
  const payloadHash = sha256hex(xml);
  const headers = { host: url.host, 'content-md5': md5, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const signed = Object.keys(headers).sort();
  const canonicalRequest = ['PUT', path, 'cors=', signed.map(h => `${h}:${headers[h]}\n`).join(''), signed.join(';'), payloadHash].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + S3.secretAccessKey, day), S3.region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  const { host, ...send } = headers;
  const r = await fetch(`${url.protocol}//${url.host}${path}?cors=`, {
    method: 'PUT', body: xml,
    headers: { ...send, 'content-type': 'application/xml', authorization: `AWS4-HMAC-SHA256 Credential=${S3.accessKeyId}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}` },
  });
  await check(r, 'configurar CORS');
}
