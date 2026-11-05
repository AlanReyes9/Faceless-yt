// Almacenamiento de archivos: Vercel Blob (si hay BLOB_READ_WRITE_TOKEN) o disco local (./data/files).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { FILES_DIR, WORK_DIR } from './db.js';

export const STORAGE_MODE = process.env.BLOB_READ_WRITE_TOKEN ? 'blob' : 'local';
const isUrl = r => /^https?:\/\//.test(r || '');

/** Guarda un archivo local y devuelve su referencia (URL de Blob o nombre local). */
export async function saveFile(localPath, name, contentType = 'video/mp4') {
  if (STORAGE_MODE === 'blob') {
    const { put } = await import('@vercel/blob');
    const blob = await put(name, fs.createReadStream(localPath), {
      access: 'public', contentType, addRandomSuffix: true, multipart: fs.statSync(localPath).size > 50e6,
    });
    return blob.url;
  }
  const ref = `${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}_${path.basename(name)}`;
  fs.copyFileSync(localPath, path.join(FILES_DIR, ref));
  return ref;
}

export async function saveBuffer(buf, name, contentType) {
  const tmp = path.join(WORK_DIR, `buf_${crypto.randomBytes(6).toString('hex')}`);
  fs.writeFileSync(tmp, buf);
  try { return await saveFile(tmp, name, contentType); } finally { fs.rmSync(tmp, { force: true }); }
}

/** URL para el navegador. */
export const publicUrl = ref => !ref ? null : isUrl(ref) ? ref : `/files/${encodeURIComponent(ref)}`;

/** Ruta o URL que ffmpeg puede leer directamente. */
export const inputPath = ref => isUrl(ref) ? ref : path.join(FILES_DIR, path.basename(ref));

/** Copia el archivo a disco local (para herramientas que no leen URLs). */
export async function toLocal(ref, dest) {
  if (!isUrl(ref)) return inputPath(ref);
  const r = await fetch(ref);
  if (!r.ok) throw new Error(`No se pudo descargar ${ref} (${r.status})`);
  const { pipeline } = await import('node:stream/promises');
  const { Readable } = await import('node:stream');
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(dest));
  return dest;
}

/** Stream de lectura (para .zip y subida a YouTube). */
export async function readStream(ref) {
  if (!isUrl(ref)) return fs.createReadStream(inputPath(ref));
  const r = await fetch(ref);
  if (!r.ok) throw new Error(`No se pudo leer ${ref}`);
  const { Readable } = await import('node:stream');
  return Readable.fromWeb(r.body);
}
export async function fileSize(ref) {
  if (!isUrl(ref)) return fs.statSync(inputPath(ref)).size;
  const r = await fetch(ref, { method: 'HEAD' });
  return Number(r.headers.get('content-length')) || 0;
}

export async function removeFile(ref) {
  if (!ref) return;
  try {
    if (isUrl(ref)) { if (STORAGE_MODE === 'blob') { const { del } = await import('@vercel/blob'); await del(ref); } }
    else fs.rmSync(inputPath(ref), { force: true });
  } catch (e) { console.warn('No se pudo borrar', ref, e.message); }
}
