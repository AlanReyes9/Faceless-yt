import express from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import archiver from 'archiver';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { q, one, insert, update, getProject, updateProject, getClip, updateClip, FILES_DIR, WORK_DIR, DB_MODE, IS_VERCEL } from './db.js';
import { publicSettings, setSettings, internalSecret, getSetting, aiMode } from './settings.js';
import { chat, chatJSON } from './ai/llm.js';
import { generateImage } from './ai/media.js';
import { run, FFMPEG, probe } from './video/ffmpeg.js';
import { CAPTION_STYLES } from './video/ass.js';
import { liveWords } from './video/shorts.js';
import { setLive, liveCuts } from './video/live.js';
import { suggestRanking } from './video/ranking.js';
import { mountLicense, adminFromReq, hasAdmin } from './license.js';
import { mountThumbs } from './thumbs.js';
import { mountReport } from './report.js';
import { mountSocial, dueSocial } from './social.js';
import { generateScript, generateAdScript, generateMontageScript } from './video/composer.js';
import { authUrl, handleCallback, uploadVideo, youtubeConfigured, baseUrl } from './youtube.js';
import { analyzeChannel } from './analyzer.js';
import { preview as cleanupPreview, runCleanup } from './cleanup.js';
import { enqueue, drain, kick, ensureWorker, queueStatus, setBaseUrl } from './jobs.js';
import { STORAGE_MODE, saveFile, saveBuffer, publicUrl, readStream, removeFile, signedGetUrl, newKey, inputPath } from './storage.js';
import { s3Configured, presign, putBucketCors, S3 } from './s3.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
export const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '4mb' }));
app.use(cookieParser());
app.use((req, res, next) => { setBaseUrl(baseUrl(req)); next(); });

// ---------- Acceso con contraseña (APP_PASSWORD) ----------
// Opcional: sin APP_PASSWORD (o con APP_PASSWORD=off) la app abre directamente, sin pantalla de acceso.
const PASSWORD = /^(off|no|none|0|false)$/i.test(process.env.APP_PASSWORD || '') ? '' : (process.env.APP_PASSWORD || '');
// En Vercel no se abre nada sin la clave de cifrado de las claves API.
const SETUP_MISSING = IS_VERCEL ? [
  !process.env.APP_SECRET && 'APP_SECRET',
  !(process.env.DATABASE_URL || process.env.POSTGRES_URL) && 'DATABASE_URL', !(s3Configured() || process.env.BLOB_READ_WRITE_TOKEN) && 'ALMACENAMIENTO',
].filter(Boolean) : [];
const BLOCKED = SETUP_MISSING.includes('APP_SECRET');
const sign = v => crypto.createHmac('sha256', PASSWORD + internalSecret()).update(v).digest('hex');
// Servidor central (Vercel): solo entran los administradores del sistema de licencias.
// Servidor local (app de escritorio / instalación propia): la app ya comprobó la licencia; contraseña opcional (APP_PASSWORD).
const REQUIRE_LOGIN = IS_VERCEL || process.env.LICENSE_SERVER === '1';
const authed = async req => REQUIRE_LOGIN ? !!(await adminFromReq(req)) : (!PASSWORD || req.cookies.session === sign('ok'));
const h = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => { console.error(req.path, e.message); if (!res.headersSent) res.status(400).json({ error: e.message }); });

app.get('/api/me', h(async (req, res) => res.json({
  authed: !BLOCKED && await authed(req), passwordRequired: REQUIRE_LOGIN || !!PASSWORD, setup: SETUP_MISSING, blocked: BLOCKED,
  license: REQUIRE_LOGIN, needsAdmin: REQUIRE_LOGIN && !BLOCKED ? !(await hasAdmin()) : false,
  admin: REQUIRE_LOGIN ? (await adminFromReq(req))?.username || null : null,
  account: globalThis.__desktop?.license?.() || null,
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
app.post('/api/logout', (req, res) => { res.clearCookie('session'); res.clearCookie('adm'); res.json({ ok: true }); });
mountLicense(app, h);

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
  const work = Promise.all([runCleanup().catch(e => console.error('limpieza', e.message)), dueSocial().catch(e => console.error('redes', e.message))]);
  if (IS_VERCEL) (await import('@vercel/functions')).waitUntil(work);
  await workerEntry(req, res);
}));

app.use(['/api', '/files'], (req, res, next) => {
  // App de escritorio: sin licencia vigente no responde (ni desde el navegador)
  if (globalThis.__desktop && !globalThis.__desktop.licensed()) return res.status(403).json({ error: 'Licencia no válida. Inicia sesión en Clippers Pro.' });
  if (req.path === '/youtube/callback' || req.path === '/blob/upload' || ['/social/meta/callback', '/social/tiktok/callback'].includes(req.path)) return next();
  authed(req).then(ok => ok ? next() : res.status(401).json({ error: 'No autorizado' }), next);
});

// ---------- Subida de archivos ----------
const upload = multer({ dest: path.join(FILES_DIR, '.tmp'), limits: { fileSize: 8 * 1024 ** 3 } });
app.post('/api/upload', upload.single('file'), h(async (req, res) => {
  if (!req.file) throw new Error('No se recibió ningún archivo.');
  const ref = await saveFile(req.file.path, req.file.originalname.replace(/[^\w.-]+/g, '_'), req.file.mimetype);
  (await import('node:fs')).rmSync(req.file.path, { force: true });
  res.json({ ref, url: publicUrl(ref) });
}));
// App de escritorio: usar un archivo del propio equipo sin subirlo (se copia a la carpeta de la app; en APFS es instantáneo)
app.post('/api/upload-local', h(async (req, res) => {
  if (!globalThis.__desktop) throw new Error('Solo en la app de escritorio. (400)');
  const fsx = await import('node:fs');
  const src = String(req.body?.path || '');
  if (!path.isAbsolute(src) || !/\.(mp4|mov|m4v|mkv|webm|avi|mts|m2ts|ts|flv|wmv|3gp|mp3|m4a|wav|png|jpe?g|webp|gif|heic)$/i.test(src)) throw new Error('Tipo de archivo no admitido. (400)');
  const st = fsx.statSync(src, { throwIfNoEntry: false });
  if (!st?.isFile()) throw new Error('No se encontró el archivo en tu equipo. (400)');
  // Se copia en segundo plano (un vídeo grande, en iCloud o en un disco externo puede tardar) y se informa del progreso
  const id = crypto.randomBytes(6).toString('hex');
  const job = { pct: 0, done: false, error: null, ref: null, at: Date.now() };
  localCopies.set(id, job);
  (async () => {
    const name = path.basename(src).replace(/[^\w.-]+/g, '_');
    const isImg = /\.(png|jpe?g|webp|gif|heic)$/i.test(src);
    if (STORAGE_MODE === 'local') {
      const { copyLocal } = await import('./storage.js');
      const ref = `${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}_${name.slice(-80)}`;
      await copyLocal(src, path.join(FILES_DIR, ref), p => { job.pct = p; job.at = Date.now(); });
      job.ref = ref;
    } else job.ref = await saveFile(src, name, isImg ? 'image/' + src.split('.').pop().toLowerCase().replace('jpg', 'jpeg') : 'video/mp4');
    Object.assign(job, { pct: 100, done: true });
  })().catch(e => Object.assign(job, { done: true, error: /-81\b|ENEEDAUTH|EDEADLK|dataless/i.test(`${e.code} ${e.errno} ${e.message}`) ? 'El vídeo está en iCloud y no está descargado en el Mac. En el Finder: clic derecho → "Descargar ahora" (o cópialo a otra carpeta) y vuelve a intentarlo.' : /EPERM|EACCES/.test(e.code || e.message) ? 'macOS no deja a Clippers Pro leer esa carpeta. Dale permiso en Ajustes del Sistema → Privacidad y seguridad → Archivos y carpetas (o Acceso total al disco), o mueve el vídeo a otra carpeta.' : e.message }));
  res.json({ id });
}));
const localCopies = new Map();
app.get('/api/upload-local/:id', h(async (req, res) => {
  const job = localCopies.get(req.params.id);
  if (!job) throw new Error('Copia no encontrada. (404)');
  if (job.done) setTimeout(() => localCopies.delete(req.params.id), 60000);
  res.json({ ...job, url: job.ref ? publicUrl(job.ref) : null, idleSec: Math.round((Date.now() - job.at) / 1000) });
}));
// Subida directa del navegador a Vercel Blob (archivos grandes, sin pasar por la función)
app.post('/api/blob/upload', h(async (req, res) => {
  const { handleUpload } = await import('@vercel/blob/client');
  const isTokenRequest = req.body?.type === 'blob.generate-client-token';
  if (isTokenRequest && !(await authed(req))) return res.status(401).json({ error: 'No autorizado' });
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
  queue: await queueStatus(), youtube: await youtubeConfigured(), storage: STORAGE_MODE, db: DB_MODE, vercel: IS_VERCEL, desktop: !!globalThis.__desktop,
  ...(await (async () => { const lw = await import('./ai/localwhisper.js'), lm = await import('./ai/localmodels.js');
    const avail = lw.localAvailable() || lm.localLLMAvailable();
    return { localAvailable: avail, localReady: avail && (!lw.localAvailable() || lw.modelReady(await getSetting('whisper_model') || 'small')) && (!lm.localLLMAvailable() || lm.modelReady(await lm.currentLLMModel())) }; })()),
})));
// ---------- App de escritorio: conexión a la nube (R2/S3 y base de datos compartida con la web) ----------
const desk = () => globalThis.__desktop;
const mask = v => v ? v.slice(0, 4) + '…' + v.slice(-4) : '';
app.post('/api/desktop/logout', h(async (req, res) => { if (!globalThis.__desktop) return res.status(404).end(); res.json({ ok: true }); setTimeout(() => globalThis.__desktop.logout(), 100); }));
app.get('/api/desktop/cloud', h(async (req, res) => {
  if (!desk()) return res.status(404).json({ error: 'Solo en la app de escritorio' });
  const c = desk().getCloud();
  res.json({
    storage: STORAGE_MODE, db: DB_MODE, encrypted: desk().encrypted(),
    S3_ENDPOINT: c.S3_ENDPOINT || '', S3_BUCKET: c.S3_BUCKET || '', S3_REGION: c.S3_REGION || '', S3_ACCESS_KEY_ID: mask(c.S3_ACCESS_KEY_ID),
    hasSecret: !!c.S3_SECRET_ACCESS_KEY, hasDb: !!c.DATABASE_URL, dbHost: (c.DATABASE_URL || '').match(/@([^/:?]+)/)?.[1] || '', hasAppSecret: !!c.APP_SECRET,
  });
}));
app.post('/api/desktop/cloud', h(async (req, res) => {
  if (!desk()) return res.status(404).json({ error: 'Solo en la app de escritorio' });
  const b = req.body || {};
  if (b.disable) { desk().saveCloud({}); desk().relaunch(); return res.json({ ok: true, restarting: true }); }
  const old = desk().getCloud();
  const keep = (k, v) => (v == null || v === '' || String(v).includes('…')) ? old[k] : String(v).trim();
  const cfg = {
    S3_ENDPOINT: keep('S3_ENDPOINT', b.S3_ENDPOINT)?.replace(/\/+$/, ''), S3_BUCKET: keep('S3_BUCKET', b.S3_BUCKET), S3_REGION: b.S3_REGION?.trim() || '',
    S3_ACCESS_KEY_ID: keep('S3_ACCESS_KEY_ID', b.S3_ACCESS_KEY_ID), S3_SECRET_ACCESS_KEY: keep('S3_SECRET_ACCESS_KEY', b.S3_SECRET_ACCESS_KEY),
    DATABASE_URL: b.removeDb ? '' : keep('DATABASE_URL', b.DATABASE_URL), APP_SECRET: b.removeDb ? '' : keep('APP_SECRET', b.APP_SECRET),
  };
  if (!cfg.S3_ENDPOINT || !cfg.S3_BUCKET || !cfg.S3_ACCESS_KEY_ID || !cfg.S3_SECRET_ACCESS_KEY) throw new Error('Rellena el endpoint, el bucket, el Access Key ID y el Secret Access Key.');
  if (!/^https:\/\//.test(cfg.S3_ENDPOINT)) throw new Error('El endpoint debe empezar por https:// (p. ej. https://<cuenta>.r2.cloudflarestorage.com).');
  if (cfg.DATABASE_URL && !cfg.APP_SECRET) throw new Error('Para compartir la base de datos con la web pega también tu APP_SECRET de Vercel (con él se descifran tus claves API).');
  // Prueba de escritura y borrado en el bucket con la configuración nueva
  const { S3, putObject, deleteObject } = await import('./s3.js');
  const prev = { ...S3 };
  Object.assign(S3, { endpoint: cfg.S3_ENDPOINT, bucket: cfg.S3_BUCKET, accessKeyId: cfg.S3_ACCESS_KEY_ID, secretAccessKey: cfg.S3_SECRET_ACCESS_KEY, region: cfg.S3_REGION || 'auto' });
  try {
    const key = `.clipperspro-test-${Date.now()}.txt`;
    await putObject(key, Buffer.from('ok'), { contentType: 'text/plain', size: 2 });
    await deleteObject(key).catch(() => {});
  } catch (e) { throw new Error('No se pudo escribir en el bucket: ' + e.message); }
  finally { Object.assign(S3, prev); }
  // Prueba de la base de datos
  if (cfg.DATABASE_URL) {
    const pg = (await import('pg')).default;
    const url = cfg.DATABASE_URL.replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/[?&]$/, '');
    const c = new pg.Client({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
    try { await c.connect(); await c.query('SELECT 1'); } catch (e) { throw new Error('No se pudo conectar a la base de datos: ' + e.message); }
    finally { c.end().catch(() => {}); }
  }
  desk().saveCloud(cfg);
  desk().relaunch();
  res.json({ ok: true, restarting: true });
}));
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
app.put('/api/settings', h(async (req, res) => {
  const b = req.body || {};
  await setSettings(b);
  // Cambió la IA local (modelo, tarjeta gráfica o local/nube): se reinicia y se vuelve a precargar
  if (['local_llm', 'use_cloud'].some(k => k in b)) {
    const lm = await import('./ai/localmodels.js');
    lm.restartLocalLLM();
    if ((await getSetting('llm_provider')) === 'local') setTimeout(() => lm.warmUp(), 500);
  }
  res.json(await publicSettings());
}));
// Modo de la IA (local / nube): visible en toda la app y se cambia con un clic
app.get('/api/ai-mode', h(async (req, res) => res.json(await aiMode())));
app.post('/api/ai-mode', h(async (req, res) => {
  const cloud = req.body?.mode === 'cloud';
  await setSettings({ use_cloud: cloud ? '1' : '0' });
  const lm = await import('./ai/localmodels.js');
  lm.restartLocalLLM();
  if (!cloud) setTimeout(() => lm.warmUp(), 500);
  res.json(await aiMode());
}));
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
app.get('/api/youtube/auth', async (req, res) => {
  try { res.redirect(await authUrl(req, req.query.channel)); }
  catch (e) { res.redirect('/#/canales?error=' + encodeURIComponent(e.message)); } // nunca una página de error sin salida
});
// En la app de escritorio el inicio de sesión ocurre en el navegador del sistema (Safari, Chrome…):
// ahí se muestra una página sencilla y la app detecta sola que el canal ya está conectado.
const oauthPage = (ok, msg) => `<!doctype html><meta charset="utf-8"><title>Clippers Pro</title>
<body style="font-family:system-ui,-apple-system,sans-serif;background:#0f1013;color:#eee;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center;max-width:480px;padding:24px"><div style="font-size:48px">${ok ? '✅' : '⚠️'}</div>
<h2>${ok ? 'Canal de YouTube conectado' : 'No se pudo conectar el canal'}</h2>
<p style="color:#aaa">${ok ? 'Ya puedes cerrar esta pestaña y volver a Clippers Pro.' : msg.replace(/[<>&]/g, '')}</p></div></body>`;
app.get('/api/youtube/callback', async (req, res) => {
  const desktop = !!globalThis.__desktop;
  try {
    if (req.query.error) throw new Error(req.query.error === 'access_denied' ? 'Cancelaste el permiso en Google o tu cuenta no está como usuario de prueba en la pantalla de consentimiento.' : 'Google: ' + req.query.error);
    await handleCallback(req);
    desktop ? res.send(oauthPage(true)) : res.redirect('/#/canales?ok=1');
  } catch (e) { desktop ? res.status(400).send(oauthPage(false, e.message)) : res.redirect('/#/canales?error=' + encodeURIComponent(e.message)); }
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
  const multi = req.query.multi === '1' ? "AND data->'options' ? 'multi'" : req.query.type === 'shorts' ? "AND NOT (data->'options' ? 'multi')" : '';
  const params = req.query.type ? [req.query.type] : [];
  const rows = await q(`SELECT p.id, p.type, p.title, p.status, p.progress, p.error, p.created_at, p.duration, p.output, p.percent,
      (SELECT ROUND(55 + 0.45 * AVG(CASE WHEN c.status = 'rendering' THEN COALESCE(c.progress, 0) ELSE 100 END))::int FROM clips c WHERE c.project_id = p.id) AS clip_percent,
      (SELECT COUNT(*)::int FROM clips c WHERE c.project_id = p.id AND c.status = 'rendering') AS rendering,
      (SELECT COUNT(*)::int FROM clips c WHERE c.project_id = p.id AND c.status = 'ready') ready_clips
    FROM projects p WHERE deleted_at IS ${trash ? 'NOT ' : ''}NULL ${req.query.type ? 'AND type = $1' : ''} ${multi} ORDER BY id DESC LIMIT 200`, params);
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
  // Datos para la línea de tiempo del resumen (energía del audio reducida a ≤ 600 puntos)
  const en = p.data.transcript?.energy || [];
  const step = Math.max(1, Math.ceil(en.length / 600));
  const timeline = en.length ? { energy: en.filter((_, i) => i % step === 0).map(e => [e.t, +Math.max(0, Math.min(1, ((e.db ?? -90) + 60) / 60)).toFixed(3)]), cuts: (p.data.cuts || []).slice(0, 400) } : null;
  res.json({ ...projectOut(p), percent: projectPercent(p, clips), cleanup, live, timeline, clips: clips.map(clipOut),
    framesOut: (p.data.frames || []).map(f => ({ ...f, url: publicUrl(f.ref) })) });
}));
// Ventana "Descargar desde un link": información del vídeo, calidades y tamaño aproximado
app.post('/api/link/info', h(async (req, res) => {
  if (IS_VERCEL) throw new Error('Descargar desde enlaces solo está disponible en la app de escritorio. (400)');
  const url = String(req.body?.url || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('Pega un enlace válido (https://…).');
  const { linkInfo } = await import('./video/ytdlp.js');
  res.json(await linkInfo(url));
}));

// Descarga sola (sin analizar): el vídeo queda guardado y la página "Convertir a Shorts" lo usa como origen
const linkDownloads = new Map(); // id -> { pct, text, gotMB, totalMB, speed, done, error, ref, title, ac }
app.post('/api/link/download', h(async (req, res) => {
  if (IS_VERCEL) throw new Error('Descargar desde enlaces solo está disponible en la app de escritorio. (400)');
  const b = req.body || {};
  const url = String(b.url || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('Pega un enlace válido (https://…).');
  const { downloadVideo } = await import('./video/ytdlp.js');
  const id = crypto.randomBytes(6).toString('hex');
  const st = { pct: 0, text: 'Preparando la descarga…', done: false, error: null, ref: null, title: String(b.title || ''), ac: new AbortController(), at: Date.now() };
  linkDownloads.set(id, st);
  for (const [k, v] of linkDownloads) if (v.done && Date.now() - v.at > 3600e3) linkDownloads.delete(k);
  const from = Number(b.from) > 0 ? Number(b.from) : 0, to = Number(b.to) > from ? Number(b.to) : 0;
  (async () => {
    const file = await downloadVideo(url, WORK_DIR, `link_${id}`, (pct, text, extra) => Object.assign(st, { pct: Math.round(pct), text, ...(extra || {}) }),
      { height: Math.min(2160, Math.max(144, Number(b.height) || 1080)), from, to, estMB: Number(b.estMB) || 0, signal: st.ac.signal });
    st.text = 'Guardando el vídeo…'; st.pct = 100;
    st.ref = await saveFile(file, `source_${id}.mp4`);
    fs.rmSync(file, { force: true });
    Object.assign(st, { done: true, text: 'Descargado', at: Date.now() });
  })().catch(e => Object.assign(st, { done: true, error: e.cancelled ? 'Descarga cancelada.' : e.message, at: Date.now() }));
  res.json({ id });
}));
app.get('/api/link/download/:id', h(async (req, res) => {
  const st = linkDownloads.get(req.params.id);
  if (!st) throw new Error('Descarga no encontrada. (404)');
  const { ac, ...rest } = st;
  res.json({ ...rest, url: st.ref ? publicUrl(st.ref) : null });
}));
app.post('/api/link/download/:id/cancel', h(async (req, res) => {
  const st = linkDownloads.get(req.params.id);
  if (st && !st.done) st.ac.abort();
  res.json({ ok: true });
}));
app.post('/api/projects/:id/cancel', h(async (req, res) => {
  const { activeDownloads } = await import('./video/shorts.js');
  const id = Number(req.params.id);
  activeDownloads.get(id)?.abort();
  await q("UPDATE jobs SET status = 'failed', error = 'Cancelado' WHERE status IN ('queued','running') AND payload->>'id' = $1", [String(id)]);
  await updateProject(id, { status: 'error', error: 'Descarga cancelada.', progress: null });
  res.json({ ok: true });
}));
// Edición automática (cortar retomas/silencios, volumen parejo, música): opciones comunes de los proyectos de clips
function autoEditOptions(b) {
  return {
    cutRetakes: b.cutRetakes === true, condense: b.cutRetakes === true && b.condense === true, cutSilence: b.cutSilence === true, normalize: b.normalize === true,
    music: typeof b.music === 'string' && b.music && b.music.length < 400 && !/[\s"']/.test(b.music) ? b.music : null,
    musicVolume: Math.max(0.02, Math.min(1, Number(b.musicVolume) || 0.18)),
  };
}
app.post('/api/shorts', h(async (req, res) => {
  const b = req.body;
  if (!b.source && !b.url) throw new Error('Sube un vídeo o pega un enlace.');
  const dl = b.download || {};
  const options = {
    download: b.url ? { height: Math.min(2160, Math.max(144, Number(dl.height) || 1080)), from: Number(dl.from) > 0 ? Number(dl.from) : 0,
      to: Number(dl.to) > Number(dl.from || 0) ? Number(dl.to) : 0, estMB: Number(dl.estMB) || 0 } : undefined,
    count: Math.min(30, Number(b.count) || 10), minSec: Number(b.minSec) || 20, maxSec: Number(b.maxSec) || 60,
    layout: ['crop', 'blur', 'face', 'gaming'].includes(b.layout) ? b.layout : 'face', language: b.language || '', titleLanguage: b.titleLanguage || '',
    captions: b.captions !== false, captionStyle: CAPTION_STYLES[b.captionStyle] ? b.captionStyle : 'clasico', emojis: b.emojis !== false, brand: b.brand === true, ...autoEditOptions(b),
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
    layout: ['crop', 'blur', 'face', 'gaming'].includes(b.layout) ? b.layout : 'face', captionStyle: CAPTION_STYLES[b.captionStyle] ? b.captionStyle : 'impacto',
    emojis: b.emojis !== false, captions: b.captions !== false, language: b.language || '', titleLanguage: b.titleLanguage || '', brand: b.brand === true, ...autoEditOptions(b),
    minScore: Math.min(10, Math.max(1, Number(b.minScore) || 7)), minSec: Number(b.minSec) || 15, maxSec: Number(b.maxSec) || 60,
    segmentSec: Math.min(240, Math.max(Number(process.env.LIVE_MIN_SEGMENT) || 60, Number(b.segmentSec) || 180)), maxMinutes: Math.min(600, Math.max(5, Number(b.maxMinutes) || 120)),
    perSegment: Math.min(10, Math.max(1, Number(b.perSegment) || 3)), clipMode: ['auto', 'smart'].includes(b.clipMode) ? b.clipMode : 'manual', batchEvery: Math.max(5, Math.min(60, Number(b.batchEvery) || 10)),
  };
  const p = await insert('projects', { type: 'live', title: b.title || `Directo${platform ? ' de ' + platform : ''} ${url.split('/').filter(Boolean).pop()?.split('?')[0] || ''} · ${new Date().toLocaleDateString('es')}`, channel_id: Number(b.channel_id) || null,
    source_url: url, status: 'processing', data: { options, live: {} }, progress: '🔴 Conectando con el directo…' });
  await enqueue('live.capture', { id: p.id, seg: 0 });
  res.json({ id: p.id });
}));
// Reproductor de directos .m3u8: la lista y sus segmentos pasan por aquí (mismo origen, sin problemas de CORS).
// Solo se sirven hosts del enlace del proyecto o que aparecen en sus propias listas.
const hlsHosts = new Map(); // id → Set(hosts permitidos)
app.get('/api/projects/:id/hls', h(async (req, res) => {
  const p = await getProject(req.params.id);
  if (p?.type !== 'live' || !/\.m3u8(\?|$)/i.test(p.source_url || '')) return res.status(404).end();
  let u;
  try { u = new URL(String(req.query.u || p.source_url)); } catch { return res.status(400).end(); }
  const allowed = hlsHosts.get(p.id) || new Set([new URL(p.source_url).host]);
  hlsHosts.set(p.id, allowed);
  if (!/^https?:$/.test(u.protocol) || !allowed.has(u.host)) return res.status(403).end();
  const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) return res.status(r.status).end();
  const ctype = r.headers.get('content-type') || '';
  if (/mpegurl/i.test(ctype) || /\.m3u8(\?|$)/i.test(u.pathname)) {
    const base = r.url || u.href;
    const prox = x => { const abs = new URL(x, base); allowed.add(abs.host); return `/api/projects/${p.id}/hls?u=${encodeURIComponent(abs.href)}`; };
    const text = (await r.text()).split(/\r?\n/).map(l => !l ? l : l.startsWith('#') ? l.replace(/URI="([^"]+)"/, (_, x) => `URI="${prox(x)}"`) : prox(l.trim())).join('\n');
    res.set({ 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-cache' }).send(text);
  } else {
    res.set({ 'content-type': ctype || 'video/mp2t', 'cache-control': 'max-age=60' });
    res.send(Buffer.from(await r.arrayBuffer()));
  }
}));
// Directo: "✂ Clip ahora" (los últimos N segundos) y ajustes mientras graba
app.post('/api/projects/:id/mark', h(async (req, res) => {
  const p = await getProject(req.params.id);
  const l = p.data.live;
  if (!l || l.ended || l.stopRequested) throw new Error('El directo no está grabando.');
  const t = l.recWall ? (l.recPos || 0) + (Date.now() - l.recWall) / 1000 : (p.duration || 0);
  const len = Math.min(120, Math.max(10, Number(req.body?.len) || 45));
  await setLive(p.id, { marks: [...(l.marks || []), { t, len, at: Date.now(), done: false }] });
  liveCuts.add(p.id); // corta el segmento en curso ya: el clip sale en cuanto se transcriba ese trozo
  res.json({ t, len });
}));
// "✂ Hacer clips": corta lo grabado ahora y busca los clips de todo el tramo desde la tanda anterior; la grabación sigue
app.post('/api/projects/:id/make-clips', h(async (req, res) => {
  const p = await getProject(req.params.id);
  const l = p.data.live;
  if (!l || l.ended || l.stopRequested) throw new Error('El directo no está grabando.');
  if (l.batchAt) return res.json({ ok: true, already: true });
  await setLive(p.id, { batchAt: Date.now() });
  liveCuts.add(p.id);
  res.json({ ok: true });
}));
app.patch('/api/projects/:id/live-options', h(async (req, res) => {
  const b = req.body || {}, patch = {};
  if (b.minScore != null) patch.minScore = Math.min(10, Math.max(1, Number(b.minScore) || 7));
  if (b.perSegment != null) patch.perSegment = Math.min(10, Math.max(1, Number(b.perSegment) || 3));
  if (b.batchEvery != null) patch.batchEvery = Math.max(5, Math.min(60, Number(b.batchEvery) || 10));
  if (b.clipMode != null && ['manual', 'smart'].includes(b.clipMode)) patch.clipMode = b.clipMode;
  await q(`UPDATE projects SET data = jsonb_set(data, '{options}', COALESCE(data->'options', '{}'::jsonb) || $2::jsonb, true) WHERE id = $1`, [req.params.id, JSON.stringify(patch)]);
  res.json({ ok: true, ...patch });
}));
app.post('/api/projects/:id/stop', h(async (req, res) => {
  const p = await getProject(req.params.id);
  if (p?.type !== 'live') throw new Error('Solo se pueden detener directos.');
  await setLive(p.id, { stopRequested: true });
  liveCuts.add(p.id); // se corta ya el segmento en curso (no se espera a que termine)
  await updateProject(p.id, { progress: '⏹ Deteniendo: se analizan los últimos momentos…' });
  res.json({ ok: true });
}));

// IA local: estado y descarga de modelos (Whisper, Qwen, DreamShaper)
app.get('/api/local-models', h(async (req, res) => {
  const lw = await import('./ai/localwhisper.js'), lm = await import('./ai/localmodels.js');
  const wm = await getSetting('whisper_model') || 'small';
  const available = lw.localAvailable() || lm.localLLMAvailable() || lm.localImageAvailable();
  const models = [];
  if (lw.localAvailable()) models.push({ kind: 'whisper', id: wm, label: `Whisper ${wm}`, use: 'Transcripción (voz → texto con tiempos por palabra)', mb: lw.WHISPER_MODELS[wm]?.mb || 466, ready: lw.modelReady(wm), download: lw.downloadStatus(wm) });
  if (lm.localLLMAvailable()) { const id = await lm.currentLLMModel(), m = lm.LOCAL_MODELS[id]; models.push({ kind: 'llm', id, label: m.label.split(' (')[0], use: 'IA de texto: momentos virales, títulos, descripciones, informe y preguntas', mb: m.mb, ready: lm.modelReady(id), download: lm.downloadStatus(id) }); }
  if (lm.localImageAvailable()) { const id = lm.DEFAULT_IMAGE_MODEL, m = lm.LOCAL_MODELS[id]; models.push({ kind: 'image', id, label: m.label.split(' (')[0], use: 'Imágenes de fondo para miniaturas', mb: m.mb, ready: lm.modelReady(id), download: lm.downloadStatus(id) }); }
  res.json({ available, models });
}));
app.post('/api/local-models/download', h(async (req, res) => {
  const { kind, id } = req.body || {};
  if (kind === 'whisper') (await import('./ai/localwhisper.js')).ensureModel(String(id)).catch(e => console.error('modelo:', e.message));
  else (await import('./ai/localmodels.js')).ensureModel(String(id)).catch(e => console.error('modelo:', e.message));
  res.json({ ok: true });
}));

// Transcripción local (whisper.cpp)
app.get('/api/whisper', h(async (req, res) => {
  const lw = await import('./ai/localwhisper.js');
  const { transcribeProvider } = await import('./ai/transcribe.js');
  res.json({ available: lw.localAvailable(), provider: await transcribeProvider(), model: await getSetting('whisper_model'),
    models: Object.fromEntries(Object.entries(lw.WHISPER_MODELS).map(([k, m]) => [k, { label: m.label, ready: lw.modelReady(k), download: lw.downloadStatus(k) }])) });
}));
app.post('/api/whisper/download', h(async (req, res) => {
  const lw = await import('./ai/localwhisper.js');
  if (!lw.localAvailable()) throw new Error('La transcripción local solo está en la app de escritorio.');
  lw.ensureModel(String(req.body?.model || 'small')).catch(e => console.error('modelo whisper:', e.message));
  res.json({ ok: true });
}));

// Miniaturas y portadas con IA
mountThumbs(app, h);
// Informe del vídeo (títulos, SEO, capítulos, mejoras, fotogramas, transcripción, preguntas)
mountReport(app, h);
mountSocial(app, h);

// Rankings ("Top 5 momentos…"): clips en cuenta atrás con números y etiquetas
app.get('/api/ranking/search', h(async (req, res) => {
  if (IS_VERCEL) throw new Error('La búsqueda de vídeos solo está disponible en la app de escritorio (YouTube bloquea los servidores en la nube). (400)');
  const { searchShorts } = await import('./video/ytdlp.js');
  res.json(await searchShorts(req.query.q, { n: Math.min(40, Number(req.query.n) || 24) }));
}));
app.post('/api/ranking/suggest', h(async (req, res) => res.json(await suggestRanking(req.body || {}))));
// Biblioteca de clips ya creados (para usarlos en un ranking)
app.get('/api/clips/library', h(async (req, res) => {
  const rows = await q(`SELECT c.id, c.title, c.hook, c.file, c.start, c."end", c.score, p.title AS project FROM clips c JOIN projects p ON p.id = c.project_id
    WHERE c.status = 'ready' AND c.file IS NOT NULL AND p.deleted_at IS NULL ORDER BY c.id DESC LIMIT 80`);
  res.json(rows.map(c => ({ ...c, url: publicUrl(c.file), dur: +(c.end - c.start).toFixed(1) })));
}));
app.post('/api/ranking', h(async (req, res) => {
  const b = req.body || {};
  const items = (b.items || []).map(it => ({ source: it.source || null, url: String(it.url || '').trim() || null, label: String(it.label || '').slice(0, 60),
    start: Number(it.start) || 0, end: Number(it.end) || 0 })).filter(it => it.source || it.url);
  if (items.length < 2) throw new Error('Añade al menos 2 clips al ranking.');
  if (items.length > 10) throw new Error('Máximo 10 puestos.');
  if (!String(b.title || '').trim()) throw new Error('Escribe el título del ranking.');
  const options = {
    title: String(b.title).slice(0, 80), bottom: String(b.bottom || '').slice(0, 80), items,
    order: b.order === 'asc' ? 'asc' : 'countdown', fit: ['fill', 'blur', 'auto'].includes(b.fit) ? b.fit : 'auto',
    highlight: /^#[0-9a-f]{6}$/i.test(b.highlight || '') ? b.highlight : '#FFD400', background: /^#[0-9a-f]{6}$/i.test(b.background || '') ? b.background : '#000000',
    maxClipSec: Math.min(60, Math.max(2, Number(b.maxClipSec) || 15)), keepAudio: b.keepAudio !== false,
    cta: String(b.cta || '').slice(0, 60), flash: b.flash !== false,
  };
  const script = b.yt_title ? { title: b.yt_title, description: b.description || '', tags: b.tags || [] } : null;
  const p = await insert('projects', { type: 'ranking', title: b.projectTitle || options.title.replace(/\*/g, ''), channel_id: Number(b.channel_id) || null,
    status: 'pending', data: { options, parts: [], ...(script ? { script } : {}) }, progress: 'En cola…' });
  await enqueue('ranking.prep', { id: p.id, i: 0 });
  res.json({ id: p.id });
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
  // Origen descargado sin imagen (solo audio): se borra y el proyecto empieza de nuevo (se vuelve a descargar)
  if (p.type === 'shorts' && p.source && p.source_url && !(await probe(inputPath(p.source)).catch(() => ({ hasVideo: true }))).hasVideo) {
    await q('DELETE FROM clips WHERE project_id = $1', [p.id]);
    await updateProject(p.id, { status: 'pending', error: null, progress: 'Volviendo a descargar el vídeo (el anterior no tenía imagen)…', percent: 0 });
    await enqueue('shorts.start', { id: p.id });
    return res.json({ ok: true, restarted: true });
  }
  if ((p.type === 'shorts' && p.data.transcript?.words?.length || p.type === 'live') && failed.length) {
    await updateProject(p.id, { status: 'processing', error: null, progress: `Renderizando ${failed.length} clips…` });
    for (const c of failed) {
      await updateClip(c.id, { status: 'rendering', error: null, progress: 0, stage: 'En cola…' });
      await enqueue('clip.render', { clipId: c.id });
    }
    return res.json({ ok: true, clips: failed.length });
  }
  await updateProject(p.id, { status: 'pending', error: null, progress: 'En cola…', percent: 0 });
  if (p.type === 'ranking') { // continúa por el primer clip sin preparar (o monta de nuevo si ya están todos)
    const parts = p.data.parts || [], n = p.data.options.items.length;
    const i = [...Array(n).keys()].find(k => !parts[k]);
    await enqueue(i == null ? 'ranking.render' : 'ranking.prep', { id: p.id, i: i ?? 0 });
    return res.json({ ok: true });
  }
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
// ---------- Editor de clips ----------
// Segmentos de un directo que cubren [from, to]: uno solo se usa tal cual; varios se unen (sin recodificar) y se guarda el resultado
async function liveSegs(projectId, from, to) {
  return q('SELECT seg, ref, start, dur FROM live_segments WHERE project_id = $1 AND start < $3 AND start + dur > $2 AND ref IS NOT NULL ORDER BY seg', [projectId, from, to]);
}
async function liveEditSource(p, from, to) {
  const segs = await liveSegs(p.id, from, to);
  if (!segs.length) return null;
  // los segmentos deben ser consecutivos (si falta uno, se usa el tramo continuo más largo)
  const out = { ref: segs[0].ref, from: segs[0].start, to: segs[0].start + segs[0].dur };
  if (segs.length === 1) return out;
  const key = segs.map(s => s.seg).join('-');
  const cache = p.data.liveEdit?.[key];
  if (cache) return { ref: cache, from: segs[0].start, to: segs.at(-1).start + segs.at(-1).dur };
  const tag = `liveedit_${p.id}_${key}_${Date.now()}`, list = path.join(WORK_DIR, tag + '.txt'), file = path.join(WORK_DIR, tag + '.mp4');
  const { localUrl } = await import('./video/netproxy.js');
  try {
    const inputs = [];
    for (const s of segs) inputs.push(await localUrl(inputPath(s.ref)));
    fs.writeFileSync(list, inputs.map(f => `file '${String(f).replace(/'/g, "'\\''")}'`).join('\n'));
    await run(FFMPEG, ['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-protocol_whitelist', 'file,http,https,tcp,tls,crypto', '-i', list, '-c', 'copy', '-movflags', '+faststart', file], { timeoutMs: 180000 });
    const ref = await saveFile(file, tag + '.mp4');
    await q(`UPDATE projects SET data = jsonb_set(data, '{liveEdit}', COALESCE(data->'liveEdit', '{}'::jsonb) || $2::jsonb) WHERE id = $1`, [p.id, JSON.stringify({ [key]: ref })]);
    return { ref, from: segs[0].start, to: segs.at(-1).start + segs.at(-1).dur };
  } catch (e) {
    console.warn('[editor directo] no se pudieron unir los segmentos:', e.message);
    // sin unir: el segmento donde está la mayor parte del clip
    return out;
  } finally { for (const f of [list, file]) fs.rmSync(f, { force: true }); }
}
// Modelos disponibles de un proveedor de IA (para elegir en Ajustes sin escribir el nombre a mano)
app.get('/api/ai-models/:provider', h(async (req, res) => {
  const p = req.params.provider;
  if (!['openai', 'groq', 'openrouter'].includes(p)) return res.json({ models: [] });
  const key = await getSetting(p + '_key');
  if (!key) return res.json({ models: [], error: 'Primero pega la clave de ' + p + '.' });
  const { providerModels } = await import('./ai/llm.js');
  res.json({ models: await providerModels(p, key) });
}));
app.get('/api/clips/:id/editor', h(async (req, res) => {
  const c = await getClip(req.params.id);
  if (!c) return res.status(404).json({ error: 'No existe' });
  const p = await getProject(c.project_id);
  const dur = p.duration || 0;
  const pad = Math.max(20, (c.end - c.start) * 0.6);
  let from = Math.max(0, c.start - pad), to = Math.min(dur || c.end + pad, c.end + pad);
  const E = c.edit || {};
  // Directos: el editor trabaja sobre los segmentos grabados alrededor del clip (unidos en un solo vídeo si son varios)
  const live = p.type === 'live' ? await liveEditSource(p, from, to) : null;
  if (live) { from = Math.max(from, live.from); to = Math.min(to, live.to); }
  let words = (live ? await liveWords(p.id, from, to) : (p.data.transcript?.words || [])).filter(w => w.end > from && w.start < to);
  if (E.words) words = [...words.filter(w => w.end <= E.wordsFrom || w.start >= E.wordsTo), ...E.words].filter(w => w.end > from && w.start < to).sort((a, b) => a.start - b.start);
  // Encuadre automático ya calculado (centros normalizados, tiempos absolutos)
  const W = p.data.width || 1920, H = p.data.height || 1080;
  const plan = c.track?.plan;
  // Fotogramas por segundo del vídeo (para avanzar fotograma a fotograma con las flechas); se guarda en el proyecto
  let fps = Number(p.data.fps) || 0;
  if (!fps) {
    const ref = live ? live.ref : p.source;
    fps = ref ? (await probe(inputPath(ref)).catch(() => ({}))).fps || 0 : 0;
    if (fps) await q(`UPDATE projects SET data = data || $2::jsonb WHERE id = $1`, [p.id, JSON.stringify({ fps })]).catch(() => {});
  }
  const autoKeys = plan?.keys ? plan.keys.map(k => ({ t: c.track.start + k.t, cx: (k.x + plan.cw / 2) / W, cut: !!k.cut })) : null;
  res.json({
    autocut: { silence: E.autocut?.silence ?? !!p.data.options?.cutSilence, retakes: E.autocut?.retakes ?? !!p.data.options?.cutRetakes, condense: E.autocut?.condense ?? !!p.data.options?.condense, cuts: Array.isArray(c.keep) ? Math.max(0, c.keep.length - 1) : null },
    brand: await (await import('./brand.js')).getBrand().then(b => ({ logoUrl: b.logoUrl, frameUrl: b.frameUrl, pos: b.pos, size: b.size, opacity: b.opacity, on: E.brand ?? !!p.data.options?.brand })),
    clip: clipOut(c), edit: E, window: { from, to }, words, autoKeys, facecam: E.facecam || p.data.facecam?.rect || null,
    project: { id: p.id, title: p.title, width: W, height: H, duration: dur, fps: fps || 30, sourceUrl: live ? publicUrl(live.ref) : publicUrl(p.source), timeOffset: live ? live.from : 0, sourceDeleted: !!p.data.sourceDeletedAt || (p.type === 'live' && !live), captionStyle: p.data.options?.captionStyle },
    highlight: await getSetting('caption_color') || '#FFD400', styles: Object.fromEntries(Object.entries(CAPTION_STYLES).map(([k, v]) => [k, v])),
  });
}));
// Forma de onda del audio entre dos instantes (para la línea de tiempo del editor)
app.get('/api/projects/:id/waveform', h(async (req, res) => {
  const p = await getProject(req.params.id);
  const from = Math.max(0, Number(req.query.from) || 0), to = Math.max(from + 1, Number(req.query.to) || from + 60);
  const n = Math.min(3000, Math.max(100, Number(req.query.n) || 1000));
  const { FFMPEG: FF } = await import('./video/ffmpeg.js');
  const os = await import('node:os');
  const { spawn } = await import('node:child_process');
  const { localUrl } = await import('./video/netproxy.js');
  // Directos: el audio sale del vídeo que usa el editor para ese clip
  let src = p.source, off = 0;
  if (p.type === 'live') {
    const lv = await liveEditSource(p, from, to);
    if (!lv) return res.json({ from, to, peaks: [] });
    src = lv.ref; off = lv.from;
  }
  const input = await localUrl(inputPath(src));
  const rate = 4000;
  const pcm = await new Promise((resolve, reject) => {
    const pr = spawn(FF, ['-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, from - off)), '-t', String(to - from), '-i', input, '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', 'pipe:1'],
      { env: { ...process.env, GCONV_PATH: path.join(os.tmpdir(), 'faceless-gconv-empty') } });
    const ch = []; pr.stdout.on('data', d => ch.push(d)); pr.on('error', reject); pr.on('close', () => resolve(Buffer.concat(ch)));
  });
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  const per = Math.max(1, Math.floor(samples.length / n));
  const peaks = [];
  for (let i = 0; i < samples.length; i += per) { let m = 0; for (let j = i; j < i + per && j < samples.length; j++) { const v = Math.abs(samples[j]); if (v > m) m = v; } peaks.push(+(m / 32768).toFixed(3)); }
  res.json({ from, to, peaks });
}));
app.put('/api/clips/:id/edit', h(async (req, res) => {
  const c = await getClip(req.params.id);
  const b = req.body || {};
  const num = (v, a, z, d) => { const x = Number(v); return Number.isFinite(x) ? Math.max(a, Math.min(z, x)) : d; };
  const start = num(b.start, 0, 1e7, c.start), end = num(b.end, 0, 1e7, c.end);
  if (end - start < 2) throw new Error('El clip debe durar al menos 2 segundos.');
  const words = Array.isArray(b.words) ? b.words.filter(w => w && String(w.word || '').trim()).slice(0, 5000)
    .map(w => ({ word: String(w.word).slice(0, 60), start: Number(w.start), end: Number(w.end) })).filter(w => Number.isFinite(w.start) && Number.isFinite(w.end)) : null;
  const edit = {
    format: ['v', 'sq', 'p45'].includes(b.format) ? b.format : 'v',
    layout: ['face', 'crop', 'blur', 'gaming'].includes(b.layout) ? b.layout : c.layout,
    ...(b.facecam && ['x', 'y', 'w', 'h'].every(k => Number.isFinite(Number(b.facecam[k]))) ? { facecam: Object.fromEntries(['x', 'y', 'w', 'h'].map(k => [k, num(b.facecam[k], 0, 1, 0)])) } : {}),
    crop: { mode: ['face', 'manual', 'fixed'].includes(b.crop?.mode) ? b.crop.mode : 'face', zoom: num(b.crop?.zoom, 1, 3, 1), cx: num(b.crop?.cx, 0, 1, 0.5), cy: num(b.crop?.cy, 0, 1, 0.5),
      keys: (b.crop?.keys || []).slice(0, 500).map(k => ({ t: num(k.t, 0, 1e7, 0), cx: num(k.cx, 0, 1, 0.5), cut: !!k.cut })) },
    captions: { show: b.captions?.show !== false, style: CAPTION_STYLES[b.captions?.style] ? b.captions.style : (c.style || 'impacto'), size: num(b.captions?.size, 0.5, 2, 1),
      y: num(b.captions?.y, 0.1, 0.95, null), color: /^#[0-9a-f]{6}$/i.test(b.captions?.color || '') ? b.captions.color : null, upper: b.captions?.upper == null ? null : !!b.captions.upper, wpg: num(b.captions?.wpg, 1, 8, null) },
    ...(b.autocut && typeof b.autocut === 'object' ? { autocut: { silence: !!b.autocut.silence, retakes: !!b.autocut.retakes, condense: !!b.autocut.retakes && !!b.autocut.condense } } : c.edit?.autocut ? { autocut: c.edit.autocut } : {}),
    hookOn: b.hookOn !== false, emojis: b.emojis !== false, ...(typeof b.brand === 'boolean' ? { brand: b.brand } : c.edit?.brand != null ? { brand: c.edit.brand } : {}),
    ...(words ? { words, wordsFrom: num(b.wordsFrom, 0, 1e7, start), wordsTo: num(b.wordsTo, 0, 1e7, end) } : (c.edit?.words ? { words: c.edit.words, wordsFrom: c.edit.wordsFrom, wordsTo: c.edit.wordsTo } : {})),
  };
  const f = { start, end, edit, layout: edit.layout, style: edit.captions.style };
  // Los cortes automáticos se recalculan al renderizar si cambian inicio/fin o qué se corta
  const po = (await getProject(c.project_id))?.data?.options || {};
  const eff = a => JSON.stringify(a ? { s: !!a.silence, r: !!a.retakes, c: !!a.condense } : { s: !!po.cutSilence, r: !!po.cutRetakes, c: !!po.condense });
  if (start !== c.start || end !== c.end || eff(edit.autocut) !== eff(c.edit?.autocut)) f.keep = null;
  // Directos: el clip se forma con los trozos de los segmentos grabados que cubren el nuevo inicio y final
  if (c.src && (start !== c.start || end !== c.end)) {
    const segs = await liveSegs(c.project_id, start, end);
    const parts = segs.map(sg => { const a = Math.max(start, sg.start), z = Math.min(end, sg.start + sg.dur); return { ref: sg.ref, ss: +(a - sg.start).toFixed(3), dur: +(z - a).toFixed(3) }; }).filter(x => x.dur > 0.05);
    if (!parts.length) throw new Error('Esa parte del directo ya no está guardada.');
    f.src = JSON.stringify(parts);
  }
  if ('hook' in b) f.hook = String(b.hook || '').slice(0, 120);
  if ('title' in b) f.title = String(b.title || '').slice(0, 120);
  await updateClip(c.id, f);
  if (b.render) {
    await requireSource(c.id);
    await updateClip(c.id, { status: 'rendering', error: null, progress: 0, stage: 'En cola…' });
    await updateProject(c.project_id, { status: 'processing', error: null, progress: 'Renderizando cambios…' });
    await enqueue('clip.render', { clipId: c.id });
  }
  res.json({ ok: true });
}));

const NO_SOURCE = 'El vídeo original de este proyecto se borró para ahorrar espacio (limpieza automática), así que no se puede volver a renderizar. Los clips ya hechos siguen disponibles.';
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
// ---------- Mi marca (logo y marco) ----------
app.get('/api/brand', h(async (req, res) => { const { getBrand } = await import('./brand.js'); const b = await getBrand(); res.json({ ...b, logo: undefined, frame: undefined, hasLogo: !!b.logo, hasFrame: !!b.frame }); }));
app.put('/api/brand', h(async (req, res) => {
  const b = req.body || {}, f = {};
  const okRef = r => typeof r === 'string' && r.length < 400 && !/[\s"']/.test(r);
  if ('logo' in b) f.brand_logo = b.logo && okRef(b.logo) ? b.logo : '';
  if ('frame' in b) f.brand_frame = b.frame && okRef(b.frame) ? b.frame : '';
  if ('pos' in b) f.brand_pos = String(b.pos || '');
  if ('size' in b) f.brand_size = String(Number(b.size) || '');
  if ('opacity' in b) f.brand_opacity = String(Number(b.opacity) || '');
  await setSettings(f);
  const { getBrand } = await import('./brand.js'); const out = await getBrand();
  res.json({ ...out, logo: undefined, frame: undefined, hasLogo: !!out.logo, hasFrame: !!out.frame });
}));

// ---------- Multi Edit: varias versiones distintas de un mismo clip (ver video/multiedit.js) ----------
app.post('/api/clips/:id/multiedit', h(async (req, res) => {
  const c = await getClip(req.params.id);
  if (!c) return res.status(404).json({ error: 'No existe' });
  if (!c.file && c.status !== 'ready') throw new Error('Espera a que el clip termine de renderizarse.');
  const { createVersions } = await import('./video/multiedit.js');
  const r = await createVersions(c, req.body || {});
  await updateProject(c.project_id, { status: 'processing' }).catch(() => {});
  res.json({ ok: true, ...r });
}));
// Multi Edit desde un vídeo subido: se transcribe (para los subtítulos) y se crean las versiones del vídeo entero
app.post('/api/multiedit', h(async (req, res) => {
  const b = req.body || {};
  if (!b.source) throw new Error('Sube un vídeo.');
  const options = {
    multi: { count: Math.max(2, Math.min(20, Number(b.count) || 5)), vary: b.vary || {} },
    layout: ['crop', 'blur', 'face', 'gaming'].includes(b.layout) ? b.layout : 'crop', language: b.language || '', titleLanguage: b.titleLanguage || '',
    captions: b.captions !== false, captionStyle: CAPTION_STYLES[b.captionStyle] ? b.captionStyle : 'impacto', emojis: false, brand: b.brand === true, ...autoEditOptions(b),
  };
  const p = await insert('projects', { type: 'shorts', title: '🧬 ' + (b.title || b.filename?.replace(/\.[^.]+$/, '') || 'Multi Edit'), channel_id: Number(b.channel_id) || null,
    source: b.source, data: { options }, progress: 'En cola…' });
  await enqueue('shorts.start', { id: p.id });
  res.json({ id: p.id });
}));

// ---------- Publicar a mano en Instagram / Facebook / TikTok: título, descripción y hashtags listos para pegar ----------
app.post('/api/clips/:id/caption', h(async (req, res) => {
  const c = await getClip(req.params.id);
  if (!c) return res.status(404).json({ error: 'No existe' });
  if (c.social?.description && !req.body?.regen) return res.json(c.social);
  const p = await getProject(c.project_id);
  const { sliceWords } = await import('./video/ass.js');
  const all = p.type === 'live' ? await liveWords(p.id, c.start, c.end) : (p.data.transcript?.words || []);
  const said = sliceWords(c.edit?.words || all, c.start, c.end).map(w => w.word).join(' ').slice(0, 2500);
  const lang = p.data.options?.titleLanguage || p.data.options?.language || '';
  let out = {};
  try {
    out = await chatJSON('Eres experto en redes sociales y vídeos cortos virales (Reels, TikTok, Shorts).', `Clip vertical. Título actual: "${c.title || ''}". Gancho: "${c.hook || ''}".
Lo que se dice en el clip: """${said}"""
Escribe ${lang ? 'en el idioma con código ' + lang : 'en el idioma del texto'} un JSON:
{"title":"título con gancho, máx 80 caracteres, sin hashtags","description":"1 o 2 frases que den ganas de verlo y una pregunta o llamada a comentar, máx 220 caracteres, sin hashtags","hashtags":["6 a 8 hashtags relevantes y populares, con #, sin espacios"]}`, { maxTokens: 400 });
  } catch (e) { console.warn('[publicar] la IA no generó el texto:', e.message); }
  const tags = (Array.isArray(out.hashtags) ? out.hashtags : String(out.hashtags || '').split(/[\s,]+/))
    .map(t => '#' + String(t).replace(/^#+/, '').replace(/\s+/g, '')).filter(t => t.length > 2).slice(0, 10);
  const social = {
    title: String(out.title || c.title || '').slice(0, 100),
    description: String(out.description || c.hook || '').slice(0, 500),
    hashtags: (tags.length ? tags : ['#viral', '#fyp', '#reels']).join(' '),
  };
  await updateClip(c.id, { social });
  res.json(social);
}));
app.put('/api/clips/:id/caption', h(async (req, res) => {
  const b = req.body || {};
  const social = { title: String(b.title || '').slice(0, 100), description: String(b.description || '').slice(0, 2000), hashtags: String(b.hashtags || '').slice(0, 600) };
  await updateClip(Number(req.params.id), { social });
  res.json(social);
}));
// Ruta del vídeo en este equipo (app de escritorio: para arrastrarlo a la web de la red social o guardarlo en Descargas)
app.get('/api/clips/:id/localfile', h(async (req, res) => {
  const c = await getClip(req.params.id);
  const ref = req.query.lang ? c?.variants?.[req.query.lang]?.file : c?.file;
  const f = ref && STORAGE_MODE !== 's3' && !/^https?:/.test(ref) ? inputPath(ref) : null;
  res.json({ path: f && fs.existsSync(f) ? f : null });
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
