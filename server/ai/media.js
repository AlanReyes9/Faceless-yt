import fs from 'node:fs';
import { getSetting, requireKey } from '../settings.js';
import { apiError } from './llm.js';

/** Genera voz en off (mp3) con el proveedor configurado. */
export async function tts(text, outFile) {
  const provider = getSetting('tts_provider');
  let r;
  if (provider === 'elevenlabs') {
    const voice = getSetting('elevenlabs_voice_id');
    r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': requireKey('elevenlabs_key', 'generar la voz'), 'content-type': 'application/json' },
      body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' }),
    });
  } else {
    r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + requireKey('openai_key', 'generar la voz'), 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: getSetting('openai_voice'), input: text, response_format: 'mp3' }),
    });
  }
  if (!r.ok) throw new Error(`Error de voz (${r.status}): ${apiError(await r.text())}`);
  fs.writeFileSync(outFile, Buffer.from(await r.arrayBuffer()));
  return outFile;
}

/** Busca un vídeo de stock en Pexels y devuelve la URL del archivo más adecuado. */
export async function pexelsVideo(query, { orientation = 'landscape', exclude = new Set() } = {}) {
  const key = requireKey('pexels_key', 'buscar vídeos de stock');
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
  fs.writeFileSync(outFile, Buffer.from(await r.arrayBuffer()));
  return outFile;
}
