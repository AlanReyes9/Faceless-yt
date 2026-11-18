// Redes sociales: conectar Facebook (páginas), Instagram (cuentas profesionales) y TikTok para publicar y programar Reels.
// - Facebook: Reels de página con subida desde el equipo (rupload) y programación nativa de Facebook.
// - Instagram: Reels con subida reanudable desde el equipo (sin URL pública) y publicación.
// - TikTok: Content Posting API, subida por trozos; sin auditoría de TikTok se envía a borradores (o publicación privada).
// Instagram y TikTok no permiten programar desde fuera: la app publica a la hora indicada (tiene que estar abierta).
import fs from 'node:fs';
import crypto from 'node:crypto';
import { q, one, IS_VERCEL, WORK_DIR } from './db.js';
import { getSetting, encryptSecret, decryptSecret, internalSecret } from './settings.js';
import { register, enqueue } from './jobs.js';
import { inputPath, toLocal, publicUrl } from './storage.js';
import { baseUrl } from './youtube.js';

const G = process.env.META_GRAPH_URL || 'https://graph.facebook.com/v21.0'; // (variables solo para pruebas)
const TT = process.env.TIKTOK_API_URL || 'https://open.tiktokapis.com/v2';
const META_SCOPES = 'pages_show_list,pages_read_engagement,pages_manage_posts,business_management,instagram_basic,instagram_content_publish';
const TT_SCOPES = 'user.info.basic,video.upload,video.publish';

export const SOCIAL_SQL = `
CREATE TABLE IF NOT EXISTS social_accounts (
  id SERIAL PRIMARY KEY, platform TEXT NOT NULL, external_id TEXT NOT NULL, name TEXT, avatar TEXT,
  token TEXT, refresh_token TEXT, expires_at TIMESTAMPTZ, data JSONB DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (platform, external_id)
);
CREATE TABLE IF NOT EXISTS social_posts (
  id SERIAL PRIMARY KEY, account_id INTEGER, clip_id INTEGER, project_id INTEGER, file TEXT, caption TEXT, mode TEXT,
  scheduled_at TIMESTAMPTZ, status TEXT DEFAULT 'scheduled', result_url TEXT, error TEXT, external_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now(), published_at TIMESTAMPTZ
);`;
let ready = null;
const ensureTables = () => (ready ||= (async () => { for (const st of SOCIAL_SQL.split(';').map(x => x.trim()).filter(Boolean)) await q(st); })().catch(e => { ready = null; throw e; }));

const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const signState = v => `${v}.${crypto.createHmac('sha256', internalSecret()).update('social:' + v).digest('hex').slice(0, 16)}`;
const checkState = s => { const v = String(s || '').split('.')[0]; if (signState(v) !== s) throw fail('Estado OAuth no válido. Vuelve a intentarlo.'); return v; };
const metaRedirect = req => `${baseUrl(req)}/api/social/meta/callback`;
const ttRedirect = req => `${baseUrl(req)}/api/social/tiktok/callback`;
const tok = a => decryptSecret(a.token);

async function jget(url, opts = {}) {
  const r = await fetch(url, opts);
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = { raw: t }; }
  return { ok: r.ok, status: r.status, j };
}
function metaErr(j, what) {
  const e = j?.error || {};
  const m = String(e.message || j?.raw || 'error');
  if (e.code === 190 || /expired|session has been invalidated/i.test(m)) return fail(`${what}: la conexión con Meta caducó. Vuelve a conectar Facebook/Instagram en "Mis canales".`);
  if (e.code === 10 || e.code === 200 || /permission/i.test(m)) return fail(`${what}: faltan permisos (${m}). Vuelve a conectar y acepta todos los permisos; si tu app de Meta es nueva, añade tu cuenta como administradora o probadora de la app.`);
  return fail(`${what}: ${m}`);
}

// ---------- Conectar: Meta (Facebook + Instagram) ----------
async function metaAuthUrl(req) {
  const id = await getSetting('meta_app_id');
  if (!id) throw fail('Falta el "Meta App ID" en Ajustes y claves (ver Ayuda → Publicar en Instagram y Facebook).');
  const cfg = await getSetting('meta_config_id');
  const qs = new URLSearchParams({ client_id: id, redirect_uri: metaRedirect(req), state: signState('meta'), response_type: 'code', ...(cfg ? { config_id: cfg } : { scope: META_SCOPES }) });
  return 'https://www.facebook.com/v21.0/dialog/oauth?' + qs;
}
async function metaCallback(req) {
  checkState(req.query.state);
  if (req.query.error) throw fail(req.query.error_description || 'Cancelaste el permiso en Facebook.');
  const id = await getSetting('meta_app_id'), secret = await getSetting('meta_app_secret');
  if (!secret) throw fail('Falta el "Meta App Secret" en Ajustes y claves.');
  let r = await jget(`${G}/oauth/access_token?` + new URLSearchParams({ client_id: id, client_secret: secret, redirect_uri: metaRedirect(req), code: String(req.query.code || '') }));
  if (!r.ok) throw metaErr(r.j, 'Conectar con Meta');
  r = await jget(`${G}/oauth/access_token?` + new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: id, client_secret: secret, fb_exchange_token: r.j.access_token }));
  if (!r.ok) throw metaErr(r.j, 'Conectar con Meta');
  const userToken = r.j.access_token; // de larga duración: los tokens de página que salen de él no caducan
  r = await jget(`${G}/me/accounts?` + new URLSearchParams({ fields: 'id,name,access_token,picture{url},instagram_business_account{id,username,name,profile_picture_url}', limit: '100', access_token: userToken }));
  if (!r.ok) throw metaErr(r.j, 'Leer tus páginas de Facebook');
  const pages = r.j.data || [];
  if (!pages.length) throw fail('Tu cuenta no tiene páginas de Facebook (o no diste permiso a ninguna). Para Instagram, la cuenta tiene que ser profesional y estar vinculada a una página de Facebook.');
  let n = 0;
  for (const p of pages) {
    await upsert('facebook', p.id, p.name, p.picture?.data?.url, p.access_token, { pageId: p.id }); n++;
    const ig = p.instagram_business_account;
    if (ig) { await upsert('instagram', ig.id, '@' + (ig.username || ig.name || ig.id), ig.profile_picture_url, p.access_token, { pageId: p.id, pageName: p.name }); n++; }
  }
  return n;
}
async function upsert(platform, externalId, name, avatar, token, data = {}, refresh = null, expiresAt = null) {
  await q(`INSERT INTO social_accounts (platform, external_id, name, avatar, token, refresh_token, expires_at, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (platform, external_id) DO UPDATE SET name = EXCLUDED.name, avatar = EXCLUDED.avatar, token = EXCLUDED.token,
      refresh_token = COALESCE(EXCLUDED.refresh_token, social_accounts.refresh_token), expires_at = EXCLUDED.expires_at, data = EXCLUDED.data`,
    [platform, String(externalId), name || '', avatar || null, encryptSecret(token), refresh ? encryptSecret(refresh) : null, expiresAt, JSON.stringify(data)]);
}

// ---------- Conectar: TikTok (Login Kit con PKCE) ----------
const pkce = new Map(); // state → code_verifier (válido 15 min)
async function ttAuthUrl(req) {
  const key = await getSetting('tiktok_client_key');
  if (!key) throw fail('Falta el "TikTok Client Key" en Ajustes y claves (ver Ayuda → Publicar en TikTok).');
  const nonce = crypto.randomBytes(8).toString('hex'), state = signState('tt' + nonce);
  const verifier = crypto.randomBytes(48).toString('base64url');
  pkce.set(state, { verifier, at: Date.now() });
  for (const [k, v] of pkce) if (Date.now() - v.at > 15 * 60000) pkce.delete(k);
  // TikTok (escritorio) espera el desafío PKCE en hexadecimal
  const challenge = crypto.createHash('sha256').update(verifier).digest('hex');
  const qs = new URLSearchParams({ client_key: key, scope: TT_SCOPES, response_type: 'code', redirect_uri: ttRedirect(req), state, code_challenge: challenge, code_challenge_method: 'S256' });
  return 'https://www.tiktok.com/v2/auth/authorize/?' + qs;
}
async function ttToken(params) {
  const body = new URLSearchParams({ client_key: await getSetting('tiktok_client_key'), client_secret: await getSetting('tiktok_client_secret'), ...params });
  const r = await jget(`${TT}/oauth/token/`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok || r.j.error) throw fail('TikTok: ' + (r.j.error_description || r.j.error || r.status));
  return r.j;
}
async function ttCallback(req) {
  const state = String(req.query.state || '');
  checkState(state);
  if (req.query.error) throw fail(req.query.error_description || 'Cancelaste el permiso en TikTok.');
  if (!(await getSetting('tiktok_client_secret'))) throw fail('Falta el "TikTok Client Secret" en Ajustes y claves.');
  const p = pkce.get(state); pkce.delete(state);
  const t = await ttToken({ code: String(req.query.code || ''), grant_type: 'authorization_code', redirect_uri: ttRedirect(req), ...(p ? { code_verifier: p.verifier } : {}) });
  const u = await jget(`${TT}/user/info/?fields=open_id,display_name,avatar_url`, { headers: { authorization: 'Bearer ' + t.access_token } });
  const user = u.j?.data?.user || {};
  await upsert('tiktok', t.open_id, user.display_name || 'TikTok', user.avatar_url, t.access_token, { scope: t.scope },
    t.refresh_token, new Date(Date.now() + (t.expires_in || 86400) * 1000).toISOString());
  return 1;
}
async function ttAccess(acc) {
  if (acc.expires_at && new Date(acc.expires_at).getTime() > Date.now() + 5 * 60000) return tok(acc);
  if (!acc.refresh_token) throw fail('La conexión con TikTok caducó. Vuelve a conectarla en "Mis canales".');
  const t = await ttToken({ grant_type: 'refresh_token', refresh_token: decryptSecret(acc.refresh_token) });
  await q('UPDATE social_accounts SET token = $2, refresh_token = $3, expires_at = $4 WHERE id = $1',
    [acc.id, encryptSecret(t.access_token), encryptSecret(t.refresh_token || decryptSecret(acc.refresh_token)), new Date(Date.now() + (t.expires_in || 86400) * 1000).toISOString()]);
  return t.access_token;
}

// ---------- Publicar ----------
async function publishFacebook(acc, file, size, post) {
  const t = tok(acc), page = acc.external_id;
  let r = await jget(`${G}/${page}/video_reels`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ upload_phase: 'start', access_token: t }) });
  if (!r.ok) throw metaErr(r.j, 'Facebook');
  const videoId = r.j.video_id;
  const up = await fetch(r.j.upload_url || `https://rupload.facebook.com/video-upload/v21.0/${videoId}`, {
    method: 'POST', headers: { authorization: 'OAuth ' + t, offset: '0', file_size: String(size) }, body: fs.createReadStream(file), duplex: 'half' });
  if (!up.ok) throw fail('Facebook: no se pudo subir el vídeo (' + up.status + '): ' + (await up.text()).slice(0, 200));
  const sched = post.mode === 'native' ? Math.floor(new Date(post.scheduled_at).getTime() / 1000) : 0;
  r = await jget(`${G}/${page}/video_reels`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    upload_phase: 'finish', video_id: videoId, description: post.caption || '', access_token: t,
    video_state: sched ? 'SCHEDULED' : 'PUBLISHED', ...(sched ? { scheduled_publish_time: sched } : {}) }) });
  if (!r.ok) throw metaErr(r.j, 'Facebook');
  return { id: videoId, url: `https://www.facebook.com/reel/${videoId}`, scheduled: !!sched };
}
async function publishInstagram(acc, file, size, post) {
  const t = tok(acc), ig = acc.external_id;
  let r = await jget(`${G}/${ig}/media`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    media_type: 'REELS', upload_type: 'resumable', caption: post.caption || '', share_to_feed: true, access_token: t }) });
  if (!r.ok) throw metaErr(r.j, 'Instagram');
  const container = r.j.id;
  const up = await fetch(r.j.uri || `https://rupload.facebook.com/ig-api-upload/v21.0/${container}`, {
    method: 'POST', headers: { authorization: 'OAuth ' + t, offset: '0', file_size: String(size) }, body: fs.createReadStream(file), duplex: 'half' });
  if (!up.ok) throw fail('Instagram: no se pudo subir el vídeo (' + up.status + '): ' + (await up.text()).slice(0, 200));
  for (let i = 0; i < 120; i++) { // hasta 10 min procesando
    await new Promise(res => setTimeout(res, 5000));
    r = await jget(`${G}/${container}?fields=status_code,status&access_token=${encodeURIComponent(t)}`);
    if (r.j.status_code === 'FINISHED') break;
    if (r.j.status_code === 'ERROR' || r.j.status_code === 'EXPIRED') throw fail('Instagram rechazó el vídeo: ' + (r.j.status || r.j.status_code) + '. Comprueba que dure entre 3 s y 15 min y sea vertical.');
    if (i === 119) throw fail('Instagram tardó demasiado en procesar el vídeo. Inténtalo de nuevo.');
  }
  r = await jget(`${G}/${ig}/media_publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ creation_id: container, access_token: t }) });
  if (!r.ok) throw metaErr(r.j, 'Instagram');
  const media = r.j.id;
  const pl = await jget(`${G}/${media}?fields=permalink&access_token=${encodeURIComponent(t)}`);
  return { id: media, url: pl.j.permalink || 'https://www.instagram.com/' };
}
async function publishTikTok(acc, file, size, post) {
  const t = await ttAccess(acc);
  const H = { authorization: 'Bearer ' + t, 'content-type': 'application/json; charset=UTF-8' };
  const CH = 10 * 1024 * 1024;
  const chunk = size <= 64 * 1024 * 1024 ? size : CH, count = size <= 64 * 1024 * 1024 ? 1 : Math.floor(size / CH);
  const source_info = { source: 'FILE_UPLOAD', video_size: size, chunk_size: chunk, total_chunk_count: count };
  let r;
  if (post.mode === 'direct') {
    const ci = await jget(`${TT}/post/publish/creator_info/query/`, { method: 'POST', headers: H, body: '{}' });
    const opts = ci.j?.data?.privacy_level_options || ['SELF_ONLY'];
    const privacy = opts.includes('PUBLIC_TO_EVERYONE') ? 'PUBLIC_TO_EVERYONE' : opts[0];
    r = await jget(`${TT}/post/publish/video/init/`, { method: 'POST', headers: H, body: JSON.stringify({
      post_info: { title: String(post.caption || '').slice(0, 2200), privacy_level: privacy, disable_duet: false, disable_comment: false, disable_stitch: false }, source_info }) });
  } else r = await jget(`${TT}/post/publish/inbox/video/init/`, { method: 'POST', headers: H, body: JSON.stringify({ source_info }) });
  if (!r.ok || (r.j.error && r.j.error.code !== 'ok')) {
    const m = r.j.error?.message || r.status;
    if (/unaudited|privacy_level|not.*audit/i.test(String(r.j.error?.code) + m)) throw fail('TikTok: tu app aún no está auditada, así que no puede publicar en público. Elige "Enviar a borradores de TikTok" o solicita la auditoría en developers.tiktok.com.');
    throw fail('TikTok: ' + m);
  }
  const { upload_url, publish_id } = r.j.data;
  const fd = fs.openSync(file, 'r');
  try {
    for (let i = 0; i < count; i++) {
      const start = i * chunk, end = i === count - 1 ? size - 1 : start + chunk - 1, len = end - start + 1;
      const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, start);
      const up = await fetch(upload_url, { method: 'PUT', headers: { 'content-type': 'video/mp4', 'content-length': String(len), 'content-range': `bytes ${start}-${end}/${size}` }, body: buf });
      if (![200, 201, 206].includes(up.status)) throw fail(`TikTok: no se pudo subir el vídeo (trozo ${i + 1}/${count}, ${up.status}).`);
    }
  } finally { fs.closeSync(fd); }
  for (let i = 0; i < 40; i++) { // se espera a que TikTok lo procese (hasta ~3 min)
    await new Promise(res => setTimeout(res, 5000));
    const s = await jget(`${TT}/post/publish/status/fetch/`, { method: 'POST', headers: H, body: JSON.stringify({ publish_id }) });
    const st = s.j?.data?.status;
    if (st === 'FAILED') throw fail('TikTok no pudo procesar el vídeo: ' + (s.j.data.fail_reason || 'motivo desconocido'));
    if (st === 'SEND_TO_USER_INBOX') return { id: publish_id, url: null, inbox: true };
    if (st === 'PUBLISH_COMPLETE') return { id: publish_id, url: `https://www.tiktok.com/@${acc.name}`, inbox: false };
  }
  return { id: publish_id, url: null, inbox: post.mode !== 'direct' };
}

register('social.publish', async ({ postId }) => {
  await ensureTables();
  const post = await one('SELECT * FROM social_posts WHERE id = $1', [postId]);
  if (!post || !['scheduled', 'queued'].includes(post.status)) return;
  const acc = await one('SELECT * FROM social_accounts WHERE id = $1', [post.account_id]);
  if (!acc) throw fail('La cuenta ya no está conectada.');
  await q("UPDATE social_posts SET status = 'publishing', error = NULL WHERE id = $1", [postId]);
  const local = await toLocal(post.file, `${WORK_DIR}/social_${postId}_${Date.now()}.mp4`);
  try {
    const size = fs.statSync(local).size;
    const fn = { facebook: publishFacebook, instagram: publishInstagram, tiktok: publishTikTok }[acc.platform];
    const res = await fn(acc, local, size, post);
    await q(`UPDATE social_posts SET status = $2, result_url = $3, external_id = $4, published_at = now() WHERE id = $1`,
      [postId, res.scheduled ? 'scheduled_native' : res.inbox ? 'inbox' : 'published', res.url, String(res.id || '')]);
  } finally { if (local !== inputPath(post.file)) fs.rmSync(local, { force: true }); }
}, async ({ postId }, msg) => { await q("UPDATE social_posts SET status = 'error', error = $2 WHERE id = $1", [postId, msg]).catch(() => {}); });

/** Lanza las publicaciones programadas cuya hora ya llegó. */
export async function dueSocial() {
  await ensureTables();
  const due = await q(`UPDATE social_posts SET status = 'queued' WHERE status = 'scheduled' AND scheduled_at <= now() RETURNING id`);
  for (const p of due) await enqueue('social.publish', { postId: p.id });
  return due.length;
}
let timer = null;
export function startSocialScheduler() {
  if (timer || IS_VERCEL) return;
  timer = setInterval(() => dueSocial().catch(e => console.warn('[redes] programador:', e.message)), 30000);
  setTimeout(() => dueSocial().catch(() => {}), 5000);
}

// ---------- Rutas ----------
const page = (ok, msg) => `<!doctype html><meta charset="utf-8"><title>Clippers Pro</title>
<body style="font-family:system-ui,-apple-system,sans-serif;background:#0f1013;color:#eee;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center;max-width:520px;padding:24px"><div style="font-size:48px">${ok ? '✅' : '⚠️'}</div>
<h2>${ok ? 'Cuenta conectada' : 'No se pudo conectar'}</h2><p style="color:#aaa">${String(msg).replace(/[<>&]/g, '')}</p></div></body>`;
const accOut = a => ({ id: a.id, platform: a.platform, name: a.name, avatar: a.avatar, data: { pageName: a.data?.pageName }, created_at: a.created_at });

export function mountSocial(app, h) {
  app.use('/api/social', (req, res, next) => ensureTables().then(() => next(), next));
  const redirectOrPage = (req, res, ok, msg) => globalThis.__desktop ? res.status(ok ? 200 : 400).send(page(ok, msg)) : res.redirect('/#/canales?' + (ok ? 'ok=' : 'error=') + encodeURIComponent(msg));
  app.get('/api/social/meta/auth', async (req, res) => { try { res.redirect(await metaAuthUrl(req)); } catch (e) { res.redirect('/#/canales?error=' + encodeURIComponent(e.message)); } });
  app.get('/api/social/tiktok/auth', async (req, res) => { try { res.redirect(await ttAuthUrl(req)); } catch (e) { res.redirect('/#/canales?error=' + encodeURIComponent(e.message)); } });
  app.get('/api/social/meta/callback', async (req, res) => {
    try { const n = await metaCallback(req); redirectOrPage(req, res, true, `Facebook/Instagram conectado (${n} cuenta${n === 1 ? '' : 's'}). Ya puedes volver a Clippers Pro.`); }
    catch (e) { redirectOrPage(req, res, false, e.message); }
  });
  app.get('/api/social/tiktok/callback', async (req, res) => {
    try { await ttCallback(req); redirectOrPage(req, res, true, 'TikTok conectado. Ya puedes volver a Clippers Pro.'); }
    catch (e) { redirectOrPage(req, res, false, e.message); }
  });
  app.get('/api/social/status', h(async (req, res) => res.json({
    meta: !!((await getSetting('meta_app_id')) && (await getSetting('meta_app_secret'))),
    tiktok: !!((await getSetting('tiktok_client_key')) && (await getSetting('tiktok_client_secret'))),
    redirects: { meta: metaRedirect(req), tiktok: ttRedirect(req) },
  })));
  app.get('/api/social/accounts', h(async (req, res) => res.json((await q('SELECT * FROM social_accounts ORDER BY platform, name')).map(accOut))));
  app.delete('/api/social/accounts/:id', h(async (req, res) => { await q('DELETE FROM social_accounts WHERE id = $1', [req.params.id]); res.json({ ok: true }); }));
  app.get('/api/social/posts', h(async (req, res) => res.json(await q(`SELECT p.*, a.platform, a.name AS account FROM social_posts p LEFT JOIN social_accounts a ON a.id = p.account_id
    ORDER BY COALESCE(p.scheduled_at, p.created_at) DESC LIMIT 100`))));
  app.delete('/api/social/posts/:id', h(async (req, res) => {
    const p = await one('SELECT status FROM social_posts WHERE id = $1', [req.params.id]);
    if (p && !['scheduled', 'error'].includes(p.status)) throw fail('Solo se pueden cancelar publicaciones pendientes.');
    await q('DELETE FROM social_posts WHERE id = $1', [req.params.id]); res.json({ ok: true });
  }));
  app.post('/api/social/posts/:id/retry', h(async (req, res) => {
    await q("UPDATE social_posts SET status = 'queued', error = NULL WHERE id = $1 AND status = 'error'", [req.params.id]);
    await enqueue('social.publish', { postId: Number(req.params.id) }); res.json({ ok: true });
  }));
  // Publicar o programar un clip (o el vídeo de un proyecto, p. ej. un ranking) en varias cuentas a la vez
  app.post('/api/social/posts', h(async (req, res) => {
    const b = req.body || {};
    let file = null;
    if (b.clip_id) {
      const c = await one('SELECT file, variants FROM clips WHERE id = $1', [b.clip_id]);
      file = b.lang ? c?.variants?.[b.lang]?.file : c?.file;
    } else if (b.project_id) file = (await one('SELECT output FROM projects WHERE id = $1', [b.project_id]))?.output;
    if (!file) throw fail('El vídeo aún no está listo.');
    const ids = (b.accounts || []).map(Number).filter(Boolean);
    if (!ids.length) throw fail('Elige al menos una cuenta.');
    const at = b.at ? new Date(b.at) : null;
    if (at && isNaN(at)) throw fail('Fecha no válida.');
    const out = [];
    for (const id of ids) {
      const acc = await one('SELECT id, platform FROM social_accounts WHERE id = $1', [id]);
      if (!acc) continue;
      // Facebook programa por su cuenta si faltan más de 15 min: se sube ya y no hace falta tener la app abierta
      const native = acc.platform === 'facebook' && at && at.getTime() - Date.now() > 15 * 60000;
      const later = at && at.getTime() > Date.now() + 30000 && !native;
      const p = await one(`INSERT INTO social_posts (account_id, clip_id, project_id, file, caption, mode, scheduled_at, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [id, b.clip_id || null, b.project_id || null, file, String(b.caption || '').slice(0, 2200), acc.platform === 'tiktok' ? (b.tiktokMode === 'direct' ? 'direct' : 'draft') : (native ? 'native' : 'now'),
          at ? at.toISOString() : null, later ? 'scheduled' : 'queued']);
      if (!later) await enqueue('social.publish', { postId: p.id });
      out.push(p.id);
    }
    res.json({ ok: true, posts: out });
  }));
}
export { publicUrl };
