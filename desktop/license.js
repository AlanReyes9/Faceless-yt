// Licencia de la app de escritorio: ID del equipo, inicio de sesión contra el servidor central,
// verificación de la firma (Ed25519, clave pública incluida en la app) y renovación periódica.
import { app, safeStorage } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
export const LICENSE_URL = (process.env.CLIPPERS_LICENSE_URL || 'https://faceless-studio-chi.vercel.app').replace(/\/+$/, '');
const PUBKEY = (() => { try { return fs.readFileSync(path.join(DIR, 'license-pubkey.pem'), 'utf8'); } catch { return null; } })();
const file = () => path.join(app.getPath('userData'), 'license.json');

// ---------- ID del equipo (estable, ligado al hardware/sistema) ----------
let _device = null;
export function deviceId() {
  if (_device) return _device;
  let raw = '';
  try {
    if (process.platform === 'darwin') raw = (execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8' }).match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/) || [])[1] || '';
    else if (process.platform === 'win32') raw = (execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8', windowsHide: true }).match(/MachineGuid\s+REG_SZ\s+(\S+)/) || [])[1] || '';
    else raw = ['/etc/machine-id', '/var/lib/dbus/machine-id'].map(f => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return ''; } }).find(Boolean) || '';
  } catch {}
  if (!raw) { // último recurso: identificador aleatorio guardado (menos robusto)
    const f = path.join(app.getPath('userData'), '.device');
    try { raw = fs.readFileSync(f, 'utf8'); } catch { raw = crypto.randomBytes(16).toString('hex'); fs.writeFileSync(f, raw); }
    raw = 'rand:' + raw;
  }
  return (_device = crypto.createHash('sha256').update('clippers-pro:' + raw).digest('hex'));
}
export const deviceName = () => `${os.hostname()}`.slice(0, 60);

// ---------- Almacenamiento local de la licencia (cifrado con el llavero del sistema si existe) ----------
function readStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return JSON.parse(raw.enc ? safeStorage.decryptString(Buffer.from(raw.enc, 'base64')) : raw.plain);
  } catch { return {}; }
}
function writeStore(obj) {
  const json = JSON.stringify(obj);
  const data = safeStorage.isEncryptionAvailable() ? { enc: safeStorage.encryptString(json).toString('base64') } : { plain: json };
  fs.writeFileSync(file(), JSON.stringify(data), { mode: 0o600 });
}
export function clearLicense() { const s = readStore(); writeStore({ username: s.username }); }

// ---------- Verificación ----------
function verify(token) {
  if (!PUBKEY) return null;
  try {
    const [body, sig] = String(token).split('.');
    if (!crypto.verify(null, Buffer.from(body), PUBKEY, Buffer.from(sig, 'base64url'))) return null;
    return JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch { return null; }
}
/** Licencia guardada válida para este equipo (sin conexión). */
export function localLicense() {
  const s = readStore();
  const t = s.token && verify(s.token);
  if (!t || t.d !== deviceId()) return null;
  const now = Date.now();
  if (s.maxSeen && now + 3600e3 < s.maxSeen) return null; // reloj atrasado a mano: exige conexión
  if (t.exp < now) return null;
  writeStore({ ...s, maxSeen: Math.max(s.maxSeen || 0, now) });
  return { ...t, token: s.token };
}

async function call(pathname, body) {
  const r = await fetch(LICENSE_URL + pathname, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `Error del servidor de licencias (${r.status})`), { status: r.status, code: j.code });
  return j;
}
function save(res, username) {
  const t = verify(res.token);
  if (!t || t.d !== deviceId()) throw new Error('La licencia recibida no es válida (firma incorrecta). Actualiza la app.');
  const s = readStore();
  writeStore({ token: res.token, username, expiresAt: res.user?.expiresAt || null, maxSeen: Math.max(s.maxSeen || 0, Date.now()) });
  return t;
}

export async function login(username, password) {
  if (!PUBKEY) throw new Error('Esta versión no tiene la clave de licencias. Descarga la última versión.');
  const res = await call('/api/license/login', { username, password, deviceId: deviceId(), deviceName: deviceName(), platform: process.platform, appVersion: app.getVersion() });
  return save(res, res.user?.username || username);
}

/**
 * Renueva con el servidor. Devuelve { ok } si sigue autorizado, { revoked, message } si el servidor lo deniega,
 * o { offline } si no hay conexión (se sigue con la licencia local mientras no caduque).
 */
export async function refresh() {
  const s = readStore();
  if (!s.token) return { revoked: true, message: '' };
  try {
    const res = await call('/api/license/refresh', { token: s.token, deviceId: deviceId() });
    save(res, s.username);
    return { ok: true };
  } catch (e) {
    if (e.status === 401 || e.status === 403) { clearLicense(); return { revoked: true, message: e.message }; }
    return { offline: true, message: e.message };
  }
}

export function licenseInfo() {
  const s = readStore();
  const t = s.token && verify(s.token);
  return { username: s.username || '', expiresAt: s.expiresAt || (t?.sub ? new Date(t.sub).toISOString() : null), deviceShort: deviceId().slice(0, 12) };
}
