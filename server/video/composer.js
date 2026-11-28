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

// ---------- Historias IA y Frutinovelas ----------
export const STORY_STYLES = {
  caricatura: { label: '✏️ Caricatura (historias con muñeco)', short: '2D cartoon webcomic style, thick black outlines, flat colors, expressive meme faces, simple stick figure with round white head', prompt: '2D cartoon illustration, clean thick black outlines, flat colors, simple soft shading, webcomic style, very expressive faces, detailed simple background. The protagonist is a simple stick-figure man with a round plain white meme-style head and exaggerated facial expressions' },
  fruta: { label: '🍓 Frutinovela (frutas 3D con drama)', short: '3D Pixar style animation, cute anthropomorphic fruit characters with big eyes and faces, dramatic telenovela lighting', prompt: '3D animated movie still, Pixar-like CGI style, anthropomorphic fruit characters with expressive faces, big glossy eyes, small arms and legs, telenovela drama, dramatic cinematic lighting, highly detailed, shallow depth of field' },
  pixar: { label: '🧸 Animación 3D', short: '3D Pixar style animation, cinematic lighting', prompt: '3D animated movie still, Pixar-like CGI style, expressive characters, cinematic lighting, highly detailed' },
  anime: { label: '🌸 Anime', short: 'anime illustration, cel shading, vibrant', prompt: 'anime illustration, detailed cel shading, expressive characters, cinematic composition, vibrant colors' },
  comic: { label: '💥 Cómic', short: 'comic book art, bold ink lines, vivid colors', prompt: 'comic book illustration, bold ink lines, halftone shading, dynamic composition, vivid colors' },
  realista: { label: '🎬 Realista cinematográfico', short: 'cinematic photorealistic film still, dramatic lighting', prompt: 'cinematic photorealistic film still, dramatic lighting, 35mm, shallow depth of field, highly detailed' },
};

/** Guion de una historia (o frutinovela) dividido en escenas con diálogos y personajes fijos. */
export async function generateStoryScript({ story, seconds = 60, style = 'caricatura', mode = 'story', language = 'Español', narration = 'tercera' }) {
  const words = Math.round(seconds * 2.4);
  const fruit = mode === 'fruit' || style === 'fruta';
  const res = await chatJSON(
    fruit ? 'Eres guionista de «frutinovelas»: telenovelas cortas y virales (TikTok/Reels) protagonizadas por frutas y verduras con personalidad humana. Mucho drama, traiciones, celos, secretos, giros inesperados, frases exageradas de telenovela y un final con gancho («¿Qué pasará?»).'
      : 'Eres guionista de vídeos cortos de historias animadas (TikTok/Reels/Shorts) que enganchan desde la primera frase: gancho inmediato, tensión creciente, giro y remate. Narración ágil, natural y emotiva.',
    `${fruit ? 'Idea o historia' : 'Historia'} que te da el usuario:\n«${story}»\n
Escribe el guion en ${language}. Duración: ~${seconds} s (≈ ${words} palabras habladas en total).
${fruit ? 'Los personajes son frutas o verduras (cada uno una fruta distinta). Usa diálogos entre ellos y un narrador dramático breve.' : `Narración en ${narration === 'primera' ? 'primera persona (el protagonista cuenta lo que le pasó)' : 'tercera persona'}; añade diálogos cortos de los personajes cuando ayuden.`}
Divide en escenas de 1 a 3 frases (una imagen por escena; entre ${Math.max(4, Math.round(seconds / 7))} y ${Math.max(6, Math.round(seconds / 4))} escenas).
Personajes: describe el ASPECTO FIJO de cada uno EN INGLÉS (especie/fruta, color, ropa, rasgos) para que se vea igual en todas las imágenes.${fruit ? ' El aspecto de cada fruta empieza SIEMPRE por «an anthropomorphic <fruit> character with a cartoon face, arms and legs» (nunca una persona).' : ''}
Para cada escena:
- "lines": lo que se oye, en orden: [{"speaker":"Narrador" o el nombre del personaje,"text":"...","emotion":"cómo lo dice (p. ej. llorando, furiosa, susurrando)"}]
- "image_prompt": EN INGLÉS, la imagen de la escena: acción, lugar, plano (close-up, wide shot…), emociones; incluye el aspecto completo de cada personaje que aparece. Sin texto en la imagen.
- "overlay": opcional, 1-4 palabras impactantes para poner en pantalla en momentos clave (o "")
JSON: {"title":"título viral (máx 70 caracteres)","description":"descripción corta con gancho","tags":["..."],
"characters":[{"name":"...","gender":"male|female","look":"visual description in English"}],
"scenes":[{"lines":[{"speaker":"...","text":"...","emotion":"..."}],"image_prompt":"...","overlay":""}]}`,
    { maxTokens: 8000 });
  res.scenes = (res.scenes || []).filter(s => s.lines?.length).map(s => ({ ...s, narration: s.lines.map(l => l.text).join(' ') }));
  res.characters = (res.characters || []).slice(0, 8);
  return res;
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
    } else if (p.type === 'story') {
      script = await generateStoryScript(o);
    } else if (p.type === 'montage') {
      script = await generateMontageScript({ ...o, notes: (o.media || []).map((_, i) => o.notes?.[i] || '') });
    } else {
      script = await generateScript({ ...o, character });
    }
  }
  if (p.type === 'montage') script.scenes.forEach((s, i) => { s.media = o.media?.[i] || s.media; });
  if (!script.scenes?.length) throw new Error('El guion no tiene escenas.');
  // Historias: voz del narrador y una voz distinta para cada personaje
  if (p.type === 'story' && o.voiceMode !== 'settings' && !script.cast) {
    const { castVoices, defaultFreeVoiceProvider } = await import('../ai/voices.js');
    const prov = ['gemini', 'system', 'piper'].includes(o.voiceMode) ? o.voiceMode : await defaultFreeVoiceProvider();
    const narrator = o.narratorVoice || (prov === 'gemini' ? 'gemini:Charon' : (await castVoices([{ name: 'Narrador', gender: o.narratorGender || 'male' }], prov, null))[0].voice);
    script.cast = { provider: prov, narrator, characters: await castVoices(script.characters || [], prov, narrator) };
  }
  if (p.type === 'story' && !script.seed) script.seed = Math.floor(Math.random() * 1e9);
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
    if (useVoice && s.lines?.length && p.type === 'story') {
      // Historia: cada línea con la voz de quien habla, unidas con una pausa corta
      if (p.data.script.cast?.provider === 'piper' && i === 0) await updateProject(id, { progress: 'Preparando la IA de voz local (la primera vez se descargan las voces, ~60 MB cada una)…' });
      const cast = p.data.script.cast || {};
      const voiceOf = sp => cast.characters?.find(c => c.name && String(sp).toLowerCase() === c.name.toLowerCase())?.voice || cast.narrator;
      const files = [];
      for (const [k, l] of s.lines.entries()) {
        if (!String(l.text || '').trim()) continue;
        const v = voiceOf(l.speaker);
        const f = t(`l${k}.mp3`);
        if (v) { const { freeTTS } = await import('../ai/voices.js'); await freeTTS(l.text, f, v, { style: l.emotion ? `Say it ${l.emotion}` : '' }); }
        else await tts(l.text, f);
        files.push(f);
      }
      voice = t('voice.mp3');
      const gap = t('gap.mp3');
      await ffmpeg(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '0.18', '-b:a', '128k', gap]);
      const seq = files.flatMap((f, k) => k ? [gap, f] : [f]);
      await ffmpeg([...seq.flatMap(f => ['-i', f]), '-filter_complex', `${seq.map((_, k) => `[${k}:a]aresample=44100,aformat=channel_layouts=mono[a${k}]`).join(';')};${seq.map((_, k) => `[a${k}]`).join('')}concat=n=${seq.length}:v=0:a=1[a]`, '-map', '[a]', '-b:a', '160k', voice]);
      dur = (await probe(voice)).duration + 0.35;
      words = await wordTimings(voice, s.narration, dur - 0.35);
    } else if (useVoice) {
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
    if (!media && p.type === 'story') {
      await updateProject(id, { progress: `Escena ${i + 1} de ${scenes.length}: dibujando la imagen con IA…` });
      const st = STORY_STYLES[o.style] || STORY_STYLES.caricatura;
      const said = (s.image_prompt + ' ' + s.lines.map(l => l.speaker + ' ' + l.text).join(' ')).toLowerCase();
      const chars = (p.data.script.characters || []).filter(c => c.look && c.name && said.includes(String(c.name).toLowerCase()));
      // cada nombre va acompañado de su aspecto fijo (así la IA no lo convierte en una persona)
      let ip = String(s.image_prompt || '');
      for (const c of chars) ip = ip.split(c.name).join(`${c.name} (${c.look})`);
      const fruitRule = (o.style || '') === 'fruta' || o.mode === 'fruit' ? 'IMPORTANT: every character is an anthropomorphic FRUIT or vegetable with a cartoon face, arms and legs — NOT a human, no people, no human skin. ' : '';
      const prompt = `${fruitRule}${st.prompt}. ${ip}. ${chars.filter(c => !ip.includes(c.look)).map(c => `${c.name}: ${c.look}`).join('. ')}. ${vertical ? 'Vertical 9:16 composition, subject centered.' : 'Horizontal composition.'} No text, no letters, no captions, no watermark.`;
      // Imágenes gratis (Pollinations): el servicio gratuito entiende mal los textos largos → versión corta
      const short = w => String(w || '').split(/\s+/).slice(0, 14).join(' ').replace(/[,.;]+$/, '');
      let ipShort = String(s.image_prompt || '');
      for (const c of chars) ipShort = ipShort.split(c.name).join(short(c.look));
      const compact = `${ipShort.slice(0, 260)}, ${st.short}${fruitRule ? ', fruit characters, no humans' : ''}, vertical, no text`;
      const free = o.imageMode === 'free' || o.imageMode === 'local' || (o.imageMode !== 'settings' && (await getSetting('image_provider')) === 'pollinations');
      const buf = await generateImage(free ? compact : prompt, { size: vertical ? '1024x1536' : '1536x1024', provider: o.imageMode === 'free' ? 'pollinations' : o.imageMode === 'local' ? 'local' : o.imageMode === 'meta' ? 'meta' : undefined, seed: p.data.script.seed,
        onProgress: t => updateProject(id, { progress: `Escena ${i + 1} de ${scenes.length}: ${String(t?.stage || t)}` }).catch(() => {}) });
      media = await saveBuffer(buf, `scene_${tag}.png`, 'image/png');
      s.media = media;
      const fresh = await getProject(id);
      fresh.data.script.scenes[i].media = media;
      await updateProject(id, { data: { ...fresh.data } });
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
      captionMarginV: vertical ? (p.type === 'story' ? 420 : 520) : 90, wordsPerGroup: vertical ? 3 : 5, ...(p.type === 'story' ? { style: o.captionStyle || 'impacto' } : {}),
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
    // Historias: efecto 2.5D (el personaje se mueve por delante del fondo). Si la imagen no tiene un primer plano claro, movimiento normal.
    let layers = null;
    if (kind === 'image' && p.type === 'story' && o.anim !== 'simple') {
      await updateProject(id, { progress: `Escena ${i + 1} de ${scenes.length}: separando personaje y fondo (2.5D)…` });
      const { makeLayers } = await import('./parallax.js');
      const ldir = path.join(WORK_DIR, `${tag}_2d5`); fs.mkdirSync(ldir, { recursive: true }); tmp.push(ldir);
      layers = await makeLayers(input, ldir, W, H).catch(e => { console.warn('[2.5D] escena', i + 1, e.message); return null; });
    }
    if (layers) {
      const { parallaxFilter } = await import('./parallax.js');
      args[args.indexOf(input)] = layers.bg;
      const fgIdx = args.filter(x => x === '-i').length;
      args.push('-framerate', '30', '-loop', '1', '-i', layers.fg);
      v = parallaxFilter({ bgIn: '[0:v]', fgIn: `[${fgIdx}:v]`, W, H, frames, mode: i % 4, out: 'pv0' }) + ';[pv0]null';
    } else if (kind === 'image') {
      // Movimiento de cámara distinto en cada escena (acercar, alejar, desplazar): da vida a las imágenes
      const n = Math.max(1, frames), m = p.type === 'story' ? i % 5 : 0;
      const zp = [
        `z='1+0.14*on/${n}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`,
        `z='1.14-0.14*on/${n}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`,
        `z='1.12':x='(iw-iw/zoom)*on/${n}':y='ih/2-(ih/zoom/2)'`,
        `z='1.12':x='(iw-iw/zoom)*(1-on/${n})':y='ih/2-(ih/zoom/2)'`,
        `z='1+0.18*on/${n}':x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*0.3'`,
      ][m];
      v += `,scale=${Math.round(W * 1.5)}:${Math.round(H * 1.5)},zoompan=${zp}:d=1:s=${W}x${H}:fps=30`;
    }
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
    for (const f of tmp) fs.rmSync(f, { recursive: true, force: true });
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

/** Editor de historias: nueva imagen para una escena (con la descripción dada) y se guarda en el guion. */
export async function regenerateSceneImage(id, i, { prompt, source } = {}) {
  const p = await getProject(id);
  const o = p.data.options || {}, sc = p.data.script?.scenes?.[i];
  if (!sc) throw new Error('Esa escena no existe.');
  if (prompt != null) sc.image_prompt = String(prompt).slice(0, 1200);
  const st = STORY_STYLES[o.style] || STORY_STYLES.caricatura;
  const chars = (p.data.script.characters || []).filter(c => c.look && c.name && String(sc.image_prompt).toLowerCase().includes(String(c.name).toLowerCase()));
  const short = w => String(w || '').split(/\s+/).slice(0, 14).join(' ').replace(/[,.;]+$/, '');
  let ip = String(sc.image_prompt || '');
  for (const c of chars) ip = ip.split(c.name).join(short(c.look));
  const fruit = o.style === 'fruta' || o.mode === 'fruit';
  const src = source || o.imageMode || 'free';
  const prompt2 = src === 'settings' ? `${fruit ? 'Every character is an anthropomorphic fruit, not a human. ' : ''}${st.prompt}. ${ip}. Vertical 9:16 composition. No text.`
    : `${ip.slice(0, 260)}, ${st.short}${fruit ? ', fruit characters, no humans' : ''}, vertical, no text`;
  const buf = await generateImage(prompt2, { size: '1024x1536', provider: src === 'free' ? 'pollinations' : src === 'local' ? 'local' : src === 'meta' ? 'meta' : undefined, seed: Math.floor(Math.random() * 1e9) });
  const media = await saveBuffer(buf, `scene_p${id}_s${i}_${Date.now()}.png`, 'image/png');
  const fresh = await getProject(id);
  const old = fresh.data.script.scenes[i].media;
  fresh.data.script.scenes[i] = { ...fresh.data.script.scenes[i], image_prompt: sc.image_prompt, media };
  await updateProject(id, { data: fresh.data });
  if (old && old !== media) await removeFile(old).catch(() => {});
  return media;
}
