// Sistema de licencias / suscripciones.
// El servidor central (la web en Vercel + Neon) guarda los usuarios autorizados, sus contraseñas (scrypt)
// y los equipos de cada uno. La app de escritorio inicia sesión con usuario + contraseña + ID del equipo y
// recibe una licencia firmada con Ed25519 que verifica con la clave pública incluida en la app.
import crypto from 'node:crypto';
import { q, one } from './db.js';
import { internalSecret } from './settings.js';

const TOKEN_DAYS = 3;          // la licencia sirve sin conexión hasta 3 días; la app la renueva cada hora
const REFRESH_GRACE_DAYS = 30; // una licencia caducada hace menos de esto se puede renovar sin contraseña
const MAX_FAILS = 8, LOCK_MIN = 15;

// ---------- Contraseñas (scrypt) ----------
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$${salt.toString('base64')}$${hash.toString('base64')}`;
}
export function checkPassword(pw, stored) {
  try {
    const [alg, N, salt, hash] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const want = Buffer.from(hash, 'base64');
    const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), want.length, { N: Number(N), r: 8, p: 1 });
    return crypto.timingSafeEqual(got, want);
  } catch { return false; }
}

// ---------- Firma de licencias (Ed25519, clave derivada de APP_SECRET) ----------
let keys = null;
function signingKeys() {
  if (keys) return keys;
  const base = process.env.APP_SECRET || internalSecret();
  const seed = Buffer.from(crypto.hkdfSync('sha256', base, 'clippers-pro', 'license-signing-v1', 32));
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  const publicKey = crypto.createPublicKey(privateKey);
  return (keys = { privateKey, publicKey, publicPem: publicKey.export({ type: 'spki', format: 'pem' }) });
}
export const publicKeyPem = () => signingKeys().publicPem;
const b64u = b => Buffer.from(b).toString('base64url');

export function signToken(payload) {
  const body = b64u(JSON.stringify(payload));
  return `${body}.${b64u(crypto.sign(null, Buffer.from(body), signingKeys().privateKey))}`;
}
/** Verifica una licencia con una clave pública PEM. Devuelve el contenido o null. */
export function verifyToken(token, pem = publicKeyPem()) {
  try {
    const [body, sig] = String(token).split('.');
    if (!crypto.verify(null, Buffer.from(body), pem, Buffer.from(sig, 'base64url'))) return null;
    return JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch { return null; }
}

// ---------- Sesión de administrador en la web (cookie firmada) ----------
const hmac = v => crypto.createHmac('sha256', internalSecret() + ':admin').update(v).digest('base64url');
export const adminCookie = uid => { const v = b64u(JSON.stringify({ uid, exp: Date.now() + 14 * 864e5 })); return `${v}.${hmac(v)}`; };
const sessionCache = new Map();
export async function adminFromReq(req) {
  const c = req.cookies?.adm;
  if (!c) return null;
  const [v, mac] = c.split('.');
  if (!mac || hmac(v) !== mac) return null;
  let s; try { s = JSON.parse(Buffer.from(v, 'base64url').toString()); } catch { return null; }
  if (!(s.exp > Date.now())) return null;
  const hit = sessionCache.get(s.uid);
  if (hit && hit.at > Date.now() - 60000) return hit.user;
  const user = await one("SELECT id, username, role FROM license_users WHERE id = $1 AND active AND role = 'admin'", [s.uid]).catch(() => null);
  sessionCache.set(s.uid, { at: Date.now(), user });
  return user;
}
export const hasAdmin = async () => !!(await one("SELECT 1 FROM license_users WHERE role = 'admin' AND active LIMIT 1").catch(() => null));

// ---------- Comprobaciones comunes ----------
const fail = (status, error, extra = {}) => Object.assign(new Error(error), { status, extra });
const fmtDate = d => new Date(d).toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' });
function checkUser(u) {
  if (!u.active) throw fail(403, 'Tu cuenta está desactivada. Contacta con el administrador.', { code: 'inactive' });
  if (u.expires_at && new Date(u.expires_at) < new Date()) throw fail(403, `Tu suscripción venció el ${fmtDate(u.expires_at)}. Renuévala para seguir usando Clippers Pro.`, { code: 'expired' });
}
async function bindDevice(u, dev, ip) {
  const d = await one('SELECT * FROM license_devices WHERE user_id = $1 AND device_id = $2', [u.id, dev.deviceId]);
  if (d) {
    if (d.blocked) throw fail(403, 'Este equipo está bloqueado para tu cuenta. Contacta con el administrador.', { code: 'device_blocked' });
    await q('UPDATE license_devices SET last_seen = now(), last_ip = $2, name = COALESCE($3, name), app_version = COALESCE($4, app_version) WHERE id = $1', [d.id, ip, dev.deviceName || null, dev.appVersion || null]);
    return;
  }
  const n = (await one('SELECT COUNT(*)::int AS n FROM license_devices WHERE user_id = $1 AND NOT blocked', [u.id])).n;
  if (n >= (u.max_devices || 1)) throw fail(403, `Tu cuenta ya está activada en ${n} equipo${n === 1 ? '' : 's'} (máximo ${u.max_devices || 1}). Pide al administrador que libere un equipo.`, { code: 'device_limit' });
  await q('INSERT INTO license_devices (user_id, device_id, name, platform, app_version, last_ip) VALUES ($1,$2,$3,$4,$5,$6)',
    [u.id, dev.deviceId, String(dev.deviceName || '').slice(0, 80), String(dev.platform || '').slice(0, 20), String(dev.appVersion || '').slice(0, 20), ip]);
}
function issue(u, deviceId) {
  const now = Date.now();
  let exp = now + TOKEN_DAYS * 864e5;
  if (u.expires_at) exp = Math.min(exp, new Date(u.expires_at).getTime());
  return { token: signToken({ v: 1, uid: u.id, u: u.username, d: deviceId, iat: now, exp, sub: u.expires_at ? new Date(u.expires_at).getTime() : null }),
    user: { username: u.username, expiresAt: u.expires_at, maxDevices: u.max_devices } };
}
const validDevice = d => typeof d === 'string' && /^[a-f0-9]{32,128}$/i.test(d);
const ipOf = req => String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().slice(0, 60);
const ipFails = new Map();

// ---------- Rutas ----------
export function mountLicense(app, h) {
  const wrap = fn => h(async (req, res) => {
    try { await fn(req, res); } catch (e) { if (e.status) return res.status(e.status).json({ error: e.message, ...e.extra }); throw e; }
  });

  app.get('/api/license/pubkey', (req, res) => res.type('text/plain').send(publicKeyPem()));
  app.get('/api/license/status', wrap(async (req, res) => res.json({ hasAdmin: await hasAdmin() })));

  // Primer administrador: solo si aún no existe ninguno y demostrando que conoces el APP_SECRET del servidor
  app.post('/api/license/setup', wrap(async (req, res) => {
    if (await hasAdmin()) throw fail(409, 'Ya hay un administrador. Inicia sesión.');
    const { appSecret, username, password } = req.body || {};
    const want = Buffer.from(String(process.env.APP_SECRET || '')), got = Buffer.from(String(appSecret || ''));
    if (!want.length || want.length !== got.length || !crypto.timingSafeEqual(want, got)) throw fail(403, 'El APP_SECRET no coincide con el del servidor (Vercel → Settings → Environment Variables).');
    if (!/^[\w.@-]{3,40}$/.test(username || '')) throw fail(400, 'Usuario no válido (3–40 caracteres: letras, números, . _ - @).');
    if (String(password || '').length < 10) throw fail(400, 'La contraseña del administrador debe tener al menos 10 caracteres.');
    const u = await one("INSERT INTO license_users (username, pass_hash, role, max_devices) VALUES ($1,$2,'admin',5) RETURNING id", [username.toLowerCase(), hashPassword(password)]);
    res.cookie('adm', adminCookie(u.id), { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 14 * 864e5 });
    res.json({ ok: true });
  }));

  // Inicio de sesión en la web (solo administradores)
  app.post('/api/license/admin-login', wrap(async (req, res) => {
    const { username, password } = req.body || {};
    const u = await one('SELECT * FROM license_users WHERE username = $1', [String(username || '').toLowerCase()]);
    if (u?.locked_until && new Date(u.locked_until) > new Date()) throw fail(429, `Demasiados intentos. Prueba de nuevo en ${LOCK_MIN} minutos.`);
    if (!u || !checkPassword(password, u.pass_hash) || u.role !== 'admin' || !u.active) {
      if (u) await q(`UPDATE license_users SET failed = failed + 1, locked_until = CASE WHEN failed + 1 >= ${MAX_FAILS} THEN now() + interval '${LOCK_MIN} minutes' ELSE locked_until END WHERE id = $1`, [u.id]);
      throw fail(401, 'Usuario o contraseña incorrectos (o la cuenta no es de administrador).');
    }
    await q('UPDATE license_users SET failed = 0, locked_until = NULL, last_login = now() WHERE id = $1', [u.id]);
    res.cookie('adm', adminCookie(u.id), { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 14 * 864e5 });
    res.json({ ok: true });
  }));
  app.post('/api/license/admin-logout', (req, res) => { res.clearCookie('adm'); res.json({ ok: true }); });

  // App de escritorio: inicio de sesión con usuario + contraseña + ID del equipo
  app.post('/api/license/login', wrap(async (req, res) => {
    const b = req.body || {};
    const ip = ipOf(req);
    const f = ipFails.get(ip);
    if (f && f.n >= 20 && f.at > Date.now() - LOCK_MIN * 60000) throw fail(429, 'Demasiados intentos desde esta conexión. Espera unos minutos.');
    if (!validDevice(b.deviceId)) throw fail(400, 'ID de equipo no válido.');
    const u = await one('SELECT * FROM license_users WHERE username = $1', [String(b.username || '').toLowerCase().trim()]);
    if (u?.locked_until && new Date(u.locked_until) > new Date()) throw fail(429, `Demasiados intentos fallidos. Prueba de nuevo en ${LOCK_MIN} minutos.`);
    if (!u || !checkPassword(b.password, u.pass_hash)) {
      ipFails.set(ip, { n: (f && f.at > Date.now() - LOCK_MIN * 60000 ? f.n : 0) + 1, at: Date.now() });
      if (u) await q(`UPDATE license_users SET failed = failed + 1, locked_until = CASE WHEN failed + 1 >= ${MAX_FAILS} THEN now() + interval '${LOCK_MIN} minutes' ELSE locked_until END WHERE id = $1`, [u.id]);
      throw fail(401, 'Usuario o contraseña incorrectos.');
    }
    checkUser(u);
    await bindDevice(u, b, ip);
    await q('UPDATE license_users SET failed = 0, locked_until = NULL, last_login = now() WHERE id = $1', [u.id]);
    res.json(issue(u, b.deviceId));
  }));

  // Renovación periódica (sin contraseña): comprueba que la cuenta y el equipo siguen autorizados
  app.post('/api/license/refresh', wrap(async (req, res) => {
    const { token, deviceId } = req.body || {};
    const t = verifyToken(token);
    if (!t || t.d !== deviceId || !validDevice(deviceId)) throw fail(401, 'Licencia no válida. Inicia sesión de nuevo.', { code: 'invalid' });
    if (t.exp < Date.now() - REFRESH_GRACE_DAYS * 864e5) throw fail(401, 'La sesión caducó. Inicia sesión de nuevo.', { code: 'invalid' });
    const u = await one('SELECT * FROM license_users WHERE id = $1', [t.uid]);
    if (!u) throw fail(401, 'La cuenta ya no existe.', { code: 'invalid' });
    checkUser(u);
    const d = await one('SELECT * FROM license_devices WHERE user_id = $1 AND device_id = $2', [u.id, deviceId]);
    if (!d) throw fail(401, 'Este equipo fue desvinculado de tu cuenta. Inicia sesión de nuevo.', { code: 'invalid' });
    if (d.blocked) throw fail(403, 'Este equipo está bloqueado para tu cuenta.', { code: 'device_blocked' });
    await q('UPDATE license_devices SET last_seen = now(), last_ip = $2 WHERE id = $1', [d.id, ipOf(req)]);
    res.json(issue(u, deviceId));
  }));

  // ---------- Administración (requiere sesión de administrador) ----------
  const admin = fn => wrap(async (req, res) => {
    if (!(await adminFromReq(req))) throw fail(401, 'Solo el administrador puede hacer esto.');
    await fn(req, res);
  });
  app.get('/api/license/users', admin(async (req, res) => {
    const users = await q('SELECT id, username, role, max_devices, expires_at, active, notes, last_login, created_at, locked_until FROM license_users ORDER BY role, username');
    const devs = await q('SELECT id, user_id, device_id, name, platform, app_version, blocked, first_seen, last_seen, last_ip FROM license_devices ORDER BY last_seen DESC');
    res.json(users.map(u => ({ ...u, devices: devs.filter(d => d.user_id === u.id) })));
  }));
  const expiry = b => b.expires_at === null || b.expires_at === '' ? null
    : b.expires_at ? new Date(b.expires_at).toISOString()
    : b.days ? new Date(Date.now() + Number(b.days) * 864e5).toISOString() : undefined;
  app.post('/api/license/users', admin(async (req, res) => {
    const b = req.body || {};
    const username = String(b.username || '').toLowerCase().trim();
    if (!/^[\w.@-]{3,40}$/.test(username)) throw fail(400, 'Usuario no válido (3–40 caracteres: letras, números, . _ - @).');
    if (String(b.password || '').length < 8) throw fail(400, 'La contraseña debe tener al menos 8 caracteres.');
    if (await one('SELECT 1 FROM license_users WHERE username = $1', [username])) throw fail(409, 'Ese usuario ya existe.');
    const u = await one(`INSERT INTO license_users (username, pass_hash, role, max_devices, expires_at, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [username, hashPassword(b.password), b.role === 'admin' ? 'admin' : 'user', Math.max(1, Math.min(20, Number(b.max_devices) || 1)), expiry(b) ?? null, String(b.notes || '').slice(0, 300)]);
    res.json({ id: u.id });
  }));
  app.patch('/api/license/users/:id', admin(async (req, res) => {
    const b = req.body || {}, id = Number(req.params.id);
    const u = await one('SELECT * FROM license_users WHERE id = $1', [id]);
    if (!u) throw fail(404, 'No existe.');
    const me = await adminFromReq(req);
    if (me.id === id && (b.active === false || (b.role && b.role !== 'admin'))) throw fail(400, 'No puedes desactivar ni quitarte el rol de administrador a ti mismo.');
    const set = {};
    if (b.password) { if (String(b.password).length < 8) throw fail(400, 'La contraseña debe tener al menos 8 caracteres.'); set.pass_hash = hashPassword(b.password); set.failed = 0; set.locked_until = null; }
    if (b.max_devices != null) set.max_devices = Math.max(1, Math.min(20, Number(b.max_devices) || 1));
    if (b.addDays) set.expires_at = new Date(Math.max(Date.now(), u.expires_at ? new Date(u.expires_at).getTime() : Date.now()) + Number(b.addDays) * 864e5).toISOString();
    const e = expiry(b); if (e !== undefined) set.expires_at = e;
    if (b.active != null) set.active = !!b.active;
    if (b.notes != null) set.notes = String(b.notes).slice(0, 300);
    if (b.role) set.role = b.role === 'admin' ? 'admin' : 'user';
    if (b.unlock) { set.failed = 0; set.locked_until = null; }
    const keys = Object.keys(set);
    if (keys.length) await q(`UPDATE license_users SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...keys.map(k => set[k])]);
    sessionCache.clear();
    res.json({ ok: true });
  }));
  app.delete('/api/license/users/:id', admin(async (req, res) => {
    const id = Number(req.params.id);
    if ((await adminFromReq(req)).id === id) throw fail(400, 'No puedes borrarte a ti mismo.');
    await q('DELETE FROM license_devices WHERE user_id = $1', [id]);
    await q('DELETE FROM license_users WHERE id = $1', [id]);
    res.json({ ok: true });
  }));
  app.patch('/api/license/devices/:id', admin(async (req, res) => {
    await q('UPDATE license_devices SET blocked = $2 WHERE id = $1', [Number(req.params.id), !!req.body?.blocked]);
    res.json({ ok: true });
  }));
  app.delete('/api/license/devices/:id', admin(async (req, res) => {
    await q('DELETE FROM license_devices WHERE id = $1', [Number(req.params.id)]);
    res.json({ ok: true });
  }));
}
