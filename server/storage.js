// Almacenamiento de archivos. Por orden de preferencia:
//  1. S3 compatible (Cloudflare R2, Backblaze B2…) si hay S3_ENDPOINT/S3_BUCKET/claves  → refs "s3:<clave>"
//  2. Vercel Blob si hay BLOB_READ_WRITE_TOKEN                                          → refs "https://…"
//  3. Disco local (./data/files)                                                         → refs "<nombre>"
// Las referencias antiguas siguen funcionando aunque se cambie de proveedor.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { FILES_DIR, WORK_DIR } from './db.js';
import { s3Configured, presign, putObject, deleteObject, headObject } from './s3.js';

export const STORAGE_MODE = s3Configured() ? 's3' : process.env.BLOB_READ_WRITE_TOKEN ? 'blob' : 'local';
const isUrl = r => /^https?:\/\//.test(r || '');
const isS3 = r => String(r || '').startsWith('s3:');
const s3Key = r => String(r).slice(3);
const safeName = n => path.basename(String(n)).replace(/[^\w.-]+/g, '_').slice(-80) || 'archivo';
export const newKey = (name, folder = 'files') => `${folder}/${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}_${safeName(name)}`;

/** Guarda un archivo local y devuelve su referencia. */
export async function saveFile(localPath, name, contentType = 'video/mp4') {
  if (STORAGE_MODE === 's3') {
    const key = newKey(name);
    await putObject(key, fs.createReadStream(localPath), { contentType, size: fs.statSync(localPath).size });
    return 's3:' + key;
  }
  if (STORAGE_MODE === 'blob') {
    const { put } = await import('@vercel/blob');
    const blob = await put(name, fs.createReadStream(localPath), {
      access: 'public', contentType, addRandomSuffix: true, multipart: fs.statSync(localPath).size > 50e6,
    });
    return blob.url;
  }
  const ref = `${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}_${safeName(name)}`;
  fs.copyFileSync(localPath, path.join(FILES_DIR, ref));
  return ref;
}

export async function saveBuffer(buf, name, contentType) {
  const tmp = path.join(WORK_DIR, `buf_${crypto.randomBytes(6).toString('hex')}`);
  fs.writeFileSync(tmp, buf);
  try { return await saveFile(tmp, name, contentType); } finally { fs.rmSync(tmp, { force: true }); }
}

/** URL para el navegador. Los objetos S3 pasan por /api/f/… (comprueba la sesión y redirige a una URL firmada). */
export const publicUrl = ref => !ref ? null : isS3(ref) ? `/api/f/${s3Key(ref).split('/').map(encodeURIComponent).join('/')}` : isUrl(ref) ? ref : `/files/${encodeURIComponent(ref)}`;

/** Ruta o URL que ffmpeg puede leer directamente (en S3: URL firmada válida 6 h). */
export const inputPath = ref => isS3(ref) ? presign('GET', s3Key(ref), { expires: 21600 }) : isUrl(ref) ? ref : path.join(FILES_DIR, path.basename(ref));

/** URL firmada de descarga para el navegador (S3). */
export const signedGetUrl = (key, expires = 21600) => presign('GET', key, { expires });

/** Copia el archivo a disco local (para herramientas que no leen URLs). */
export async function toLocal(ref, dest) {
  if (!isUrl(ref) && !isS3(ref)) return inputPath(ref);
  const r = await fetch(inputPath(ref));
  if (!r.ok) throw new Error(`No se pudo descargar el archivo (${r.status})`);
  const { pipeline } = await import('node:stream/promises');
  const { Readable } = await import('node:stream');
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(dest));
  return dest;
}

/** Stream de lectura (para .zip y subida a YouTube). */
export async function readStream(ref) {
  if (!isUrl(ref) && !isS3(ref)) return fs.createReadStream(inputPath(ref));
  const r = await fetch(inputPath(ref));
  if (!r.ok) throw new Error(`No se pudo leer el archivo (${r.status})`);
  const { Readable } = await import('node:stream');
  return Readable.fromWeb(r.body);
}
export async function fileSize(ref) {
  if (isS3(ref)) return (await headObject(s3Key(ref))).size;
  if (!isUrl(ref)) return fs.statSync(inputPath(ref)).size;
  const r = await fetch(ref, { method: 'HEAD' });
  return Number(r.headers.get('content-length')) || 0;
}

export async function removeFile(ref) {
  if (!ref) return;
  try {
    if (isS3(ref)) await deleteObject(s3Key(ref));
    else if (isUrl(ref)) { if (process.env.BLOB_READ_WRITE_TOKEN) { const { del } = await import('@vercel/blob'); await del(ref); } }
    else fs.rmSync(inputPath(ref), { force: true });
  } catch (e) { console.warn('No se pudo borrar', ref, e.message); }
}
