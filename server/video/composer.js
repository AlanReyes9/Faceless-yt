// Motor de composición por escenas: voz en off + imagen/vídeo + subtítulos → MP4.
// Lo usan "Vídeo completo", "Creador de anuncios IA", "Montar mi material" y "Personaje IA".
import fs from 'node:fs';
import path from 'node:path';
import { one, getProject, updateProject, WORK_DIR } from '../db.js';
import { ffmpeg, probe, assFilter } from './ffmpeg.js';
import { buildASS } from './ass.js';
import { wordTimings } from '../ai/transcribe.js';
import { chatJSON } from '../ai/llm.js';
import { tts, stockVideo, download, generateImage } from '../ai/media.js';
import { getSetting } from '../settings.js';
import { register, enqueue } from '../jobs.js';
import { saveFile, saveBuffer, inputPath, toLocal, removeFile } from '../storage.js';

const IMG_EXT = /\.(png|jpe?g|webp|gif|bmp|avif)(\?|$)/i;

// ---------- Guiones ----------
export async function generateScript({ topic, minutes = 3, language = 'Español', style = 'documental, narrativo, con intriga', niche = '', character }) {
  const words = Math.round(minutes * 150);
  return chatJSON(
    'Eres guionista de canales de YouTube faceless (sin cara) con millones de visitas. Escribes guiones de narración en off con un gancho fuerte en los primeros 5 segundos, ritmo alto y retención.',
    `Escribe un guion sobre: "${topic}"${niche ? ` para un canal del nicho "${niche}"` : ''}.
Idioma: ${language}. Estilo: ${style}. Longitud aproximada: ${words} palabras en total.
${character ? `El narrador y protagonista visual es el personaje "${character.name}": ${character.personality || ''}. Habla en primera persona con su personalidad.` : ''}
Divide la narración en escenas de 1 a 3 frases. Para cada escena da:
- "search": búsqueda corta EN INGLÉS para encontrar un vídeo de stock que la ilustre
- "image_prompt": descripción visual EN INGLÉS de la imagen ideal para la escena${character ? ' (incluyendo al personaje)' : ''}
JSON: {"title":"título de YouTube con gancho","description":"descripción SEO de 2-3 párrafos","tags":["..."],"scenes":[{"narration":"...","search":"...","image_prompt":"..."}]}`,
    { maxTokens: 8000 });
}

export async function generateAdScript({ product, description = '', audience = '', offer = '', cta = 'Compra ahora', seconds = 30, language = 'Español', tone = 'enérgico y directo', images = 0 }) {
  const res = await chatJSON(
    'Eres un copywriter de anuncios en vídeo para TikTok, Reels y YouTube Shorts (estilo UGC / direct response). Escribes anuncios que enganchan en el primer segundo, muestran el problema, la solución y cierran con una llamada a la acción clara.',
    `Producto: ${product}
Descripción: ${description}
Público objetivo: ${audience || 'general'}
Oferta: ${offer || 'ninguna'}
Llamada a la acción: ${cta}
Duración: ${seconds} segundos (≈ ${Math.round(seconds * 2.5)} palabras de locución). Idioma: ${language}. Tono: ${tone}.
Hay ${images} imágenes del producto disponibles (índices 0 a ${Math.max(0, images - 1)}).
Divide el anuncio en escenas cortas (1 frase). Para cada escena indica "image" (índice de imagen del producto a mostrar, o null) y "search" (búsqueda EN INGLÉS de vídeo de stock si no usas imagen).
Añade "overlay" (texto en pantalla de máx. 5 palabras) en las escenas clave. La última escena debe ser la llamada a la acción con overlay.
JSON: {"title":"nombre interno del anuncio","hooks":["3 ganchos alternativos"],"description":"texto para el post","tags":["..."],"scenes":[{"narration":"...","image":0,"search":"...","overlay":"..."}]}`,
    { maxTokens: 4000 });
  return res;
}

export async function generateMontageScript({ topic, ownScript: script, notes = [], language = 'Español', style = 'cercano y dinámico' }) {
  const n = notes.length;
  return chatJSON(
    'Eres guionista y editor de vídeo. Escribes la narración en off que acompaña a los clips e imágenes que te da el usuario.',
    `${script ? `Divide este guion en exactamente ${n} escenas, sin cambiar su sentido:\n"""${script}"""` : `Tema del vídeo: "${topic}". Escribe la narración para exactamente ${n} escenas.`}
Idioma: ${language}. Estilo: ${style}.
Material de cada escena (en orden): ${notes.map((x, i) => `${i + 1}. ${x || 'sin descripción'}`).join(' | ')}
JSON: {"title":"título de YouTube","description":"descripción SEO","tags":["..."],"scenes":[{"narration":"..."}]}  (exactamente ${n} escenas)`,
    { maxTokens: 6000 });
}

// ---------- Filtros ----------
/** Encaja un visual en W×H: si la proporción es parecida rellena; si no, fondo difuminado + centrado. */
function fitFilter(W, H, iw, ih, input = '[0:v]') {
  const ratio = iw && ih ? (iw / ih) / (W / H) : 1;
  if (ratio > 0.85 && ratio < 1.18) return `${input}scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`;
  const sw = Math.round(W / 4), sh = Math.round(H / 4);
  return `${input}split=2[a][b];[a]scale=${sw}:${sh}:force_original_aspect_ratio=increase,crop=${sw}:${sh},boxblur=8:2,scale=${W}:${H},eq=brightness=-0.08[bg];` +
    `[b]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1`;
}

// ---------- Paso: guion ----------
register('compose.script', async ({ id }) => {
  const p = await getProject(id);
  await updateProject(id, { status: 'processing', error: null, progress: 'Escribiendo el guion con IA…', percent: 3 });
  let script = p.data.script;
  const o = p.data.options || {};
  if (!script?.scenes?.length) {
    const character = o.characterId ? await one('SELECT * FROM characters WHERE id = $1', [o.characterId]) : null;
    if (p.type === 'ad') {
      script = await generateAdScript({ ...o, images: (o.media || []).length });
      script.scenes.forEach(s => { if (Number.isInteger(s.image) && o.media?.[s.image]) s.media = o.media[s.image]; });
    } else if (p.type === 'montage') {
      script = await generateMontageScript({ ...o, notes: (o.media || []).map((_, i) => o.notes?.[i] || '') });
    } else {
      script = await generateScript({ ...o, character });
    }
  }
  if (p.type === 'montage') script.scenes.forEach((s, i) => { s.media = o.media?.[i] || s.media; });
  if (!script.scenes?.length) throw new Error('El guion no tiene escenas.');
  await updateProject(id, { title: script.title || p.title, data: { ...p.data, script, parts: [] } });
  await enqueue('compose.scene', { id, i: 0 });
}, ({ id }, msg) => updateProject(id, { status: 'error', error: msg, progress: null }));

// ---------- Paso: una escena ----------
register('compose.scene', async ({ id, i }, ctx) => {
  const p = await getProject(id);
  const o = p.data.options || {};
  const scenes = p.data.script.scenes;
  const s = scenes[i];
  const vertical = o.format === 'vertical' || p.type === 'ad';
  const W = vertical ? 1080 : 1920, H = vertical ? 1920 : 1080;
  const tag = `p${id}_s${i}_${Date.now()}`;
  const tmp = [];
  const t = f => { const x = path.join(WORK_DIR, `${tag}_${f}`); tmp.push(x); return x; };
  const pct = n => Math.round(10 + 80 * (i + n) / scenes.length);
  await updateProject(id, { progress: `Escena ${i + 1} de ${scenes.length}: voz y material…`, percent: pct(0) });
  try {
    const character = o.characterId ? await one('SELECT * FROM characters WHERE id = $1', [o.characterId]) : null;
    const useVoice = o.voice !== false && s.narration?.trim();

    // 1) Voz en off
    let voice = null, dur = Number(s.duration) || 3, words = [];
    if (useVoice) {
      voice = await tts(s.narration, t('voice.mp3'), { voice: character?.voice || undefined });
      dur = (await probe(voice)).duration + 0.3;
      words = await wordTimings(voice, s.narration, dur - 0.3);
    }

    // 2) Visual
    let media = s.media;
    if (!media && o.visual === 'character' && character) {
      await updateProject(id, { progress: `Escena ${i + 1} de ${scenes.length}: generando imagen del personaje…` });
      const refs = [];
      for (const img of (character.images || []).slice(0, 2)) refs.push(fs.readFileSync(await toLocal(img, t(`ref${refs.length}.png`))));
      const prompt = `${s.image_prompt || s.narration}. Main character: ${character.name}, ${character.description}. Style: ${character.style || 'cinematic, high detail'}. ${vertical ? 'Vertical composition.' : 'Horizontal composition.'} No text.`;
      const buf = await generateImage(prompt, { size: vertical ? '1024x1536' : '1536x1024', references: refs });
      media = await saveBuffer(buf, `scene_${tag}.png`, 'image/png');
      s.media = media; // se guarda para no regenerarla en un reintento
      await updateProject(id, { data: { ...p.data, script: { ...p.data.script, scenes } } });
    }
    let input, kind = 'color', iw = 0, ih = 0;
    if (media) {
      input = IMG_EXT.test(media) ? inputPath(media) : inputPath(media);
      const info = await probe(input);
      iw = info.width; ih = info.height;
      kind = IMG_EXT.test(media) || info.duration < 0.2 ? 'image' : 'video';
      if (kind === 'video' && !useVoice) dur = Math.min(info.duration || dur, Number(s.duration) || 600);
    } else if (o.visual !== 'none' && ((await getSetting('pixabay_key')) || (await getSetting('pexels_key')))) {
      const used = new Set((p.data.usedStock || []));
      const v = await stockVideo(s.search || p.data.script.title, { orientation: vertical ? 'portrait' : 'landscape', exclude: used }).catch(() => null);
      if (v) {
        input = await download(v.url, t('stock.mp4'));
        kind = 'video'; iw = vertical ? 1080 : 1920; ih = vertical ? 1920 : 1080;
        await updateProject(id, { data: { ...(await getProject(id)).data, usedStock: [...used] } });
      }
    }

    // 3) Subtítulos / texto en pantalla
    const assFile = t('s.ass');
    fs.writeFileSync(assFile, buildASS(words, {
      duration: dur, highlight: await getSetting('caption_color'), overlay: s.overlay || '',
      captionMarginV: vertical ? 520 : 90, wordsPerGroup: vertical ? 3 : 5,
      captions: o.captions !== false && useVoice, width: W, height: H, capSize: vertical ? 80 : 60,
    }));

    // 4) Render de la escena
    const args = [];
    if (kind === 'image') args.push('-framerate', '30', '-loop', '1', '-i', input);
    else if (kind === 'video') args.push(...(useVoice ? ['-stream_loop', '-1'] : []), '-i', input);
    else args.push('-f', 'lavfi', '-i', `color=c=0x15171c:s=${W}x${H}:r=30`);
    if (voice) args.push('-i', voice);
    else if (kind === 'video' && !useVoice && (await probe(input)).hasAudio) args.push('-i', input);
    else args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo');

    const frames = Math.ceil(dur * 30);
    let v = kind === 'color' ? `[0:v]setsar=1` : fitFilter(W, H, iw, ih);
    if (kind === 'image') v += `,scale=${Math.round(W * 1.15)}:${Math.round(H * 1.15)},zoompan=z='min(zoom+0.0006,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=30`;
    v += `,fps=30,trim=end_frame=${frames},${assFilter(assFile)}[v]`;
    const a = `[1:a]apad,atrim=0:${dur.toFixed(3)},aresample=44100,aformat=channel_layouts=stereo[a]`;
    const out = t('part.mp4');
    let lastW = 0;
    await ffmpeg([...args, '-filter_complex', `${v};${a}`, '-map', '[v]', '-map', '[a]', '-t', dur.toFixed(3),
      '-c:v', 'libx264', '-preset', process.env.X264_PRESET || 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-r', '30',
      '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2', out], {
      onProgress: sec => { if (Date.now() - lastW > 2500) { lastW = Date.now(); updateProject(id, { progress: `Escena ${i + 1} de ${scenes.length}: renderizando…`, percent: pct(Math.min(0.95, sec / dur)) }).catch(() => {}); } },
      timeoutMs: ctx?.remaining ? ctx.remaining() - 15000 : undefined,
    });
    const ref = await saveFile(out, `part_${tag}.mp4`);

    const fresh = await getProject(id);
    const parts = fresh.data.parts || [];
    await removeFile(parts[i]);
    parts[i] = ref;
    await updateProject(id, { data: { ...fresh.data, parts } });
    if (i + 1 < scenes.length) await enqueue('compose.scene', { id, i: i + 1 });
    else await enqueue('compose.concat', { id });
  } finally {
    for (const f of tmp) fs.rmSync(f, { force: true });
  }
}, ({ id }, msg) => updateProject(id, { status: 'error', error: msg, progress: null }));

// ---------- Paso: unir escenas ----------
register('compose.concat', async ({ id }) => {
  const p = await getProject(id);
  await updateProject(id, { progress: 'Uniendo escenas…', percent: 92 });
  const dir = path.join(WORK_DIR, `concat_${id}_${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    const files = [];
    for (const [i, ref] of (p.data.parts || []).entries()) files.push(await toLocal(ref, path.join(dir, `${i}.mp4`)));
    const list = path.join(dir, 'list.txt');
    fs.writeFileSync(list, files.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
    const out = path.join(dir, 'final.mp4');
    await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out]);
    const info = await probe(out);
    const ref = await saveFile(out, `video_${id}.mp4`);
    await removeFile(p.output);
    for (const part of p.data.parts || []) await removeFile(part);
    await updateProject(id, { status: 'ready', ready_at: new Date().toISOString(), output: ref, duration: info.duration, progress: 'Vídeo listo', percent: 100, data: { ...p.data, parts: [] } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, ({ id }, msg) => updateProject(id, { status: 'error', error: msg, progress: null }));
