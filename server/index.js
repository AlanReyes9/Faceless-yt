import express from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import archiver from 'archiver';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, json, getProject, updateProject, getClip, updateClip, UPLOADS_DIR, OUTPUT_DIR, WORK_DIR } from './db.js';
import { publicSettings, setSettings, getSetting } from './settings.js';
import { chat, chatJSON } from './ai/llm.js';
import { run } from './video/ffmpeg.js';
import { queueProject, queueRender, queueTranslate } from './video/shorts.js';
import { queueLong, generateScript } from './video/longform.js';
import { authUrl, handleCallback, uploadVideo, youtubeConfigured } from './youtube.js';
import { queueStatus } from './jobs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());

// ---------- Acceso con contraseña (APP_PASSWORD) ----------
const PASSWORD = process.env.APP_PASSWORD || '';
const sign = v => crypto.createHmac('sha256', PASSWORD + (process.env.APP_SECRET || 'faceless')).update(v).digest('hex');
const authed = req => !PASSWORD || req.cookies.session === sign('ok');
app.post('/api/login', (req, res) => {
  const a = Buffer.from(String(req.body.password || '')), b = Buffer.from(PASSWORD);
  if (!PASSWORD || (a.length === b.length && crypto.timingSafeEqual(a, b))) {
    res.cookie('session', sign('ok'), { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5, secure: req.secure });
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Contraseña incorrecta' });
});
app.post('/api/logout', (req, res) => { res.clearCookie('session'); res.json({ ok: true }); });
app.get('/api/me', (req, res) => res.json({ authed: authed(req), passwordRequired: !!PASSWORD }));
app.use(['/api', '/files'], (req, res, next) => {
  if (authed(req) || req.path === '/youtube/callback') return next();
  res.status(401).json({ error: 'No autorizado' });
});

const h = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => res.status(400).json({ error: e.message }));
const upload = multer({ dest: UPLOADS_DIR, limits: { fileSize: 8 * 1024 ** 3 } });

// ---------- Sistema ----------
const has = async (cmd, flag = '--version') => run(cmd, [flag]).then(() => true, () => false);
app.get('/api/system', h(async (req, res) => res.json({
  ffmpeg: await has('ffmpeg', '-version'), ytdlp: await has('yt-dlp'), queue: queueStatus(), youtube: youtubeConfigured(),
})));
app.get('/api/stats', h((req, res) => res.json({
  channels: db.prepare('SELECT COUNT(*) n FROM channels').get().n,
  projects: db.prepare('SELECT COUNT(*) n FROM projects WHERE deleted_at IS NULL').get().n,
  shorts: db.prepare("SELECT COUNT(*) n FROM clips c JOIN projects p ON p.id = c.project_id WHERE c.status = 'ready' AND p.deleted_at IS NULL").get().n,
  published: db.prepare('SELECT COUNT(*) n FROM clips WHERE yt_video_id IS NOT NULL').get().n,
  upcoming: db.prepare("SELECT * FROM calendar WHERE done = 0 AND date >= date('now') ORDER BY date LIMIT 5").all(),
  recent: db.prepare('SELECT id, type, title, status, progress, created_at FROM projects WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 6').all(),
})));

// ---------- Ajustes y claves ----------
app.get('/api/settings', (req, res) => res.json(publicSettings()));
app.put('/api/settings', h((req, res) => { setSettings(req.body || {}); res.json(publicSettings()); }));
app.post('/api/settings/test', h(async (req, res) => {
  const out = await chat('Responde solo con la palabra OK.', 'Prueba de conexión', { provider: req.body.provider, maxTokens: 20 });
  res.json({ ok: true, reply: out.trim().slice(0, 50) });
}));

// ---------- Canales ----------
const channelOut = c => ({ ...c, yt_refresh_token: undefined, connected: !!c.yt_refresh_token });
app.get('/api/channels', (req, res) => res.json(db.prepare('SELECT * FROM channels ORDER BY id').all().map(channelOut)));
app.post('/api/channels', h((req, res) => {
  const { name, niche = '', language = 'es', notes = '' } = req.body;
  if (!name) throw new Error('El canal necesita un nombre.');
  const r = db.prepare('INSERT INTO channels (name, niche, language, notes) VALUES (?,?,?,?)').run(name, niche, language, notes);
  res.json({ id: Number(r.lastInsertRowid) });
}));
app.put('/api/channels/:id', h((req, res) => {
  const { name, niche, language, notes } = req.body;
  db.prepare('UPDATE channels SET name = ?, niche = ?, language = ?, notes = ? WHERE id = ?').run(name, niche || '', language || 'es', notes || '', req.params.id);
  res.json({ ok: true });
}));
app.delete('/api/channels/:id', h((req, res) => { db.prepare('DELETE FROM channels WHERE id = ?').run(req.params.id); res.json({ ok: true }); }));
app.post('/api/channels/:id/disconnect', h((req, res) => {
  db.prepare('UPDATE channels SET yt_refresh_token = NULL, yt_channel_id = NULL, yt_title = NULL WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
}));
app.get('/api/youtube/auth', h((req, res) => res.redirect(authUrl(req, req.query.channel))));
app.get('/api/youtube/callback', async (req, res) => {
  try { await handleCallback(req); res.redirect('/#/canales?ok=1'); }
  catch (e) { res.redirect('/#/canales?error=' + encodeURIComponent(e.message)); }
});

// ---------- Proyectos ----------
function projectOut(p) {
  const { transcript, ...data } = p.data || {};
  return { ...p, data, hasTranscript: !!transcript };
}
app.get('/api/projects', h((req, res) => {
  const trash = req.query.trash === '1';
  const rows = db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM clips c WHERE c.project_id = p.id AND c.status = 'ready') ready_clips
    FROM projects p WHERE deleted_at IS ${trash ? 'NOT ' : ''}NULL ${req.query.type ? 'AND type = ?' : ''} ORDER BY id DESC`)
    .all(...(req.query.type ? [req.query.type] : []));
  res.json(rows.map(p => projectOut({ ...p, data: json(p.data) })));
}));
app.get('/api/projects/:id', h((req, res) => {
  const p = getProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'No existe' });
  const clips = db.prepare('SELECT * FROM clips WHERE project_id = ? ORDER BY idx').all(p.id).map(c => ({ ...c, variants: json(c.variants) }));
  res.json({ ...projectOut(p), clips });
}));
app.post('/api/shorts', upload.single('video'), h((req, res) => {
  const b = req.body;
  if (!req.file && !b.url) throw new Error('Sube un vídeo o pega un enlace.');
  let source_path = null;
  if (req.file) {
    source_path = path.join(UPLOADS_DIR, `${req.file.filename}${path.extname(req.file.originalname) || '.mp4'}`);
    fs.renameSync(req.file.path, source_path);
  }
  const options = {
    count: Math.min(30, Number(b.count) || 10), minSec: Number(b.minSec) || 20, maxSec: Number(b.maxSec) || 60,
    layout: b.layout === 'crop' ? 'crop' : 'blur', language: b.language || '', titleLanguage: b.titleLanguage || '',
    captions: b.captions !== 'false',
  };
  const title = b.title || req.file?.originalname?.replace(/\.[^.]+$/, '') || b.url;
  const r = db.prepare('INSERT INTO projects (type, title, channel_id, source_path, source_url, data, progress) VALUES (?,?,?,?,?,?,?)')
    .run('shorts', title, Number(b.channel_id) || null, source_path, b.url || null, JSON.stringify({ options }), 'En cola…');
  const id = Number(r.lastInsertRowid);
  queueProject(id);
  res.json({ id });
}));
app.post('/api/long/script', h(async (req, res) => res.json(await generateScript(req.body))));
app.post('/api/long', h((req, res) => {
  const { topic, script, channel_id, ...options } = req.body;
  if (!topic && !script) throw new Error('Escribe un tema para el vídeo.');
  const r = db.prepare('INSERT INTO projects (type, title, channel_id, data, progress) VALUES (?,?,?,?,?)')
    .run('long', script?.title || topic, Number(channel_id) || null, JSON.stringify({ options: { topic, ...options }, script }), 'En cola…');
  const id = Number(r.lastInsertRowid);
  queueLong(id);
  res.json({ id });
}));
app.post('/api/projects/:id/retry', h((req, res) => {
  const p = getProject(req.params.id);
  updateProject(p.id, { status: 'pending', error: null, progress: 'En cola…' });
  (p.type === 'long' ? queueLong : queueProject)(p.id);
  res.json({ ok: true });
}));
app.patch('/api/projects/:id', h((req, res) => {
  const p = getProject(req.params.id);
  const f = {};
  if ('title' in req.body) f.title = req.body.title;
  if ('channel_id' in req.body) f.channel_id = Number(req.body.channel_id) || null;
  if (req.body.meta) f.data = { ...p.data, meta: req.body.meta };
  updateProject(p.id, f);
  res.json({ ok: true });
}));
app.delete('/api/projects/:id', h((req, res) => {
  const p = getProject(req.params.id);
  if (req.query.permanent !== '1') { updateProject(p.id, { deleted_at: new Date().toISOString() }); return res.json({ ok: true }); }
  const clips = db.prepare('SELECT * FROM clips WHERE project_id = ?').all(p.id);
  for (const c of clips) {
    if (c.file) fs.rmSync(path.join(OUTPUT_DIR, c.file), { force: true });
    for (const v of Object.values(json(c.variants))) if (v.file) fs.rmSync(path.join(OUTPUT_DIR, v.file), { force: true });
  }
  if (p.output_path) fs.rmSync(path.join(OUTPUT_DIR, p.output_path), { force: true });
  if (p.source_path) fs.rmSync(p.source_path, { force: true });
  fs.rmSync(path.join(WORK_DIR, `p${p.id}`), { recursive: true, force: true });
  db.prepare('DELETE FROM clips WHERE project_id = ?').run(p.id);
  db.prepare('DELETE FROM projects WHERE id = ?').run(p.id);
  res.json({ ok: true });
}));
app.post('/api/projects/:id/restore', h((req, res) => { updateProject(req.params.id, { deleted_at: null }); res.json({ ok: true }); }));
app.get('/api/projects/:id/zip', h((req, res) => {
  const p = getProject(req.params.id);
  const clips = db.prepare('SELECT * FROM clips WHERE project_id = ? AND include_zip = 1 AND file IS NOT NULL ORDER BY idx').all(p.id);
  res.attachment(`shorts_${p.id}.zip`);
  const zip = archiver('zip', { store: true });
  zip.pipe(res);
  const safe = s => String(s || '').replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 60);
  const used = new Set();
  const unique = n => { let out = n, i = 2; while (used.has(out)) out = n.replace(/\.mp4$/, ` (${i++}).mp4`); used.add(out); return out; };
  for (const c of clips) {
    zip.file(path.join(OUTPUT_DIR, c.file), { name: unique(`${String(c.idx).padStart(2, '0')} - ${safe(c.title) || 'short'}.mp4`) });
    for (const [lang, v] of Object.entries(json(c.variants)))
      if (v.file) zip.file(path.join(OUTPUT_DIR, v.file), { name: unique(`${lang}/${String(c.idx).padStart(2, '0')} - ${safe(v.title || c.title)}.mp4`) });
  }
  zip.append(clips.map(c => `#${c.idx} [${c.score}/10] ${c.title}\nGancho: ${c.hook}\n${c.reason}\n`).join('\n'), { name: 'titulos.txt' });
  zip.finalize();
}));
app.get('/api/projects/:id/source', h((req, res) => {
  const p = getProject(req.params.id);
  if (!p?.source_path) return res.status(404).end();
  res.sendFile(path.resolve(p.source_path));
}));

// ---------- Clips (Shorts) ----------
app.patch('/api/clips/:id', h((req, res) => {
  const c = getClip(req.params.id);
  const f = {};
  for (const k of ['title', 'hook', 'layout']) if (k in req.body) f[k] = String(req.body[k]);
  for (const k of ['start', 'end']) if (k in req.body) f[k] = Math.max(0, Number(req.body[k]));
  if ('include_zip' in req.body) f.include_zip = req.body.include_zip ? 1 : 0;
  const start = f.start ?? c.start, end = f.end ?? c.end;
  if (end - start < 2) throw new Error('El clip debe durar al menos 2 segundos.');
  updateClip(c.id, f);
  res.json({ ok: true });
}));
app.post('/api/clips/:id/render', h((req, res) => {
  updateClip(req.params.id, { status: 'rendering' });
  queueRender(Number(req.params.id)).catch(() => {});
  res.json({ ok: true });
}));
app.post('/api/clips/:id/translate', h((req, res) => {
  if (!req.body.lang) throw new Error('Elige un idioma.');
  updateClip(req.params.id, { status: 'rendering' });
  queueTranslate(Number(req.params.id), req.body.lang).catch(() => {});
  res.json({ ok: true });
}));
app.delete('/api/clips/:id', h((req, res) => {
  const c = getClip(req.params.id);
  if (c.file) fs.rmSync(path.join(OUTPUT_DIR, c.file), { force: true });
  db.prepare('DELETE FROM clips WHERE id = ?').run(c.id);
  res.json({ ok: true });
}));
app.post('/api/clips/:id/publish', h(async (req, res) => {
  const c = getClip(req.params.id);
  const { channel_id, title, description = '', tags = [], privacy = 'public', publishAt, lang } = req.body;
  const file = lang ? c.variants[lang]?.file : c.file;
  if (!file) throw new Error('Este clip aún no está renderizado.');
  const t = title || c.title;
  const id = await uploadVideo(Number(channel_id), path.join(OUTPUT_DIR, file), {
    title: /#shorts/i.test(t) ? t : `${t} #Shorts`, description: `${description}\n\n#Shorts`.trim(), tags, privacy, publishAt,
  });
  updateClip(c.id, { yt_video_id: id });
  res.json({ ok: true, videoId: id, url: `https://youtube.com/shorts/${id}` });
}));
app.post('/api/projects/:id/publish', h(async (req, res) => {
  const p = getProject(req.params.id);
  if (!p.output_path) throw new Error('El vídeo aún no está listo.');
  const s = p.data.script || {};
  const { channel_id, title, description, tags, privacy = 'public', publishAt } = req.body;
  const id = await uploadVideo(Number(channel_id), path.join(OUTPUT_DIR, p.output_path), {
    title: title || s.title || p.title, description: description ?? s.description ?? '', tags: tags || s.tags || [], privacy, publishAt,
  });
  updateProject(p.id, { data: { ...p.data, yt_video_id: id } });
  res.json({ ok: true, videoId: id, url: `https://youtube.com/watch?v=${id}` });
}));

// ---------- Herramientas IA ----------
app.post('/api/niches', h(async (req, res) => {
  const { interest = '', language = 'es', market = 'hispanohablante' } = req.body;
  res.json(await chatJSON(
    'Eres un estratega de YouTube especializado en canales faceless (sin mostrar la cara) y monetización (RPM, AdSense, afiliados).',
    `Propón 8 nichos para un canal faceless${interest ? ` relacionados con: "${interest}"` : ''}, para el mercado ${market}, idioma ${language}.
Para cada uno: {"name","description","rpm":"estimación de RPM en USD","competition":"baja|media|alta","difficulty":1-10,"formats":["shorts","largos",...],"video_ideas":["5 títulos de vídeo concretos"],"why":"por qué es buena oportunidad"}.
JSON: {"niches":[...]}`, { maxTokens: 6000 }));
}));
app.post('/api/titles', h(async (req, res) => {
  const { topic, language = 'es' } = req.body;
  res.json(await chatJSON('Eres experto en SEO y CTR de YouTube.',
    `Para el vídeo "${topic}", en ${language}, devuelve {"titles":["10 títulos con gancho"],"description":"descripción SEO","tags":["15 etiquetas"]}`));
}));

// ---------- Calendario ----------
app.get('/api/calendar', h((req, res) => {
  const { from = '0000', to = '9999' } = req.query;
  res.json(db.prepare('SELECT * FROM calendar WHERE date BETWEEN ? AND ? ORDER BY date, id').all(from, to));
}));
app.post('/api/calendar', h((req, res) => {
  const { date, title, notes = '', channel_id = null, kind = 'short' } = req.body;
  if (!date || !title) throw new Error('Fecha y título son obligatorios.');
  const r = db.prepare('INSERT INTO calendar (date, title, notes, channel_id, kind) VALUES (?,?,?,?,?)').run(date, title, notes, channel_id || null, kind);
  res.json({ id: Number(r.lastInsertRowid) });
}));
app.patch('/api/calendar/:id', h((req, res) => {
  const cur = db.prepare('SELECT * FROM calendar WHERE id = ?').get(req.params.id);
  const n = { ...cur, ...req.body };
  db.prepare('UPDATE calendar SET date = ?, title = ?, notes = ?, channel_id = ?, kind = ?, done = ? WHERE id = ?')
    .run(n.date, n.title, n.notes || '', n.channel_id || null, n.kind, n.done ? 1 : 0, cur.id);
  res.json({ ok: true });
}));
app.delete('/api/calendar/:id', h((req, res) => { db.prepare('DELETE FROM calendar WHERE id = ?').run(req.params.id); res.json({ ok: true }); }));
app.post('/api/calendar/generate', h(async (req, res) => {
  const { channel_id, days = 14, start = new Date().toISOString().slice(0, 10), perDay = 1 } = req.body;
  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(channel_id);
  if (!ch) throw new Error('Elige un canal.');
  const plan = await chatJSON('Eres un estratega de contenido para YouTube faceless.',
    `Canal "${ch.name}", nicho "${ch.niche}", idioma ${ch.language}. ${ch.notes || ''}
Crea un calendario de ${days} días empezando el ${start}, ${perDay} publicación(es) por día, mezclando Shorts y vídeos largos (aprox. 1 largo por cada 5 shorts).
JSON: {"items":[{"date":"YYYY-MM-DD","kind":"short|long","title":"...","notes":"idea/gancho en una frase"}]}`, { maxTokens: 6000 });
  const ins = db.prepare('INSERT INTO calendar (date, title, notes, channel_id, kind) VALUES (?,?,?,?,?)');
  for (const it of plan.items || []) if (it.date && it.title) ins.run(it.date, it.title, it.notes || '', ch.id, it.kind === 'long' ? 'long' : 'short');
  res.json({ added: (plan.items || []).length });
}));

// ---------- Archivos y frontend ----------
app.use('/files', express.static(OUTPUT_DIR, { maxAge: '1h' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get(/^\/(?!api|files).*/, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// Al arrancar: los trabajos interrumpidos por un reinicio se marcan con error para reintentarlos.
db.prepare("UPDATE projects SET status = 'error', error = 'Interrumpido por un reinicio del servidor. Pulsa Reintentar.' WHERE status IN ('pending','processing')").run();
db.prepare("UPDATE clips SET status = 'error', error = 'Interrumpido. Pulsa Aplicar cambios.' WHERE status = 'rendering'").run();

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`Faceless Studio en http://localhost:${PORT}${PASSWORD ? '' : '  (sin contraseña: define APP_PASSWORD)'}`));
