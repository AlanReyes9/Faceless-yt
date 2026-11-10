import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { q, DATA_DIR, IS_VERCEL } from './db.js';

// Las claves API se guardan cifradas (AES-256-GCM) con una clave maestra del servidor.
function masterKey() {
  let secret = process.env.APP_SECRET;
  if (!secret && IS_VERCEL) throw new Error('Falta la variable de entorno APP_SECRET en Vercel.');
  if (!secret) {
    const f = path.join(DATA_DIR, '.secret');
    if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    secret = fs.readFileSync(f, 'utf8').trim();
  }
  return crypto.createHash('sha256').update(secret).digest();
}
let _key = null;
const key = () => (_key ||= masterKey()); // perezosa: la app arranca aunque falte APP_SECRET

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return 'enc:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
function decrypt(blob) {
  if (!blob?.startsWith('enc:')) return blob;
  const raw = Buffer.from(blob.slice(4), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

// Campos configurables. secret=true → se cifra y nunca se devuelve al navegador.
export const FIELDS = {
  openai_key: { secret: true, label: 'OpenAI API key', group: 'IA de texto / voz / transcripción' },
  anthropic_key: { secret: true, label: 'Anthropic (Claude) API key', group: 'IA de texto / voz / transcripción' },
  gemini_key: { secret: true, label: 'Google Gemini API key', group: 'IA de texto / voz / transcripción' },
  groq_key: { secret: true, label: 'Groq API key (transcripción Whisper barata)', group: 'IA de texto / voz / transcripción' },
  openrouter_key: { secret: true, label: 'OpenRouter API key', group: 'IA de texto / voz / transcripción' },
  elevenlabs_key: { secret: true, label: 'ElevenLabs API key', group: 'Voz' },
  pixabay_key: { secret: true, label: 'Pixabay API key (vídeos de stock, gratis)', group: 'Material' },
  pexels_key: { secret: true, label: 'Pexels API key (vídeos de stock, opcional)', group: 'Material' },
  youtube_api_key: { secret: true, label: 'YouTube Data API key (Analizador)', group: 'Material' },
  google_client_id: { secret: false, label: 'Google OAuth Client ID', group: 'Publicar en YouTube' },
  google_client_secret: { secret: true, label: 'Google OAuth Client Secret', group: 'Publicar en YouTube' },

  llm_provider: { secret: false, default: 'openai', label: 'Proveedor de texto', options: ['openai', 'anthropic', 'gemini', 'groq', 'openrouter'], group: 'Preferencias' },
  openai_model: { secret: false, default: 'gpt-4.1-mini', label: 'Modelo OpenAI', group: 'Preferencias' },
  anthropic_model: { secret: false, default: 'claude-sonnet-5-5', label: 'Modelo Claude', group: 'Preferencias' },
  gemini_model: { secret: false, default: 'gemini-3.8-flash', label: 'Modelo Gemini', group: 'Preferencias' },
  gemini_fallbacks: { secret: false, default: '', label: 'Modelos Gemini de respaldo (vacío = automático; ej.: gemini-3.8-flash-lite, gemini-3.5-pro)', group: 'Preferencias' },
  groq_model: { secret: false, default: 'openai/gpt-oss-120b', label: 'Modelo Groq (texto)', group: 'Preferencias' },
  openrouter_model: { secret: false, default: 'openai/gpt-4.1-mini', label: 'Modelo OpenRouter', group: 'Preferencias' },
  transcribe_provider: { secret: false, default: 'openai', label: 'Transcripción', options: ['openai', 'groq'], group: 'Preferencias' },
  tts_provider: { secret: false, default: 'openai', label: 'Voz (TTS)', options: ['openai', 'elevenlabs'], group: 'Preferencias' },
  openai_voice: { secret: false, default: 'onyx', label: 'Voz OpenAI', group: 'Preferencias' },
  elevenlabs_voice_id: { secret: false, default: 'pNInz6obpgDQGcFmaJgB', label: 'ElevenLabs voice ID', group: 'Preferencias' },
  cleanup_days: { secret: false, default: '7', label: 'Borrar vídeos originales tras (días, 0 = nunca)', options: ['0', '1', '3', '7', '14', '30'], group: 'Almacenamiento' },
  image_model: { secret: false, default: 'gpt-image-1', label: 'Modelo de imágenes OpenAI', group: 'Preferencias' },
  caption_color: { secret: false, default: '#FFD400', label: 'Color de palabra resaltada', group: 'Preferencias' },
};

// Caché corta para no consultar la base de datos en cada llamada
let cache = null, cacheAt = 0;
async function all() {
  if (cache && Date.now() - cacheAt < 5000) return cache;
  const rows = await q('SELECT key, value FROM settings');
  cache = Object.fromEntries(rows.map(r => [r.key, r.value]));
  cacheAt = Date.now();
  return cache;
}

// Modelos retirados por los proveedores → se usa el sustituto automáticamente
const RETIRED = { 'gemini-2.5-flash': 'gemini-3.8-flash', 'gemini-2.0-flash': 'gemini-3.8-flash', 'gemini-1.5-flash': 'gemini-3.8-flash' };

export async function getSetting(key) {
  const raw = (await all())[key];
  let v = null;
  if (raw) { try { v = FIELDS[key]?.secret ? decrypt(raw) : raw; } catch { v = null; } }
  v = v || process.env[key.toUpperCase()] || FIELDS[key]?.default || '';
  return RETIRED[v] || v;
}

export async function setSettings(obj) {
  for (const [k, v] of Object.entries(obj)) {
    if (!FIELDS[k]) continue;
    // Vacío o igual al valor por defecto: no se guarda (así los futuros cambios de valor por defecto se aplican)
    if (v === null || v === '' || (!FIELDS[k].secret && String(v).trim() === FIELDS[k].default)) { await q('DELETE FROM settings WHERE key = $1', [k]); continue; }
    if (FIELDS[k].secret && typeof v === 'string' && v.includes('•')) continue; // máscara sin cambios
    await q('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
      [k, FIELDS[k].secret ? encrypt(String(v).trim()) : String(v).trim()]);
  }
  cache = null;
}

// Vista segura para el navegador: los secretos se muestran enmascarados.
export async function publicSettings() {
  const out = {};
  for (const [k, f] of Object.entries(FIELDS)) {
    const v = await getSetting(k);
    out[k] = f.secret ? (v ? '••••••••' + v.slice(-4) : '') : v;
  }
  return { values: out, fields: FIELDS };
}

export async function requireKey(key, what) {
  const v = await getSetting(key);
  if (!v) throw new Error(`Falta la clave "${FIELDS[key].label}". Añádela en Ajustes y claves${what ? ' para ' + what : ''}.`);
  return v;
}

/** Secreto interno para que el worker se llame a sí mismo. */
export const internalSecret = () => crypto.createHash('sha256').update(key()).update('worker').digest('hex').slice(0, 40);
