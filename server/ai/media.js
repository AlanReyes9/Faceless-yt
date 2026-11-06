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

/** Busca un vídeo de stock en Pexels y devuelve la URL del archivo más adecuado. */
export async function pexelsVideo(query, { orientation = 'landscape', exclude = new Set() } = {}) {
  const key = await requireKey('pexels_key', 'buscar vídeos de stock');
  const r = await fetch(`https://api.pexels.com/videos/search?per_page=15&orientation=${orientation}&query=${encodeURIComponent(query)}`, {
    headers: { authorization: key },
  });
  if (!r.ok) throw new Error(`Error de Pexels (${r.status}): ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  for (const v of j.videos || []) {
    if (exclude.has(v.id)) continue;
    const files = (v.video_files || []).filter(f => f.file_type === 'video/mp4' && f.width && f.height)
      .sort((a, b) => Math.abs(a.height - 1080) - Math.abs(b.height - 1080));
    if (files[0]) { exclude.add(v.id); return { url: files[0].link, id: v.id, duration: v.duration }; }
  }
  return null;
}

export async function download(url, outFile) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`No se pudo descargar ${url} (${r.status})`);
  const { pipeline } = await import('node:stream/promises');
  const { Readable } = await import('node:stream');
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(outFile));
  return outFile;
}

/**
 * Genera una imagen con OpenAI. Si se pasan imágenes de referencia (Buffers png/jpg),
 * usa el endpoint de edición para mantener la apariencia del personaje.
 * size: '1024x1536' (vertical) | '1536x1024' (horizontal) | '1024x1024'
 */
export async function generateImage(prompt, { size = '1024x1536', references = [] } = {}) {
  const key = await requireKey('openai_key', 'generar imágenes');
  const model = await getSetting('image_model');
  let r;
  if (references.length) {
    const form = new FormData();
    form.append('model', model);
    form.append('prompt', prompt);
    form.append('size', size);
    references.slice(0, 4).forEach((b, i) => form.append('image[]', new Blob([b], { type: 'image/png' }), `ref${i}.png`));
    r = await fetch((process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1') + '/images/edits', { method: 'POST', headers: { authorization: 'Bearer ' + key }, body: form });
  } else {
    r = await fetch((process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1') + '/images/generations', {
      method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt, size, n: 1 }),
    });
  }
  const text = await r.text();
  if (!r.ok) throw new Error(`Error de imagen (${r.status}): ${apiError(text)}`);
  const d = JSON.parse(text).data?.[0];
  if (d?.b64_json) return Buffer.from(d.b64_json, 'base64');
  if (d?.url) return Buffer.from(await (await fetch(d.url)).arrayBuffer());
  throw new Error('La API de imágenes no devolvió ninguna imagen.');
}
