import fs from 'node:fs';
import { getSetting, requireKey } from '../settings.js';
import { apiError } from './llm.js';

/** Genera voz en off (mp3) con el proveedor configurado. */
export async function tts(text, outFile, { voice: voiceOverride } = {}) {
  // voiceOverride: 'openai:nova' | 'elevenlabs:<voiceId>' (voz propia del personaje)
  let [provider, forcedVoice] = voiceOverride ? voiceOverride.split(':') : [];
  provider = provider || await getSetting('tts_provider');
  let r;
  if (provider === 'elevenlabs') {
    const voice = forcedVoice || await getSetting('elevenlabs_voice_id');
    r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': await requireKey('elevenlabs_key', 'generar la voz'), 'content-type': 'application/json' },
      body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' }),
    });
  } else {
    r = await fetch((process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1') + '/audio/speech', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + await requireKey('openai_key', 'generar la voz'), 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: forcedVoice || await getSetting('openai_voice'), input: text, response_format: 'mp3' }),
    });
  }
  if (!r.ok) throw new Error(`Error de voz (${r.status}): ${apiError(await r.text())}`);
  fs.writeFileSync(outFile, Buffer.from(await r.arrayBuffer()));
  return outFile;
}

/** Busca un vídeo de stock en Pexels. */
async function pexelsSearch(key, query, orientation, exclude) {
  const r = await fetch(`https://api.pexels.com/videos/search?per_page=15&orientation=${orientation}&query=${encodeURIComponent(query)}`, {
    headers: { authorization: key }, signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`Error de Pexels (${r.status}): ${apiError(await r.text())}`);
  const j = await r.json();
  for (const v of j.videos || []) {
    if (exclude.has('px' + v.id)) continue;
    const files = (v.video_files || []).filter(f => f.file_type === 'video/mp4' && f.width && f.height)
      .sort((a, b) => Math.abs(a.height - 1080) - Math.abs(b.height - 1080));
    if (files[0]) { exclude.add('px' + v.id); return { url: files[0].link, id: 'px' + v.id, duration: v.duration, source: 'Pexels' }; }
  }
  return null;
}

/** Busca un vídeo de stock en Pixabay (gratis, sin atribución obligatoria). */
async function pixabaySearch(key, query, orientation, exclude) {
  const qs = new URLSearchParams({ key, q: String(query).slice(0, 100), per_page: '30', safesearch: 'true', video_type: 'film' });
  const r = await fetch(`https://pixabay.com/api/videos/?${qs}`, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Error de Pixabay (${r.status}): ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const wantPortrait = orientation === 'portrait';
  // Se prefieren vídeos con la orientación del proyecto; si no hay, cualquiera (se encuadra igual)
  const hits = (j.hits || []).filter(h => !exclude.has('pb' + h.id));
  const pickFile = h => Object.values(h.videos || {}).filter(f => f?.url && f.width && f.height)
    .sort((a, b) => Math.abs(Math.max(a.width, a.height) - 1920) - Math.abs(Math.max(b.width, b.height) - 1920))[0];
  const oriented = hits.filter(h => { const f = pickFile(h); return f && (f.height > f.width) === wantPortrait; });
  for (const h of [...oriented, ...hits]) {
    const f = pickFile(h);
    if (f) { exclude.add('pb' + h.id); return { url: f.url, id: 'pb' + h.id, duration: h.duration, source: 'Pixabay' }; }
  }
  return null;
}

/**
 * Busca un vídeo de stock: Pexels si hay clave, y si no encuentra nada o falla, Pixabay.
 * Devuelve { url, id, duration, source } o null.
 */
export async function stockVideo(query, { orientation = 'landscape', exclude = new Set() } = {}) {
  const pexels = await getSetting('pexels_key'), pixabay = await getSetting('pixabay_key');
  if (!pexels && !pixabay) throw new Error('Falta una clave de vídeos de stock (Pixabay o Pexels). Añádela en Ajustes y claves.');
  let lastErr = null;
  for (const [key, fn] of [[pexels, pexelsSearch], [pixabay, pixabaySearch]]) {
    if (!key) continue;
    try { const v = await fn(key, query, orientation, exclude); if (v) return v; }
    catch (e) { lastErr = e; console.warn('stock:', e.message); }
  }
  if (lastErr) throw lastErr;
  return null;
}
/** Compatibilidad con el nombre anterior. */
export const pexelsVideo = stockVideo;

export async function download(url, outFile) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`No se pudo descargar ${url} (${r.status})`);
  const { pipeline } = await import('node:stream/promises');
  const { Readable } = await import('node:stream');
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(outFile));
  return outFile;
}

// ===================== Generación de imágenes (varios proveedores) =====================
// Proveedores: openai (gpt-image), gemini ("Nano Banana", modelos de imagen de Gemini) y pollinations (gratis).
// Si el elegido falla, se prueban los demás con clave; Pollinations queda siempre al final como opción gratuita.

const ratioOf = size => { const [w, h] = String(size).split('x').map(Number); return !w || !h ? '1:1' : w > h ? '16:9' : h > w ? '9:16' : '1:1'; };
const sniffMime = b => b[0] === 0x89 ? 'image/png' : b[0] === 0xff ? 'image/jpeg' : b[0] === 0x52 ? 'image/webp' : 'image/png';

async function openaiImage(prompt, { size, references }) {
  const key = await requireKey('openai_key', 'generar imágenes con OpenAI');
  const model = await getSetting('image_model');
  const base = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  let r;
  if (references.length) {
    const form = new FormData();
    form.append('model', model); form.append('prompt', prompt); form.append('size', size);
    references.slice(0, 4).forEach((b, i) => form.append('image[]', new Blob([b], { type: sniffMime(b) }), `ref${i}.png`));
    r = await fetch(base + '/images/edits', { method: 'POST', headers: { authorization: 'Bearer ' + key }, body: form, signal: AbortSignal.timeout(150000) });
  } else {
    r = await fetch(base + '/images/generations', {
      method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt, size, n: 1 }), signal: AbortSignal.timeout(150000),
    });
  }
  const text = await r.text();
  if (!r.ok) throw new Error(`OpenAI imagen (${r.status}): ${apiError(text)}`);
  const d = JSON.parse(text).data?.[0];
  if (d?.b64_json) return Buffer.from(d.b64_json, 'base64');
  if (d?.url) return Buffer.from(await (await fetch(d.url)).arrayBuffer());
  throw new Error('OpenAI no devolvió ninguna imagen.');
}

// --- Gemini: se buscan los modelos de imagen disponibles con la clave ---
let geminiImageModels = { at: 0, list: [] };
const GEMINI_BASE = () => process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';
async function geminiImageChain(key) {
  const fixed = String(await getSetting('gemini_image_model') || '').trim();
  if (fixed) return [fixed];
  if (Date.now() - geminiImageModels.at > 6 * 3600e3 || !geminiImageModels.list.length) {
    try {
      const r = await fetch(`${GEMINI_BASE()}/models?pageSize=200`, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(10000) });
      if (r.ok) {
        const names = ((await r.json()).models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
          .map(m => String(m.name).replace(/^models\//, '')).filter(n => /^gemini-.*image/.test(n) && !/tts|audio|embed/.test(n));
        const ver = n => parseFloat((n.match(/^gemini-(\d+(?:\.\d+)?)/) || [0, 0])[1]);
        names.sort((a, b) => ver(b) - ver(a) || (/flash/.test(a) ? 0 : 1) - (/flash/.test(b) ? 0 : 1)); // los más nuevos y rápidos primero
        geminiImageModels = { at: Date.now(), list: names };
      }
    } catch {}
  }
  return geminiImageModels.list.length ? geminiImageModels.list.slice(0, 3) : ['gemini-2.5-flash-image'];
}

async function geminiImage(prompt, { size, references }) {
  const key = await requireKey('gemini_key', 'generar imágenes con Gemini');
  const parts = [{ text: prompt }, ...references.slice(0, 3).map(b => ({ inlineData: { mimeType: sniffMime(b), data: Buffer.from(b).toString('base64') } }))];
  let lastErr;
  for (const model of await geminiImageChain(key)) {
    // Se intenta con proporción y solo imagen; si el modelo no admite esos campos, se repite sin ellos
    for (const cfg of [{ responseModalities: ['IMAGE'], imageConfig: { aspectRatio: ratioOf(size) } }, { responseModalities: ['TEXT', 'IMAGE'] }]) {
      try {
        const r = await fetch(`${GEMINI_BASE()}/models/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST', headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
          body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: cfg }), signal: AbortSignal.timeout(120000),
        });
        const text = await r.text();
        if (!r.ok) {
          const err = new Error(`Gemini imagen ${model} (${r.status}): ${apiError(text)}`);
          if (r.status === 400 && /imageConfig|aspect|modalit|response_modalities/i.test(text)) { lastErr = err; continue; }
          throw err;
        }
        const img = (JSON.parse(text).candidates?.[0]?.content?.parts || []).find(p => p.inlineData?.data || p.inline_data?.data);
        if (img) return Buffer.from((img.inlineData || img.inline_data).data, 'base64');
        throw new Error(`Gemini ${model} no devolvió ninguna imagen (puede haberla bloqueado por seguridad).`);
      } catch (e) {
        lastErr = e.name === 'TimeoutError' ? new Error(`Gemini ${model} tardó demasiado en generar la imagen.`) : e;
        break; // probar el siguiente modelo
      }
    }
  }
  throw lastErr || new Error('No hay modelos de imagen de Gemini disponibles con esta clave.');
}

// --- Pollinations: gratis sin clave (con marca de agua); con clave, sin marca y mejores modelos ---
async function pollinationsImage(prompt, { size }) {
  const [w, h] = { '9:16': [768, 1344], '16:9': [1344, 768], '1:1': [1024, 1024] }[ratioOf(size)];
  const key = await getSetting('pollinations_key');
  const model = await getSetting('pollinations_model');
  const seed = Math.floor(Math.random() * 1e9);
  const q = new URLSearchParams({ width: w, height: h, nologo: 'true', seed: String(seed), ...(model ? { model } : {}) });
  const url = key ? `https://gen.pollinations.ai/image/${encodeURIComponent(prompt.slice(0, 1500))}?${q}`
    : `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt.slice(0, 1500))}?${q}`;
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(url, { headers: key ? { authorization: 'Bearer ' + key } : {}, signal: AbortSignal.timeout(120000) })
      .catch(e => { throw new Error(e.name === 'TimeoutError' ? 'Pollinations tardó demasiado.' : 'No se pudo conectar con Pollinations: ' + e.message); });
    const buf = Buffer.from(await r.arrayBuffer());
    if (r.ok && /^image\//.test(r.headers.get('content-type') || '')) return buf;
    const body = buf.toString('utf8');
    // Sin clave: límite gratuito (1 imagen cada ~45 s por IP). Se espera lo que indique y se reintenta una vez.
    const wait = Number(body.match(/Retry after (\d+)/i)?.[1] || r.headers.get('retry-after'));
    if ((r.status === 402 || r.status === 429) && attempt === 1 && wait > 0 && wait <= 60) {
      console.log(`[imagen] Pollinations: límite gratuito, esperando ${wait} s…`);
      await new Promise(res => setTimeout(res, (wait + 1) * 1000));
      continue;
    }
    throw new Error(`Pollinations (${r.status}): ${body.slice(0, 200)}${r.status === 402 ? ' — con una clave de Pollinations (Ajustes) no hay límite.' : ''}`);
  }
}

const IMAGE_PROVIDERS = { openai: { fn: openaiImage, key: 'openai_key' }, gemini: { fn: geminiImage, key: 'gemini_key' }, pollinations: { fn: pollinationsImage, key: null } };

/**
 * Genera una imagen con el proveedor elegido en Ajustes; si falla, prueba los demás.
 * size: '1024x1536' (vertical) | '1536x1024' (horizontal) | '1024x1024'.
 * references: Buffers de imágenes del personaje para mantener su aspecto (OpenAI y Gemini).
 */
export async function generateImage(prompt, { size = '1024x1536', references = [], provider } = {}) {
  const preferred = provider || await getSetting('image_provider');
  const order = [preferred];
  if (!provider) for (const p of ['gemini', 'openai', 'pollinations']) if (p !== preferred && (!IMAGE_PROVIDERS[p].key || await getSetting(IMAGE_PROVIDERS[p].key))) order.push(p);
  let lastErr;
  for (const p of order) {
    const prov = IMAGE_PROVIDERS[p];
    if (!prov) continue;
    try {
      const out = await prov.fn(prompt, { size, references });
      if (p !== preferred) console.log(`[imagen] generada con ${p} (respaldo de ${preferred})`);
      return out;
    } catch (e) {
      lastErr = e;
      if (provider) throw e;
      console.warn(`[imagen] ${p} falló: ${e.message.slice(0, 160)}`);
    }
  }
  throw lastErr || new Error('No se pudo generar la imagen.');
}
