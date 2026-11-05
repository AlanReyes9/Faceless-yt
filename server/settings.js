import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, DATA_DIR } from './db.js';

// Las claves API se guardan cifradas (AES-256-GCM) con una clave maestra del servidor.
function masterKey() {
  let secret = process.env.APP_SECRET;
  if (!secret) {
    const f = path.join(DATA_DIR, '.secret');
    if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    secret = fs.readFileSync(f, 'utf8').trim();
  }
  return crypto.createHash('sha256').update(secret).digest();
}
const KEY = masterKey();

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return 'enc:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
function decrypt(blob) {
  if (!blob?.startsWith('enc:')) return blob;
  const raw = Buffer.from(blob.slice(4), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, raw.subarray(0, 12));
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
  pexels_key: { secret: true, label: 'Pexels API key (vídeos de stock)', group: 'Material' },
  google_client_id: { secret: false, label: 'Google OAuth Client ID', group: 'Publicar en YouTube' },
  google_client_secret: { secret: true, label: 'Google OAuth Client Secret', group: 'Publicar en YouTube' },

  llm_provider: { secret: false, default: 'openai', label: 'Proveedor de texto', options: ['openai', 'anthropic', 'gemini', 'openrouter'], group: 'Preferencias' },
  openai_model: { secret: false, default: 'gpt-4.1-mini', label: 'Modelo OpenAI', group: 'Preferencias' },
  anthropic_model: { secret: false, default: 'claude-sonnet-5-5', label: 'Modelo Claude', group: 'Preferencias' },
  gemini_model: { secret: false, default: 'gemini-2.5-flash', label: 'Modelo Gemini', group: 'Preferencias' },
  openrouter_model: { secret: false, default: 'openai/gpt-4.1-mini', label: 'Modelo OpenRouter', group: 'Preferencias' },
  transcribe_provider: { secret: false, default: 'openai', label: 'Transcripción', options: ['openai', 'groq'], group: 'Preferencias' },
  tts_provider: { secret: false, default: 'openai', label: 'Voz (TTS)', options: ['openai', 'elevenlabs'], group: 'Preferencias' },
  openai_voice: { secret: false, default: 'onyx', label: 'Voz OpenAI', group: 'Preferencias' },
  elevenlabs_voice_id: { secret: false, default: 'pNInz6obpgDQGcFmaJgB', label: 'ElevenLabs voice ID', group: 'Preferencias' },
  caption_color: { secret: false, default: '#FFD400', label: 'Color de palabra resaltada', group: 'Preferencias' },
};

export function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  const v = row ? (FIELDS[key]?.secret ? decrypt(row.value) : row.value) : null;
  return v || process.env[key.toUpperCase()] || FIELDS[key]?.default || '';
}

export function setSettings(obj) {
  const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const del = db.prepare('DELETE FROM settings WHERE key = ?');
  for (const [k, v] of Object.entries(obj)) {
    if (!FIELDS[k]) continue;
    if (v === null || v === '') { del.run(k); continue; }
    if (FIELDS[k].secret && typeof v === 'string' && v.includes('•')) continue; // máscara sin cambios
    up.run(k, FIELDS[k].secret ? encrypt(String(v).trim()) : String(v).trim());
  }
}

// Vista segura para el navegador: los secretos se muestran enmascarados.
export function publicSettings() {
  const out = {};
  for (const [k, f] of Object.entries(FIELDS)) {
    const v = getSetting(k);
    out[k] = f.secret ? (v ? '••••••••' + v.slice(-4) : '') : v;
  }
  return { values: out, fields: FIELDS };
}

export function requireKey(key, what) {
  const v = getSetting(key);
  if (!v) throw new Error(`Falta la clave "${FIELDS[key].label}". Añádela en Ajustes y claves${what ? ' para ' + what : ''}.`);
  return v;
}
