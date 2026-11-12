import express from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import archiver from 'archiver';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { q, one, insert, update, getProject, updateProject, getClip, updateClip, FILES_DIR, DB_MODE, IS_VERCEL } from './db.js';
import { publicSettings, setSettings, internalSecret, getSetting } from './settings.js';
import { chat, chatJSON } from './ai/llm.js';
import { generateImage } from './ai/media.js';
import { run, FFMPEG } from './video/ffmpeg.js';
import { CAPTION_STYLES } from './video/ass.js';
import './video/shorts.js';
import { setLive } from './video/live.js';
import { generateScript, generateAdScript, generateMontageScript } from './video/composer.js';
import { authUrl, handleCallback, uploadVideo, youtubeConfigured, baseUrl } from './youtube.js';
import { analyzeChannel } from './analyzer.js';
import { preview as cleanupPreview, runCleanup } from './cleanup.js';
import { enqueue, drain, kick, ensureWorker, queueStatus, setBaseUrl } from './jobs.js';
import { STORAGE_MODE, saveFile, saveBuffer, publicUrl, readStream, removeFile, signedGetUrl, newKey } from './storage.js';
import { s3Configured, presign, putBucketCors, S3 } from './s3.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
export const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '4mb' }));
app.use(cookieParser());
app.use((req, res, next) => { setBaseUrl(baseUrl(req)); next(); });

// ---------- Acceso con contraseña (APP_PASSWORD) ----------
const PASSWORD = process.env.APP_PASSWORD || '';
// En Vercel (público en internet) no se abre nada sin contraseña ni clave de cifrado.
const SETUP_MISSING = IS_VERCEL ? [
  !PASSWORD && 'APP_PASSWORD', !process.env.APP_SECRET && 'APP_SECRET',
  !(process.env.DATABASE_URL || process.env.POSTGRES_URL) && 'DATABASE_URL', !(s3Configured() || process.env.BLOB_READ_WRITE_TOKEN) && 'ALMACENAMIENTO',
].filter(Boolean) : [];
const BLOCKED = SETUP_MISSING.includes('APP_PASSWORD') || SETUP_MISSING.includes('APP_SECRET');
const sign = v => crypto.createHmac('sha256', PASSWORD + internalSecret()).update(v).digest('hex');
const authed = req => !PASSWORD || req.cookies.session === sign('ok');
const h = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => { console.error(req.path, e.message); if (!res.headersSent) res.status(400).json({ error: e.message }); });

app.get('/api/me', h(async (req, res) => res.json({
  authed: !BLOCKED && authed(req), passwordRequired: !!PASSWORD, setup: SETUP_MISSING, blocked: BLOCKED,
  ...(BLOCKED ? { ffmpeg: await run(FFMPEG, ['-version']).then(() => true, () => false), faces: await (await import('./video/face.js')).faceSelfTest() } : {}),
})));
app.use('/api', (req, res, next) => BLOCKED ? res.status(503).json({ error: 'Configuración pendiente: ' + SETUP_MISSING.join(', ') }) : next());

app.post('/api/login', (req, res) => {
  const a = Buffer.from(String(req.body.password || '')), b = Buffer.from(PASSWORD);
  if (!PASSWORD || (a.length === b.length && crypto.timingSafeEqual(a, b))) {
    res.cookie('session', sign('ok'), { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5, secure: req.secure });
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Contraseña incorrecta' });
});
app.post('/api/logout', (req, res) => { res.clearCookie('session'); res.json({ ok: true }); });

// ---------- Worker (procesa la cola en segundo plano) ----------
async function workerEntry(req, res) {
  // Estado de la cola (solo recuentos y tipos de paso, sin datos de proyectos) para diagnóstico
  const qs = await queueStatus().catch(e => ({ error: e.message }));
  console.log('[worker] cola:', JSON.stringify(qs));
  res.status(202).json({ ok: true, queue: qs });
  const work = drain().then(empty => { if (!empty) kick(true); }).catch(e => console.error('drain', e)); // sin relanzar en error: evita bucles si la BD falla
  if (IS_VERCEL) (await import('@vercel/functions')).waitUntil(work);
}
app.post('/api/worker', h(async (req, res) => {
  if (req.get('x-worker-secret') !== internalSecret()) return res.status(403).json({ error: 'forbidden' });
  await workerEntry(req, res);
}));
app.get('/api/worker/cron', h(async (req, res) => { // cron diario de Vercel: limpieza de originales + red de seguridad de la cola
  const work = runCleanup().catch(e => console.error('limpieza', e.message));
  if (IS_VERCEL) (await import('@vercel/functions')).waitUntil(work);
  await workerEntry(req, res);
}));

app.use(['/api', '/files'], (req, res, next) => {
  if (authed(req) || req.path === '/youtube/callback' || req.path === '/blob/upload') return next();
  res.status(401).json({ error: 'No autorizado' });
});

// ---------- Subida de archivos ----------
const upload = multer({ dest: path.join(FILES_DIR, '.tmp'), limits: { fileSize: 8 * 1024 ** 3 } });
app.post('/api/upload', upload.single('file'), h(async (req, res) => {
  if (!req.file) throw new Error('No se recibió ningún archivo.');
  const ref = await saveFile(req.file.path, req.file.originalname.replace(/[^\w.-]+/g, '_'), req.file.mimetype);
  (await import('node:fs')).rmSync(req.file.path, { force: true });
  res.json({ ref, url: publicUrl(ref) });
}));
// Subida directa del navegador a Vercel Blob (archivos grandes, sin pasar por la función)
app.post('/api/blob/upload', h(async (req, res) => {
  const { handleUpload } = await import('@vercel/blob/client');
  const isTokenRequest = req.body?.type === 'blob.generate-client-token';
  if (isTokenRequest && !authed(req)) return res.status(401).json({ error: 'No autorizado' });
  const result = await handleUpload({
    body: req.body, request: req,
    onBeforeGenerateToken: async () => ({
      allowedContentTypes: ['video/*', 'image/*', 'audio/*'],
      maximumSizeInBytes: 5 * 1024 ** 3, addRandomSuffix: true,
    }),
  });
  res.json(result);
}));

// ---------- Almacenamiento S3 (Cloudflare R2 / Backblaze B2) ----------
// Reproducir/descargar: comprueba la sesión y redirige a una URL firmada (la descarga va directa del proveedor)
app.get(/^\/api\/f\/(.+)$/, (req, res) => {
  if (!s3Configured()) return res.status(404).end();
  const key = req.params[0].split('/').map(decodeURIComponent).join('/');
  if (key.includes('..')) return res.status(400).end();
  res.set('cache-control', 'private, max-age=3000');
  res.redirect(302, signedGetUrl(key, 3600 * 6));
});
// Subida directa del navegador al bucket (URL firmada de PUT)
app.post('/api/s3/presign', h(async (req, res) => {
  if (!s3Configured()) throw new Error('El almacenamiento S3 no está configurado.');
  const key = newKey(req.body.filename || 'archivo', 'uploads');
  res.json({ ref: 's3:' + key, url: presign('PUT', key, { expires: 3600 * 3 }) });
}));
app.post('/api/admin/s3-cors', h(async (req, res) => {
  if (!s3Configured()) throw new Error('El almacenamiento S3 no está configurado.');
  const origins = [...new Set([baseUrl(req), process.env.PUBLIC_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`].filter(Boolean))];
  await putBucketCors(origins);
  res.json({ ok: true, origins });
}));

// ---------- Sistema ----------
const has = (cmd, flag = '--version') => run(cmd, [flag]).then(() => true, () => false);
app.get('/api/system', h(async (req, res) => res.json({
  ffmpeg: await has(FFMPEG, '-version'), ytdlp: IS_VERCEL ? false : await has('yt-dlp'),
  queue: await queueStatus(), youtube: await youtubeConfigured(), storage: STORAGE_MODE, db: DB_MODE, vercel: IS_VERCEL,
})));
app.get('/api/stats', h(async (req, res) => res.json({
  channels: (await one('SELECT COUNT(*)::int n FROM channels')).n,
  projects: (await one('SELECT COUNT(*)::int n FROM projects WHERE deleted_at IS NULL')).n,
  shorts: (await one("SELECT COUNT(*)::int n FROM clips c JOIN projects p ON p.id = c.project_id WHERE c.status = 'ready' AND p.deleted_at IS NULL")).n,
  published: (await one('SELECT COUNT(*)::int n FROM clips WHERE yt_video_id IS NOT NULL')).n,
  upcoming: await q("SELECT * FROM calendar WHERE NOT done AND date >= to_char(now(), 'YYYY-MM-DD') ORDER BY date LIMIT 5"),
  recent: await q('SELECT id, type, title, status, progress, created_at FROM projects WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 6'),
})));
app.get('/api/admin', h(async (req, res) => res.json({
  db: DB_MODE, storage: STORAGE_MODE, s3: s3Configured() ? { endpoint: S3.endpoint.replace(/^https?:\/\//, ''), bucket: S3.bucket } : null, vercel: IS_VERCEL, ffmpeg: FFMPEG, node: process.version,
  queue: await queueStatus(),
  jobs: await q("SELECT id, type, payload, status, attempts, error, locked_at, created_at FROM jobs ORDER BY id DESC LIMIT 50"),
})));
app.post('/api/admin/jobs/:id/retry', h(async (req, res) => {
  await q("UPDATE jobs SET status = 'queued', attempts = 0, error = NULL, locked_at = NULL WHERE id = $1", [req.params.id]);
  kick(true); res.json({ ok: true });
}));
app.delete('/api/admin/jobs', h(async (req, res) => { await q("DELETE FROM jobs WHERE status = 'failed'"); res.json({ ok: true }); }));
app.get('/api/admin/cleanup', h(async (req, res) => res.json(await cleanupPreview())));
app.post('/api/admin/cleanup', h(async (req, res) => res.json(await runCleanup())));
app.post('/api/admin/kick', h(async (req, res) => { kick(true); res.json({ ok: true }); }));

// ---------- Ajustes y claves ----------
app.get('/api/settings', h(async (req, res) => res.json(await publicSettings())));
app.put('/api/settings', h(async (req, res) => { await setSettings(req.body || {}); res.json(await publicSettings()); }));
app.post('/api/settings/test', h(async (req, res) => {
  const out = await chat('Responde solo con la palabra OK.', 'Prueba de conexión', { provider: req.body.provider, maxTokens: 20 });
  res.json({ ok: true, reply: out.trim().slice(0, 50) });
}));

// ---------- Canales ----------
const channelOut = c => ({ ...c, yt_refresh_token: undefined, connected: !!c.yt_refresh_token });
app.get('/api/channels', h(async (req, res) => res.json((await q('SELECT * FROM channels ORDER BY id')).map(channelOut))));
app.post('/api/channels', h(async (req, res) => {
  const { name, niche = '', language = 'es', notes = '' } = req.body;
  if (!name) throw new Error('El canal necesita un nombre.');
  res.json(channelOut(await insert('channels', { name, niche, language, notes })));
}));
app.put('/api/channels/:id', h(async (req, res) => {
  const { name, niche, language, notes } = req.body;
  await update('channels', req.params.id, { name, niche: niche || '', language: language || 'es', notes: notes || '' });
  res.json({ ok: true });
}));
app.delete('/api/channels/:id', h(async (req, res) => { await q('DELETE FROM channels WHERE id = $1', [req.params.id]); res.json({ ok: true }); }));
app.post('/api/channels/:id/disconnect', h(async (req, res) => {
  await update('channels', req.params.id, { yt_refresh_token: null, yt_channel_id: null, yt_title: null });
  res.json({ ok: true });
}));
app.get('/api/youtube/auth', h(async (req, res) => res.redirect(await authUrl(req, req.query.channel))));
app.get('/api/youtube/callback', async (req, res) => {
  try { await handleCallback(req); res.redirect('/#/canales?ok=1'); }
  catch (e) { res.redirect('/#/canales?error=' + encodeURIComponent(e.message)); }
});

// ---------- Proyectos ----------
/** Porcentaje global: en la fase de render se calcula con el avance de cada clip. */
function projectPercent(p, clips = []) {
  if (p.status === 'ready') return 100;
  const rendering = clips.filter(c => c.status === 'rendering');
  if (p.type === 'shorts' && clips.length && rendering.length) {
    const avg = clips.reduce((a, c) => a + (c.status === 'rendering' ? (c.progress || 0) : 100), 0) / clips.length;
    return Math.round(55 + 0.45 * avg);
  }
  return p.percent || 0;
}

function projectOut(p) {
  const { transcript, ...data } = p.data || {};
  if (data.options?.media) data.options.mediaUrls = data.options.media.map(publicUrl);
  if (data.script?.scenes) data.script.scenes = data.script.scenes.map(s => ({ ...s, mediaUrl: publicUrl(s.media) }));
  return { ...p, data, hasTranscript: !!transcript?.words?.length, outputUrl: publicUrl(p.output), sourceUrl: publicUrl(p.source) };
}
const clipOut = c => ({ ...c, url: publicUrl(c.file), variants: Object.fromEntries(Object.entries(c.variants || {}).map(([l, v]) => [l, { title: v.title, hook: v.hook, url: publicUrl(v.file), file: v.file }])) });

app.get('/api/projects', h(async (req, res) => {
  const trash = req.query.trash === '1';
  const params = req.query.type ? [req.query.type] : [];
  const rows = await q(`SELECT p.id, p.type, p.title, p.status, p.progress, p.error, p.created_at, p.duration, p.output, p.percent,
      (SELECT ROUND(55 + 0.45 * AVG(CASE WHEN c.status = 'rendering' THEN COALESCE(c.progress, 0) ELSE 100 END))::int FROM clips c WHERE c.project_id = p.id) AS clip_percent,
      (SELECT COUNT(*)::int FROM clips c WHERE c.project_id = p.id AND c.status = 'rendering') AS rendering,
      (SELECT COUNT(*)::int FROM clips c WHERE c.project_id = p.id AND c.status = 'ready') ready_clips
    FROM projects p WHERE deleted_at IS ${trash ? 'NOT ' : ''}NULL ${req.query.type ? 'AND type = $1' : ''} ORDER BY id DESC LIMIT 200`, params);
  if (rows.some(r => ['pending', 'processing'].includes(r.status))) ensureWorker().catch(() => {});
  res.json(rows.map(r => ({ ...r, percent: r.status === 'ready' ? 100 : (r.type === 'shorts' && r.rendering ? r.clip_percent : r.percent) || 0 })));
}));
app.get('/api/projects/:id', h(async (req, res) => {
  const p = await getProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'No existe' });
  const clips = await q('SELECT * FROM clips WHERE project_id = $1 ORDER BY idx', [p.id]);
  if (['pending', 'processing'].includes(p.status) || clips.some(c => c.status === 'rendering')) ensureWorker().catch(() => {});
  const days = Number(await getSetting('cleanup_days')) || 0;
  const base = p.ready_at || p.created_at;
  const cleanup = { days, keep: !!p.data.keepSource, deletedAt: p.data.sourceDeletedAt || null,
    at: days > 0 && p.status === 'ready' && base && (p.source || p.data.options?.media?.length) ? new Date(new Date(base).getTime() + days * 864e5).toISOString() : null };
  const live = p.type === 'live' ? { ...(p.data.live || {}), ...(await one(`SELECT COUNT(*)::int AS segs, COALESCE(SUM(dur), 0)::float AS secs,
      COUNT(*) FILTER (WHERE NOT analyzed)::int AS pending FROM live_segments WHERE project_id = $1`, [p.id])) } : null;
  res.json({ ...projectOut(p), percent: projectPercent(p, clips), cleanup, live, clips: clips.map(clipOut) });
}));
app.post('/api/shorts', h(async (req, res) => {
  const b = req.body;
  if (!b.source && !b.url) throw new Error('Sube un vídeo o pega un enlace.');
  const options = {
    count: Math.min(30, Number(b.count) || 10), minSec: Number(b.minSec) || 20, maxSec: Number(b.maxSec) || 60,
    layout: ['crop', 'blur', 'face'].includes(b.layout) ? b.layout : 'face', language: b.language || '', titleLanguage: b.titleLanguage || '',
    captions: b.captions !== false, captionStyle: CAPTION_STYLES[b.captionStyle] ? b.captionStyle : 'clasico', emojis: b.emojis !== false,
  };
  const p = await insert('projects', { type: 'shorts', title: b.title || b.filename?.replace(/\.[^.]+$/, '') || b.url, channel_id: Number(b.channel_id) || null,
    source: b.source || null, source_url: b.url || null, data: { options }, progress: 'En cola…' });
  await enqueue('shorts.start', { id: p.id });
  res.json({ id: p.id });
}));

// Clips de un vídeo en directo
app.post('/api/live', h(async (req, res) => {
  const b = req.body;
  let url = String(b.url || '').trim();
  if (/^(www\.|m\.)?(youtube\.com|youtu\.be|twitch\.tv|kick\.com)\//i.test(url)) url = 'https://' + url; // enlaces pegados sin https://
  if (!/^(https?|rtmps?|srt|rtsp):\/\//i.test(url)) throw new Error('Pega el enlace del directo (YouTube, Twitch, Kick… o un enlace .m3u8).');
  const platform = /twitch\.tv/i.test(url) ? 'Twitch' : /kick\.com/i.test(url) ? 'Kick' : /youtube\.com|youtu\.be/i.test(url) ? 'YouTube' : null;
  if (IS_VERCEL && !/\.m3u8(\?|$)/i.test(url)) throw new Error('En la versión de Vercel solo se pueden usar enlaces directos .m3u8. Para YouTube, Twitch o Kick instala la app en tu PC (ver Ayuda).');
  const options = {
    layout: ['crop', 'blur', 'face'].includes(b.layout) ? b.layout : 'face', captionStyle: CAPTION_STYLES[b.captionStyle] ? b.captionStyle : 'impacto',
    emojis: b.emojis !== false, captions: b.captions !== false, language: b.language || '', titleLanguage: b.titleLanguage || '',
    minScore: Math.min(10, Math.max(1, Number(b.minScore) || 7)), minSec: Number(b.minSec) || 15, maxSec: Number(b.maxSec) || 60,
    segmentSec: Math.min(240, Math.max(Number(process.env.LIVE_MIN_SEGMENT) || 60, Number(b.segmentSec) || 180)), maxMinutes: Math.min(600, Math.max(5, Number(b.maxMinutes) || 120)),
    perSegment: Math.min(5, Math.max(1, Number(b.perSegment) || 3)),
  };
  const p = await insert('projects', { type: 'live', title: b.title || `Directo${platform ? ' de ' + platform : ''} ${url.split('/').filter(Boolean).pop()?.split('?')[0] || ''} · ${new Date().toLocaleDateString('es')}`, channel_id: Number(b.channel_id) || null,
    source_url: url, status: 'processing', data: { options, live: {} }, progress: '🔴 Conectando con el directo…' });
  await enqueue('live.capture', { id: p.id, seg: 0 });
  res.json({ id: p.id });
}));
app.post('/api/projects/:id/stop', h(async (req, res) => {
  const p = await getProject(req.params.id);
  if (p?.type !== 'live') throw new Error('Solo se pueden detener directos.');
  await setLive(p.id, { stopRequested: true });
  await updateProject(p.id, { progress: '⏹ Deteniendo: se termina de grabar el segmento actual y se analizan los últimos momentos…' });
  res.json({ ok: true });
}));

// Vídeo completo / anuncio / montaje: mismo motor de composición
const COMPOSE_TYPES = ['long', 'ad', 'montage'];
app.post('/api/compose/script', h(async (req, res) => {
  const { type = 'long', ...o } = req.body;
  if (type === 'ad') return res.json(await generateAdScript({ ...o, images: (o.media || []).length }));
  if (type === 'montage') return res.json(await generateMontageScript({ ...o, notes: (o.media || []).map((_, i) => o.notes?.[i] || '') }));
  const character = o.characterId ? await one('SELECT * FROM characters WHERE id = $1', [o.characterId]) : null;
  res.json(await generateScript({ ...o, character }));
}));
app.post('/api/compose', h(async (req, res) => {
  const { type = 'long', script, channel_id, ...options } = req.body;
  if (!COMPOSE_TYPES.includes(type)) throw new Error('Tipo no válido.');
  if (type === 'montage' && !options.media?.length) throw new Error('Sube al menos un clip o imagen.');
  if (type === 'ad' && !options.product) throw new Error('Escribe el nombre del producto.');
  if (type === 'long' && !options.topic && !script) throw new Error('Escribe un tema para el vídeo.');
  if (script?.scenes && type === 'ad') script.scenes.forEach(s => { if (Number.isInteger(s.image) && options.media?.[s.image]) s.media = options.media[s.image]; });
  const title = script?.title || options.topic || options.product || 'Montaje';
  const p = await insert('projects', { type, title, channel_id: Number(channel_id) || null, data: { options, script: script || null }, progress: 'En cola…' });
  await enqueue('compose.script', { id: p.id });
  res.json({ id: p.id });
}));
app.post('/api/projects/:id/retry', h(async (req, res) => {
  const p = await getProject(req.params.id);
  if (p.data.sourceDeletedAt) throw new Error(NO_SOURCE);
  // Shorts ya transcritos: solo se vuelven a renderizar los clips que fallaron (no se repite ni se paga la transcripción)
  const failed = ['shorts', 'live'].includes(p.type) ? await q("SELECT id FROM clips WHERE project_id = $1 AND status <> 'ready'", [p.id]) : [];
  if (p.type === 'live') {
    if (!failed.length) throw new Error('No hay clips con error que reintentar.');
    await q("UPDATE jobs SET status = 'failed' WHERE status = 'queued' AND payload->>'id' = $1 AND type LIKE 'live.%'", [String(p.id)]);
  }
  if ((p.type === 'shorts' && p.data.transcript?.words?.length || p.type === 'live') && failed.length) {
    await updateProject(p.id, { status: 'processing', error: null, progress: `Renderizando ${failed.length} Shorts…` });
    for (const c of failed) {
      await updateClip(c.id, { status: 'rendering', error: null, progress: 0, stage: 'En cola…' });
      await enqueue('clip.render', { clipId: c.id });
    }
    return res.json({ ok: true, clips: failed.length });
  }
  await updateProject(p.id, { status: 'pending', error: null, progress: 'En cola…', percent: 0 });
  await enqueue(p.type === 'shorts' ? 'shorts.start' : 'compose.script', { id: p.id });
  res.json({ ok: true });
}));
app.patch('/api/projects/:id', h(async (req, res) => {
  const p = await getProject(req.params.id);
  const f = {};
  if ('title' in req.body) f.title = req.body.title;
  if ('channel_id' in req.body) f.channel_id = Number(req.body.channel_id) || null;
  if ('keepSource' in req.body) f.data = { ...p.data, keepSource: !!req.body.keepSource };
  await updateProject(p.id, f);
  res.json({ ok: true });
}));
app.delete('/api/projects/:id', h(async (req, res) => {
  const p = await getProject(req.params.id);
  if (req.query.permanent !== '1') { await updateProject(p.id, { deleted_at: new Date().toISOString() }); return res.json({ ok: true }); }
  for (const c of await q('SELECT * FROM clips WHERE project_id = $1', [p.id])) {
    await removeFile(c.file);
    for (const v of Object.values(c.variants || {})) await removeFile(v.file);
  }
  await removeFile(p.output); await removeFile(p.source);
  for (const s of p.data.script?.scenes || []) if (s.media && !(p.data.options?.media || []).includes(s.media)) await removeFile(s.media);
  for (const m of p.data.options?.media || []) await removeFile(m);
  for (const part of p.data.parts || []) await removeFile(part);
  await q('DELETE FROM clips WHERE project_id = $1', [p.id]);
  await q('DELETE FROM projects WHERE id = $1', [p.id]);
  res.json({ ok: true });
}));
app.post('/api/projects/:id/restore', h(async (req, res) => { await updateProject(req.params.id, { deleted_at: null }); res.json({ ok: true }); }));
app.get('/api/projects/:id/zip', h(async (req, res) => {
  const p = await getProject(req.params.id);
  const clips = await q('SELECT * FROM clips WHERE project_id = $1 AND include_zip AND file IS NOT NULL ORDER BY idx', [p.id]);
  res.attachment(`shorts_${p.id}.zip`);
  const zip = archiver('zip', { store: true });
  zip.on('error', e => res.destroy(e));
  zip.pipe(res);
  const safe = s => String(s || '').replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 60);
  const used = new Set();
  const unique = n => { let out = n, i = 2; while (used.has(out)) out = n.replace(/\.mp4$/, ` (${i++}).mp4`); used.add(out); return out; };
  for (const c of clips) {
    zip.append(await readStream(c.file), { name: unique(`${String(c.idx).padStart(2, '0')} - ${safe(c.title) || 'short'}.mp4`) });
    for (const [lang, v] of Object.entries(c.variants || {}))
      if (v.file) zip.append(await readStream(v.file), { name: unique(`${lang}/${String(c.idx).padStart(2, '0')} - ${safe(v.title || c.title)}.mp4`) });
  }
  zip.append(clips.map(c => `#${c.idx} [${c.score}/10] ${c.title}\nGancho: ${c.hook}\n${c.reason}\n`).join('\n'), { name: 'titulos.txt' });
  await zip.finalize();
}));

// ---------- Clips (Shorts) ----------
/** "💰 dinero, 🚨 policía" → [{emoji:'💰', word:'dinero'}, ...] */
function parseEmojis(v) {
  if (Array.isArray(v)) return v.filter(e => e?.emoji && e?.word).slice(0, 6);
  return String(v || '').split(',').map(x => x.trim()).filter(Boolean).map(x => {
    const m = x.match(/^(\S+)\s+(.+)$/u);
    return m ? { emoji: m[1], word: m[2].trim() } : null;
  }).filter(Boolean).slice(0, 6);
}
app.get('/api/caption-styles', (req, res) => res.json(Object.fromEntries(Object.entries(CAPTION_STYLES).map(([k, v]) => [k, v.label]))));
app.patch('/api/clips/:id', h(async (req, res) => {
  const c = await getClip(req.params.id);
  const f = {};
  for (const k of ['title', 'hook']) if (k in req.body) f[k] = String(req.body[k]);
  if (['face', 'blur', 'crop'].includes(req.body.layout)) f.layout = req.body.layout;
  if (CAPTION_STYLES[req.body.style]) f.style = req.body.style;
  if ('keywords' in req.body) f.keywords = (Array.isArray(req.body.keywords) ? req.body.keywords : String(req.body.keywords).split(','))
    .map(x => String(x).trim()).filter(Boolean).slice(0, 10);
  if ('emojis' in req.body) f.emojis = parseEmojis(req.body.emojis);
  for (const k of ['start', 'end']) if (k in req.body) f[k] = Math.max(0, Number(req.body[k]));
  if ('include_zip' in req.body) f.include_zip = !!req.body.include_zip;
  if ((f.end ?? c.end) - (f.start ?? c.start) < 2) throw new Error('El clip debe durar al menos 2 segundos.');
  await updateClip(c.id, f);
  res.json({ ok: true });
}));
const NO_SOURCE = 'El vídeo original de este proyecto se borró para ahorrar espacio (limpieza automática), así que no se puede volver a renderizar. Los Shorts ya hechos siguen disponibles.';
async function requireSource(clipId) {
  const c = await getClip(clipId);
  const p = c && await getProject(c.project_id);
  const parts = c?.src ? JSON.parse(c.src) : null;
  if (p?.data?.sourceDeletedAt || !(parts ? parts.every(x => x.ref) : p?.source)) throw new Error(NO_SOURCE);
}
app.post('/api/clips/:id/render', h(async (req, res) => {
  await requireSource(req.params.id);
  await updateClip(req.params.id, { status: 'rendering', error: null, progress: 0, stage: 'En cola…' });
  await updateProject((await getClip(req.params.id)).project_id, { status: 'processing', error: null, progress: 'Renderizando cambios…' });
  await enqueue('clip.render', { clipId: Number(req.params.id) });
  res.json({ ok: true });
}));
app.post('/api/clips/:id/translate', h(async (req, res) => {
  if (!req.body.lang) throw new Error('Elige un idioma.');
  await requireSource(req.params.id);
  await updateClip(req.params.id, { status: 'rendering', error: null, progress: 0, stage: 'Traduciendo…' });
  await updateProject((await getClip(req.params.id)).project_id, { status: 'processing', error: null, progress: 'Traduciendo…' });
  await enqueue('clip.translate', { clipId: Number(req.params.id), lang: req.body.lang });
  res.json({ ok: true });
}));
app.delete('/api/clips/:id', h(async (req, res) => {
  const c = await getClip(req.params.id);
  await removeFile(c.file);
  for (const v of Object.values(c.variants || {})) await removeFile(v.file);
  await q('DELETE FROM clips WHERE id = $1', [c.id]);
  res.json({ ok: true });
}));
app.post('/api/clips/:id/publish', h(async (req, res) => {
  const c = await getClip(req.params.id);
  const { channel_id, title, description = '', tags = [], privacy = 'public', publishAt, lang } = req.body;
  const file = lang ? c.variants[lang]?.file : c.file;
  if (!file) throw new Error('Este clip aún no está renderizado.');
  const t = title || (lang ? c.variants[lang]?.title : '') || c.title;
  const id = await uploadVideo(Number(channel_id), file, {
    title: /#shorts/i.test(t) ? t : `${t} #Shorts`, description: `${description}\n\n#Shorts`.trim(), tags, privacy, publishAt,
  });
  await updateClip(c.id, { yt_video_id: id });
  res.json({ ok: true, videoId: id, url: `https://youtube.com/shorts/${id}` });
}));
app.post('/api/projects/:id/publish', h(async (req, res) => {
  const p = await getProject(req.params.id);
  if (!p.output) throw new Error('El vídeo aún no está listo.');
  const s = p.data.script || {};
  const { channel_id, title, description, tags, privacy = 'public', publishAt } = req.body;
  const id = await uploadVideo(Number(channel_id), p.output, {
    title: title || s.title || p.title, description: description ?? s.description ?? '', tags: tags || s.tags || [], privacy, publishAt,
  });
  await updateProject(p.id, { data: { ...p.data, yt_video_id: id } });
  res.json({ ok: true, videoId: id, url: `https://youtube.com/watch?v=${id}` });
}));

// ---------- Personaje IA ----------
const charOut = c => ({ ...c, imageUrls: (c.images || []).map(publicUrl) });
app.get('/api/characters', h(async (req, res) => res.json((await q('SELECT * FROM characters ORDER BY id DESC')).map(charOut))));
app.post('/api/characters', h(async (req, res) => {
  const { name, description = '', personality = '', style = '', voice = '' } = req.body;
  if (!name) throw new Error('El personaje necesita un nombre.');
  res.json(charOut(await insert('characters', { name, description, personality, style, voice, images: [] })));
}));
app.put('/api/characters/:id', h(async (req, res) => {
  const { name, description, personality, style, voice } = req.body;
  await update('characters', req.params.id, { name, description, personality, style, voice });
  res.json({ ok: true });
}));
app.delete('/api/characters/:id', h(async (req, res) => {
  const c = await one('SELECT * FROM characters WHERE id = $1', [req.params.id]);
  for (const img of c?.images || []) await removeFile(img);
  await q('DELETE FROM characters WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));
app.post('/api/characters/:id/image', h(async (req, res) => {
  const c = await one('SELECT * FROM characters WHERE id = $1', [req.params.id]);
  const { readFile } = await import('node:fs/promises');
  const refs = [];
  if (req.body.consistent !== false && c.images?.[0]) {
    const { toLocal } = await import('./storage.js');
    const { WORK_DIR } = await import('./db.js');
    refs.push(await readFile(await toLocal(c.images[0], path.join(WORK_DIR, `char_${c.id}_${Date.now()}.png`))));
  }
  const prompt = req.body.prompt
    ? `${req.body.prompt}. Character: ${c.name}, ${c.description}. Style: ${c.style || 'cinematic, high detail'}. No text.`
    : `Character design portrait of ${c.name}: ${c.description}. Personality: ${c.personality}. Style: ${c.style || 'cinematic, high detail'}. Plain background, full face visible. No text.`;
  const buf = await generateImage(prompt, { size: req.body.size || '1024x1536', references: refs });
  const ref = await saveBuffer(buf, `character_${c.id}.png`, 'image/png');
  const images = [...(c.images || []), ref];
  await update('characters', c.id, { images });
  res.json({ ok: true, url: publicUrl(ref), images: images.map(publicUrl) });
}));
app.post('/api/characters/:id/images', h(async (req, res) => { // añadir imagen subida por el usuario
  const c = await one('SELECT * FROM characters WHERE id = $1', [req.params.id]);
  const images = [...(c.images || []), req.body.ref];
  await update('characters', c.id, { images });
  res.json({ ok: true });
}));
app.delete('/api/characters/:id/images/:idx', h(async (req, res) => {
  const c = await one('SELECT * FROM characters WHERE id = $1', [req.params.id]);
  const images = [...(c.images || [])];
  const [gone] = images.splice(Number(req.params.idx), 1);
  await removeFile(gone);
  await update('characters', c.id, { images });
  res.json({ ok: true });
}));
app.post('/api/characters/suggest', h(async (req, res) => res.json(await chatJSON(
  'Diseñas personajes memorables para canales faceless de YouTube (mascotas, narradores animados, avatares).',
  `Idea: "${req.body.idea || 'un narrador carismático para historias de misterio'}". Devuelve {"name":"...","description":"aspecto físico detallado EN INGLÉS para generar imágenes coherentes","personality":"personalidad y forma de hablar en español","style":"estilo visual EN INGLÉS (p. ej. 3D Pixar, anime, realista)"}`))));

// ---------- Analizador ----------
app.post('/api/analyze', h(async (req, res) => {
  if (!req.body.target) throw new Error('Pega la URL de un canal o vídeo.');
  const r = await analyzeChannel(req.body.target);
  const row = await insert('analyses', { target: r.target, kind: r.kind, result: r });
  res.json({ id: row.id, ...r });
}));
app.get('/api/analyses', h(async (req, res) => res.json(await q('SELECT id, target, kind, created_at FROM analyses ORDER BY id DESC LIMIT 50'))));
app.get('/api/analyses/:id', h(async (req, res) => { const a = await one('SELECT * FROM analyses WHERE id = $1', [req.params.id]); res.json({ id: a.id, ...a.result }); }));
app.delete('/api/analyses/:id', h(async (req, res) => { await q('DELETE FROM analyses WHERE id = $1', [req.params.id]); res.json({ ok: true }); }));

// ---------- Herramientas IA ----------
app.post('/api/niches', h(async (req, res) => {
  const { interest = '', language = 'es', market = 'hispanohablante' } = req.body;
  res.json(await chatJSON(
    'Eres un estratega de YouTube especializado en canales faceless (sin mostrar la cara) y monetización (RPM, AdSense, afiliados).',
    `Propón 8 nichos para un canal faceless${interest ? ` relacionados con: "${interest}"` : ''}, para el mercado ${market}, idioma ${language}.
Para cada uno: {"name","description","rpm":"estimación de RPM en USD","competition":"baja|media|alta","difficulty":1-10,"formats":["shorts","largos",...],"video_ideas":["5 títulos de vídeo concretos"],"why":"por qué es buena oportunidad"}.
JSON: {"niches":[...]}`, { maxTokens: 6000 }));
}));

// ---------- Calendario ----------
app.get('/api/calendar', h(async (req, res) => {
  const { from = '0000', to = '9999' } = req.query;
  res.json(await q('SELECT * FROM calendar WHERE date BETWEEN $1 AND $2 ORDER BY date, id', [from, to]));
}));
app.post('/api/calendar', h(async (req, res) => {
  const { date, title, notes = '', channel_id = null, kind = 'short' } = req.body;
  if (!date || !title) throw new Error('Fecha y título son obligatorios.');
  res.json(await insert('calendar', { date, title, notes, channel_id: channel_id || null, kind }));
}));
app.patch('/api/calendar/:id', h(async (req, res) => {
  const f = {};
  for (const k of ['date', 'title', 'notes', 'kind']) if (k in req.body) f[k] = req.body[k];
  if ('done' in req.body) f.done = !!req.body.done;
  if ('channel_id' in req.body) f.channel_id = req.body.channel_id || null;
  await update('calendar', req.params.id, f);
  res.json({ ok: true });
}));
app.delete('/api/calendar/:id', h(async (req, res) => { await q('DELETE FROM calendar WHERE id = $1', [req.params.id]); res.json({ ok: true }); }));
app.post('/api/calendar/generate', h(async (req, res) => {
  const { channel_id, days = 14, start = new Date().toISOString().slice(0, 10), perDay = 1 } = req.body;
  const ch = await one('SELECT * FROM channels WHERE id = $1', [channel_id]);
  if (!ch) throw new Error('Elige un canal.');
  const plan = await chatJSON('Eres un estratega de contenido para YouTube faceless.',
    `Canal "${ch.name}", nicho "${ch.niche}", idioma ${ch.language}. ${ch.notes || ''}
Crea un calendario de ${days} días empezando el ${start}, ${perDay} publicación(es) por día, mezclando Shorts y vídeos largos (aprox. 1 largo por cada 5 shorts).
JSON: {"items":[{"date":"YYYY-MM-DD","kind":"short|long","title":"...","notes":"idea/gancho en una frase"}]}`, { maxTokens: 6000 });
  let added = 0;
  for (const it of plan.items || []) if (it.date && it.title) { await insert('calendar', { date: it.date, title: it.title, notes: it.notes || '', channel_id: ch.id, kind: it.kind === 'long' ? 'long' : 'short' }); added++; }
  res.json({ added });
}));

// ---------- Archivos y frontend ----------
if (!IS_VERCEL) app.use('/files', express.static(FILES_DIR, { maxAge: '1h' }));
app.use(express.static(PUBLIC_DIR));
app.get(/^\/(?!api|files).*/, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

export default app;
