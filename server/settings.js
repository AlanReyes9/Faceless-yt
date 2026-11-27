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

export const encryptSecret = t => encrypt(String(t));
export const decryptSecret = b => { try { return decrypt(b); } catch { return null; } };
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
  pollinations_key: { secret: true, label: 'Pollinations API key (opcional: imágenes sin marca de agua)', group: 'Material' },
  pixabay_key: { secret: true, label: 'Pixabay API key (vídeos de stock, gratis)', group: 'Material' },
  pexels_key: { secret: true, label: 'Pexels API key (vídeos de stock, opcional)', group: 'Material' },
  youtube_api_key: { secret: true, label: 'YouTube Data API key (Analizador)', group: 'Material' },
  google_client_id: { secret: false, label: 'Google OAuth Client ID', group: 'Publicar en YouTube' },
  google_client_secret: { secret: true, label: 'Google OAuth Client Secret', group: 'Publicar en YouTube' },

  meta_app_id: { secret: false, default: '', label: 'Meta App ID (Facebook e Instagram)', group: 'Redes sociales' },
  meta_app_secret: { secret: true, default: '', label: 'Meta App Secret', group: 'Redes sociales' },
  meta_config_id: { secret: false, default: '', label: 'Meta Configuration ID (opcional: solo apps con "Facebook Login for Business")', group: 'Redes sociales' },
  tiktok_client_key: { secret: false, default: '', label: 'TikTok Client Key', group: 'Redes sociales' },
  tiktok_client_secret: { secret: true, default: '', label: 'TikTok Client Secret', group: 'Redes sociales' },
  use_cloud: { secret: false, default: '0', label: 'Usar servicios en la nube (con tus claves) en vez de la IA local', options: ['0', '1'], group: 'Nube' },
  llm_provider: { secret: false, default: process.env.DEFAULT_LLM || 'openai', label: 'Proveedor de texto', options: ['local', 'openai', 'anthropic', 'gemini', 'groq', 'openrouter'], group: 'Preferencias' },
  openai_model: { secret: false, default: 'gpt-4.1-mini', label: 'Modelo OpenAI', group: 'Preferencias' },
  anthropic_model: { secret: false, default: 'claude-sonnet-5-5', label: 'Modelo Claude', group: 'Preferencias' },
  gemini_model: { secret: false, default: 'gemini-3.8-flash', label: 'Modelo Gemini', group: 'Preferencias' },
  gemini_fallbacks: { secret: false, default: '', label: 'Modelos Gemini de respaldo (vacío = automático; ej.: gemini-3.8-flash-lite, gemini-3.5-pro)', group: 'Preferencias' },
  groq_model: { secret: false, default: 'openai/gpt-oss-120b', label: 'Modelo Groq (texto)', group: 'Preferencias' },
  openrouter_model: { secret: false, default: 'openai/gpt-4.1-mini', label: 'Modelo OpenRouter', group: 'Preferencias' },
  transcribe_provider: { secret: false, default: process.env.DEFAULT_TRANSCRIBE || 'openai', label: 'Transcripción (local = gratis en tu equipo, solo app de escritorio)', options: ['local', 'openai', 'groq'], group: 'Preferencias' },
  local_llm: { secret: false, default: 'auto', label: 'IA de texto local (auto = rápida en equipos sin gráfica, completa en Mac M)', options: ['auto', 'qwen3-4b', 'qwen2.5-7b'], group: 'Preferencias' },
  brand_logo: { secret: false, default: '', label: 'Logo (marca de agua)', group: 'Marca' },
  brand_frame: { secret: false, default: '', label: 'Marco', group: 'Marca' },
  brand_pos: { secret: false, default: 'tr', label: 'Posición del logo', group: 'Marca' },
  brand_size: { secret: false, default: '0.2', label: 'Tamaño del logo', group: 'Marca' },
  brand_opacity: { secret: false, default: '0.9', label: 'Opacidad del logo', group: 'Marca' },
  outros: { secret: false, default: '[]', label: 'Vídeos finales', group: 'Marca' },
  ytdlp_cookies: { secret: false, default: 'auto', label: 'Cookies del navegador para YouTube (si pide verificar que no eres un bot)', options: ['auto', 'chrome', 'safari', 'firefox', 'edge', 'brave', 'no'], group: 'Preferencias' },
  ytdlp_cookies_learned: { secret: false, default: '', label: 'Navegador de cookies que funcionó', group: 'Marca' },
  groq_whisper_model: { secret: false, default: 'whisper-large-v3', label: 'Modelo de transcripción en Groq (large-v3 = más preciso; turbo = más barato)', options: ['whisper-large-v3', 'whisper-large-v3-turbo'], group: 'Preferencias' },
  whisper_model: { secret: false, default: 'small', label: 'Modelo de transcripción local', options: ['base', 'small', 'small-q5_1', 'large-v3-turbo', 'medium'], group: 'Preferencias' },
  tts_provider: { secret: false, default: 'openai', label: 'Voz (TTS) · system = voces de tu equipo · piper = IA de voz local · gemini = gratis con tu clave de Gemini', options: ['openai', 'elevenlabs', 'system', 'gemini', 'piper'], group: 'Preferencias' },
  piper_voice: { secret: false, default: 'es_MX-claude-high', label: 'Voz local Piper (IA de voz sin internet)', options: ['es_MX-claude-high', 'es_MX-ald-medium', 'es_AR-daniela-high', 'es_ES-davefx-medium', 'es_ES-sharvard-medium#M', 'es_ES-sharvard-medium#F'], group: 'Preferencias' },
  gemini_voice: { secret: false, default: 'Kore', label: 'Voz de Gemini (Kore, Puck, Charon, Aoede…)', group: 'Preferencias' },
  openai_voice: { secret: false, default: 'onyx', label: 'Voz OpenAI', group: 'Preferencias' },
  elevenlabs_voice_id: { secret: false, default: 'pNInz6obpgDQGcFmaJgB', label: 'ElevenLabs voice ID', group: 'Preferencias' },
  cleanup_days: { secret: false, default: '7', label: 'Borrar vídeos originales tras (días, 0 = nunca)', options: ['0', '1', '3', '7', '14', '30'], group: 'Almacenamiento' },
  image_provider: { secret: false, default: process.env.DEFAULT_IMAGE || 'openai', label: 'Proveedor de imágenes (si falla se prueban los demás)', options: ['local', 'openai', 'gemini', 'pollinations'], group: 'Preferencias' },
  image_model: { secret: false, default: 'gpt-image-1', label: 'Modelo de imágenes OpenAI', group: 'Preferencias' },
  gemini_image_model: { secret: false, default: '', label: 'Modelo de imágenes Gemini (vacío = automático)', group: 'Preferencias' },
  pollinations_model: { secret: false, default: 'flux', label: 'Modelo de Pollinations', group: 'Preferencias' },
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

// App de escritorio: la IA es local (texto, imágenes y transcripción) salvo que se active "usar servicios en la nube"
const LOCAL_FOR = { llm_provider: 'LLAMA_SERVER', image_provider: 'SD_CLI', transcribe_provider: 'WHISPER_CLI' };
export async function getSetting(key) {
  if (LOCAL_FOR[key] && process.env[LOCAL_FOR[key]] && (await all()).use_cloud !== '1') return 'local';
  const raw = (await all())[key];
  let v = null;
  if (raw) { try { v = FIELDS[key]?.secret ? decrypt(raw) : raw; } catch { v = null; } }
  v = v || process.env[key.toUpperCase()] || FIELDS[key]?.default || '';
  // Modo nube con el proveedor aún en "local": se usa el primero del que haya clave
  if (v === 'local' && LOCAL_FOR[key]) v = await firstCloud(key);
  return RETIRED[v] || v;
}
const CLOUD_ORDER = {
  llm_provider: [['gemini', 'gemini_key'], ['openai', 'openai_key'], ['groq', 'groq_key'], ['anthropic', 'anthropic_key'], ['openrouter', 'openrouter_key']],
  image_provider: [['gemini', 'gemini_key'], ['openai', 'openai_key'], ['pollinations', null]],
  transcribe_provider: [['groq', 'groq_key'], ['openai', 'openai_key']],
};
async function firstCloud(key) {
  for (const [p, k] of CLOUD_ORDER[key]) if (!k || await getSetting(k)) return p;
  return CLOUD_ORDER[key][0][0];
}
/** Modo de la IA: 'local' (en el equipo) o 'cloud' (servicios en la nube con tus claves). */
export async function aiMode() {
  const localAvailable = !!(process.env.LLAMA_SERVER || process.env.WHISPER_CLI || process.env.SD_CLI);
  const mode = localAvailable && (await all()).use_cloud !== '1' ? 'local' : 'cloud';
  const has = async k => !!(await getSetting(k));
  const keys = { gemini: await has('gemini_key'), openai: await has('openai_key'), groq: await has('groq_key'), anthropic: await has('anthropic_key'), openrouter: await has('openrouter_key') };
  return { mode, localAvailable, keys, cloudReady: Object.values(keys).some(Boolean),
    text: await getSetting('llm_provider'), image: await getSetting('image_provider'), transcribe: await getSetting('transcribe_provider') };
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
