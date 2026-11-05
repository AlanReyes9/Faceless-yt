import fs from 'node:fs';
import path from 'node:path';
import { getProject, updateProject, OUTPUT_DIR, WORK_DIR } from '../db.js';
import { ffmpeg, probe, filterPath } from './ffmpeg.js';
import { buildASS } from './ass.js';
import { approximateWords } from '../ai/transcribe.js';
import { chatJSON } from '../ai/llm.js';
import { tts, pexelsVideo, download } from '../ai/media.js';
import { getSetting } from '../settings.js';
import { enqueue } from '../jobs.js';

/** Genera solo el guion (para revisarlo antes de producir). */
export async function generateScript({ topic, minutes = 3, language = 'es', style = 'documental, narrativo, con intriga', niche = '' }) {
  const words = Math.round(minutes * 150);
  return chatJSON(
    'Eres guionista de canales de YouTube faceless (sin cara) con millones de visitas. Escribes guiones de narración en off con un gancho fuerte en los primeros 5 segundos, ritmo alto y retención.',
    `Escribe un guion sobre: "${topic}"${niche ? ` para un canal del nicho "${niche}"` : ''}.
Idioma: ${language}. Estilo: ${style}. Longitud aproximada: ${words} palabras en total.
Divide la narración en escenas de 1 a 3 frases. Para cada escena da una búsqueda corta EN INGLÉS para encontrar un vídeo de stock que la ilustre.
JSON: {"title":"título de YouTube con gancho","description":"descripción SEO de 2-3 párrafos","tags":["..."],"scenes":[{"narration":"...","search":"..."}]}`,
    { maxTokens: 8000 });
}

export async function processLongProject(id) {
  const p = getProject(id);
  const work = path.join(WORK_DIR, `p${id}`);
  fs.mkdirSync(work, { recursive: true });
  const vertical = p.data.options?.format === 'vertical';
  const W = vertical ? 1080 : 1920, H = vertical ? 1920 : 1080;
  const prog = m => updateProject(id, { progress: m });
  try {
    updateProject(id, { status: 'processing', error: null });
    let script = p.data.script;
    if (!script?.scenes?.length) {
      prog('Escribiendo el guion con IA…');
      script = await generateScript({ ...p.data.options, topic: p.data.options.topic });
      p.data.script = script;
      updateProject(id, { data: p.data, title: script.title || p.title });
    }
    const used = new Set();
    const hasPexels = !!getSetting('pexels_key');
    const parts = [];
    for (let i = 0; i < script.scenes.length; i++) {
      const s = script.scenes[i];
      prog(`Escena ${i + 1}/${script.scenes.length}: voz y material…`);
      const voice = path.join(work, `voice_${i}.mp3`);
      await tts(s.narration, voice);
      const dur = (await probe(voice)).duration + 0.25;

      let bgInput = ['-f', 'lavfi', '-i', `color=c=0x15171c:s=${W}x${H}:r=30`];
      if (hasPexels) {
        const v = await pexelsVideo(s.search || script.title, { orientation: vertical ? 'portrait' : 'landscape', exclude: used }).catch(() => null);
        if (v) {
          const stock = path.join(work, `stock_${i}.mp4`);
          await download(v.url, stock);
          bgInput = ['-stream_loop', '-1', '-i', stock];
        }
      }
      const assFile = path.join(work, `scene_${i}.ass`);
      const words = approximateWords([{ start: 0, end: dur - 0.25, text: s.narration }]);
      fs.writeFileSync(assFile, buildASS(words, {
        duration: dur, highlight: getSetting('caption_color'),
        captionMarginV: vertical ? 520 : 90, wordsPerGroup: vertical ? 3 : 5,
        captions: p.data.options?.captions !== false,
      width: W, height: H, capSize: vertical ? 80 : 60,
      }));
      const out = path.join(work, `part_${i}.mp4`);
      await ffmpeg([...bgInput, '-i', voice, '-t', dur.toFixed(3),
        '-filter_complex', `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=30,eq=brightness=-0.05,ass='${filterPath(assFile)}'[v];[1:a]apad,aresample=44100[a]`,
        '-map', '[v]', '-map', '[a]', '-t', dur.toFixed(3),
        '-c:v', 'libx264', '-preset', process.env.X264_PRESET || 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2', out]);
      parts.push(out);
    }
    prog('Uniendo escenas…');
    const list = path.join(work, 'concat.txt');
    fs.writeFileSync(list, parts.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
    const name = `p${id}_full_${Date.now()}.mp4`;
    await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', path.join(OUTPUT_DIR, name)]);
    if (p.output_path) fs.rmSync(path.join(OUTPUT_DIR, p.output_path), { force: true });
    const info = await probe(path.join(OUTPUT_DIR, name));
    updateProject(id, { status: 'ready', output_path: name, duration: info.duration, progress: 'Vídeo listo' });
    fs.rmSync(work, { recursive: true, force: true });
  } catch (e) {
    updateProject(id, { status: 'error', error: e.message, progress: null });
  }
}

export const queueLong = id => enqueue(`long ${id}`, () => processLongProject(id));
