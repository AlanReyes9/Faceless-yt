// Miniaturas y portadas con IA: ideas (LLM) → imagen de fondo (proveedor de imágenes) → texto grande encima (ffmpeg + ASS).
// El texto se puede cambiar y volver a componer sin generar otra imagen.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { q, one, WORK_DIR } from './db.js';
import { chatJSON } from './ai/llm.js';
import { generateImage } from './ai/media.js';
import { getSetting } from './settings.js';
import { ffmpeg, assFilter } from './video/ffmpeg.js';
import { saveFile, saveBuffer, toLocal, publicUrl, removeFile } from './storage.js';
import { emojiImage } from './video/emoji.js';

export const FORMATS = {
  youtube: { w: 1280, h: 720, size: '1536x1024', label: 'YouTube 16:9' },
  short: { w: 1080, h: 1920, size: '1024x1536', label: 'Portada Shorts / Reels 9:16' },
  square: { w: 1080, h: 1080, size: '1024x1024', label: 'Cuadrada 1:1' },
};
export const STYLES = {
  impacto: 'hyper-saturated, dramatic rim lighting, high contrast, cinematic, sharp focus',
  misterio: 'dark moody atmosphere, fog, cinematic teal and orange, suspenseful',
  gaming: 'vibrant neon colors, energetic, dynamic action pose, glow effects',
  documental: 'realistic photography, natural light, high detail, editorial',
  minimal: 'clean minimal composition, solid bold background color, simple subject, lots of negative space',
  cartoon: 'bold cartoon illustration, thick outlines, bright flat colors, expressive',
};

const assColor = hex => { const h = String(hex || '#FFFFFF').replace('#', '').padEnd(6, 'F'); return `&H00${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`.toUpperCase(); };
const clean = s => String(s || '').replace(/[{}\\]/g, '').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '').replace(/\s+/g, ' ').trim();

// ---------- Ideas ----------
export async function thumbIdeas({ title, niche = '', language = 'Español', n = 4, format = 'youtube' }) {
  const r = await chatJSON('Eres diseñador de miniaturas de YouTube con millones de visitas: sabes qué genera clics (curiosidad, emoción, contraste, pocas palabras).',
    `Vídeo: "${title}"${niche ? ` (canal de ${niche})` : ''}. Formato: ${FORMATS[format]?.label || '16:9'}.
Propón ${n} ideas de miniatura muy distintas entre sí. Para cada una:
- "text": texto de la miniatura en ${language}, en MAYÚSCULAS, de 1 a 4 palabras, que complemente al título (no lo repita)
- "highlight": la palabra del texto que va en color
- "prompt": descripción visual EN INGLÉS de la imagen (sujeto principal grande y expresivo, emoción clara, fondo simple), SIN texto en la imagen
- "position": dónde va el texto: "left", "right", "top" o "bottom" (el sujeto queda en el lado contrario)
- "color": color del texto resaltado en hex (#FFD400, #FF3B30, #22C55E…)
- "typography": estilo de letra EN INGLÉS acorde al tema, como lo haría un diseñador profesional (p. ej. "huge 3D gold metallic letters with glow" para dinero, "cracked blood-red horror font" para terror, "neon cyberpunk glowing letters" para gaming, "chalk handwritten" para educación)
- "why": por qué funciona (una frase)
JSON: {"ideas":[{"text":"","highlight":"","prompt":"","position":"left","color":"#FFD400","typography":"","why":""}]}`, { maxTokens: 2000 });
  return (r.ideas || []).slice(0, n);
}

// ---------- Componer: imagen + texto ----------
export async function renderThumb(baseRef, design, format = 'youtube') {
  const F = FORMATS[format] || FORMATS.youtube;
  const dir = path.join(WORK_DIR, `thumb_${crypto.randomBytes(5).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    const src = await toLocal(baseRef, path.join(dir, 'base'));
    const text = clean(design.text).toUpperCase();
    const pos = ['left', 'right', 'top', 'bottom', 'center'].includes(design.position) ? design.position : 'left';
    const side = pos === 'left' || pos === 'right';
    const W = F.w, H = F.h;
    // Caja donde va el texto y tamaño de letra que lo llena (Anton ≈ 0,25 em de ancho por carácter en mayúsculas)
    const boxW = side && W > H ? W * 0.52 : W * 0.9;
    const words = text.split(' ').filter(Boolean);
    const lines = Math.min(3, Math.max(1, words.length <= 2 ? words.length : Math.ceil(text.length / 11)));
    const perLine = Math.max(4, Math.ceil(text.length / lines));
    const auto = Math.min(H * (side ? 0.42 : 0.3), boxW / (perLine * 0.25));
    const size = Math.round(auto * (Number(design.scale) || 1));
    const hl = clean(design.highlight).toUpperCase();
    const body = words.map(w => hl && w.replace(/[^\p{L}\p{N}]/gu, '') === hl.replace(/[^\p{L}\p{N}]/gu, '') ? `{\\c${assColor(design.color || '#FFD400')}}${w}{\\c${assColor(design.textColor || '#FFFFFF')}}` : w);
    // Saltos de línea equilibrados
    const per = Math.ceil(words.length / lines);
    const textAss = [...Array(lines)].map((_, i) => body.slice(i * per, (i + 1) * per).join(' ')).filter(Boolean).join('\\N');
    const m = Math.round(W * 0.04);
    const an = { left: 4, right: 6, top: 8, bottom: 2, center: 5 }[pos];
    const x = pos === 'left' ? m : pos === 'right' ? W - m : W / 2, y = pos === 'top' ? m : pos === 'bottom' ? H - m : H / 2;
    const rot = Number(design.tilt) ? `\\frz${Number(design.tilt)}` : '';
    // Efectos del texto: clásico (borde negro), neón (brillo del color), caja (texto sobre banda de color) y 3D (sombra larga)
    const fx = ['clasico', 'neon', 'caja', '3d'].includes(design.effect) ? design.effect : 'clasico';
    const bord = Math.max(4, Math.round(size * 0.085)), shad = Math.max(3, Math.round(size * 0.06));
    const hlc = assColor(design.color || '#FFD400');
    const ev = (layer, tags, txt = textAss) => `Dialogue: ${layer},0:00:00.00,0:00:05.00,T,,0,0,0,,{\\an${an}\\pos(${x},${y})${rot}\\q2${tags}}${txt}`;
    const events = [];
    let styleBorder = 1, outlineCol = assColor(design.outline || '#000000');
    if (fx === 'neon') {
      events.push(ev(0, `\\bord${Math.round(size * 0.16)}\\blur${Math.round(size * 0.12)}\\3c${hlc}\\1a&HFF&\\shad0`, textAss.replace(/\{\\c[^}]*\}/g, ''))); // solo el brillo (sin los cambios de color, que quitarían la transparencia)
      // la palabra resaltada lleva borde oscuro para que no se funda con el brillo
      const tc = assColor(design.textColor || '#FFFFFF');
      const neonTxt = textAss.split(`{\\c${hlc}}`).join(`{\\c${hlc}\\3c&H00101010&}`).split(`{\\c${tc}}`).join(`{\\c${tc}\\3c${hlc}}`);
      events.push(ev(1, `\\bord${Math.round(size * 0.05)}\\blur2\\3c${hlc}\\shad0`, neonTxt));
    } else if (fx === '3d') {
      const depth = Math.max(6, Math.round(size * 0.07));
      for (let k = depth; k >= 1; k--) events.push(`Dialogue: 0,0:00:00.00,0:00:05.00,T,,0,0,0,,{\\an${an}\\pos(${x + k},${y + k})${rot}\\q2\\1c&H00202020&\\3c&H00101010&\\shad0}${textAss.replace(/\{\\c[^}]*\}/g, '')}`);
      events.push(ev(1, '\\shad0'));
    } else if (fx === 'caja') {
      styleBorder = 3; outlineCol = hlc; // caja del color de resaltado detrás de cada línea; el texto en negro y la palabra clave en blanco
      const isHl = w => hl && w.replace(/[^\p{L}\p{N}]/gu, '') === hl.replace(/[^\p{L}\p{N}]/gu, '');
      const boxBody = words.map(w => isHl(w) ? `{\\c&H00FFFFFF&}${w}{\\c&H00111111&}` : w);
      const boxTxt = [...Array(lines)].map((_, k) => boxBody.slice(k * per, (k + 1) * per).join(' ')).filter(Boolean).join('\\N');
      events.push(ev(0, `\\1c&H00111111&\\shad0\\bord${Math.round(size * 0.12)}`, boxTxt));
    } else events.push(ev(0, ''));
    const ass = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n` +
      `Style: T,Anton,${size},${assColor(design.textColor || '#FFFFFF')},&H00FFFFFF,${outlineCol},&H96000000,0,0,0,0,100,100,1,0,${styleBorder},${bord},${shad},5,0,0,0,1\n\n` +
      `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${events.join('\n')}\n`;
    const assFile = path.join(dir, 't.ass');
    fs.writeFileSync(assFile, ass);
    // Degradado oscuro detrás del texto para que se lea sobre cualquier imagen
    const shade = design.shade === false ? '' : pos === 'left' ? `,drawbox=x=0:y=0:w=${Math.round(W * 0.55)}:h=${H}:color=black@0.28:t=fill`
      : pos === 'right' ? `,drawbox=x=${Math.round(W * 0.45)}:y=0:w=${Math.round(W * 0.55)}:h=${H}:color=black@0.28:t=fill`
      : pos === 'top' ? `,drawbox=x=0:y=0:w=${W}:h=${Math.round(H * 0.4)}:color=black@0.28:t=fill`
      : pos === 'bottom' ? `,drawbox=x=0:y=${Math.round(H * 0.6)}:w=${W}:h=${Math.round(H * 0.4)}:color=black@0.28:t=fill` : '';
    const sat = Number(design.saturation) || 1.15;
    const out = path.join(dir, 'out.png');
    const base = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},eq=saturation=${sat}:contrast=1.05${shade}${text ? ',' + assFilter(assFile) : ''}`;
    // Emoji grande (😱 🔥 💰…) en la esquina contraria al texto
    const emo = design.emoji ? await emojiImage(design.emoji).catch(() => null) : null;
    if (emo) {
      const es = Math.round(Math.min(W, H) * 0.3 * (Number(design.emojiScale) || 1));
      const ex = pos === 'right' ? Math.round(W * 0.05) : W - es - Math.round(W * 0.05);
      const ey = pos === 'top' ? H - es - Math.round(H * 0.06) : Math.round(H * 0.06);
      await ffmpeg(['-i', src, '-i', emo, '-filter_complex', `[0:v]${base}[b];[1:v]scale=${es}:${es},rotate=${pos === 'right' ? -0.15 : 0.15}:c=none:ow=rotw(0.15):oh=roth(0.15)[e];[b][e]overlay=${ex}:${ey}`,
        '-frames:v', '1', out], { timeoutMs: 60000 });
    } else await ffmpeg(['-i', src, '-vf', base, '-frames:v', '1', out], { timeoutMs: 60000 });
    return await saveFile(out, `miniatura_${format}.png`, 'image/png');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ---------- Texto integrado por la IA (Gemini "Nano Banana"; OpenAI como respaldo) ----------
async function aiProviders() {
  const order = [];
  if (await getSetting('gemini_key')) order.push('gemini');
  if (await getSetting('openai_key')) order.push('openai');
  if (!order.length) throw new Error('Para el texto integrado por IA necesitas una clave de Gemini (o de OpenAI) en Ajustes y claves. (400)');
  return order;
}
async function generateWith(order, prompt, opts) {
  let last;
  for (const provider of order) {
    try { return await generateImage(prompt, { ...opts, provider }); } catch (e) { last = e; console.warn(`[miniatura] ${provider}: ${e.message.slice(0, 160)}`); }
  }
  throw last;
}
// Nombre de color aproximado (los modelos de imagen entienden mejor "bright yellow" que "#FFD400")
function colorName(hex) {
  const m = String(hex || '').match(/^#?([0-9a-f]{6})$/i); if (!m) return hex || 'bright yellow';
  const [r, g, b] = [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16));
  const names = { 'bright yellow': [255, 212, 0], 'gold': [255, 180, 0], 'orange': [255, 120, 0], 'bright red': [255, 40, 40], 'hot pink': [255, 60, 170], 'purple': [150, 60, 255],
    'electric blue': [30, 120, 255], 'cyan': [0, 220, 255], 'neon green': [40, 220, 90], 'white': [255, 255, 255], 'black': [10, 10, 10] };
  let best = 'bright yellow', d = Infinity;
  for (const [n, c] of Object.entries(names)) { const x = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2; if (x < d) { d = x; best = n; } }
  return `${best} (${'#' + m[1].toUpperCase()})`;
}
const sideOf = p => ({ left: 'on the left side', right: 'on the right side', top: 'across the top', bottom: 'across the bottom', center: 'in the center' }[p] || 'on the left side');
function aiPrompt(t, b, hasRefs) {
  const text = clean(b.text).toUpperCase(), hl = clean(b.highlight).toUpperCase();
  return `Design a professional, high click-through-rate ${t.format === 'short' ? 'vertical 9:16 YouTube Shorts cover' : t.format === 'square' ? 'square social media cover' : 'YouTube thumbnail (16:9)'} for a video titled "${t.title}"${t.niche ? ` from a ${t.niche} channel` : ''}.
Scene: ${b.prompt || 'a striking image that represents the topic'}. Visual style: ${STYLES[t.style] || ''}.
${hasRefs ? 'Use the person from the reference photo as the main subject; keep their face recognizable with an exaggerated, expressive emotion.' : ''}
${text ? `Headline text, rendered as part of the design (NOT as subtitles or captions): "${text}". Spell it EXACTLY like that, letter by letter, keeping accents, with no extra words.
Typography: ${b.typography || 'bold heavy display typeface designed for the topic'}; huge, thick and readable even at small size, with depth (3D, bevel, strong outline or glow) and integrated with the scene lighting.
${hl && hl !== text ? `Make the word "${hl}" stand out in ${colorName(b.color)}, the rest in a contrasting color.` : ''}
Place the headline ${sideOf(b.position)}, and the main subject on the opposite side, large and close to camera.` : 'No text at all.'}
Only this headline: no other text, letters, numbers, logos, watermarks or UI elements. Sharp, vibrant, professional graphic design like top YouTube creators.`;
}

// ---------- Rutas ----------
const out = t => ({ ...t, items: (t.items || []).map(it => ({ ...it, url: publicUrl(it.out), baseUrl: publicUrl(it.base) })), refUrls: (t.refs || []).map(publicUrl) });

export function mountThumbs(app, h) {
  app.get('/api/thumbs/caps', h(async (req, res) => res.json({ aiText: (await getSetting('image_provider')) !== 'local' && !!((await getSetting('gemini_key')) || (await getSetting('openai_key'))), local: (await getSetting('image_provider')) === 'local' })));
  app.get('/api/thumbs/meta', (req, res) => res.json({ formats: Object.fromEntries(Object.entries(FORMATS).map(([k, v]) => [k, v.label])), styles: Object.keys(STYLES) }));
  app.get('/api/thumbs', h(async (req, res) => res.json((await q('SELECT * FROM thumbnails ORDER BY id DESC LIMIT 60')).map(out))));
  app.get('/api/thumbs/:id', h(async (req, res) => res.json(out(await one('SELECT * FROM thumbnails WHERE id = $1', [req.params.id])))));
  app.post('/api/thumbs', h(async (req, res) => {
    const b = req.body || {};
    if (!String(b.title || '').trim()) throw new Error('Escribe el título del vídeo.');
    const t = await one(`INSERT INTO thumbnails (title, format, style, niche, refs, ideas, items) VALUES ($1,$2,$3,$4,$5,'[]','[]') RETURNING *`,
      [String(b.title).slice(0, 200), FORMATS[b.format] ? b.format : 'youtube', STYLES[b.style] ? b.style : 'impacto', String(b.niche || '').slice(0, 100), JSON.stringify((b.refs || []).slice(0, 3))]);
    res.json(out(t));
  }));
  app.post('/api/thumbs/:id/ideas', h(async (req, res) => {
    const t = await one('SELECT * FROM thumbnails WHERE id = $1', [req.params.id]);
    const ideas = await thumbIdeas({ title: t.title, niche: t.niche, format: t.format, language: req.body?.language || 'Español', n: Math.min(6, Number(req.body?.n) || 4) });
    await q('UPDATE thumbnails SET ideas = $2 WHERE id = $1', [t.id, JSON.stringify(ideas)]);
    res.json({ ideas });
  }));
  // Genera una miniatura nueva (imagen con IA o imagen subida) a partir de una idea
  app.post('/api/thumbs/:id/generate', h(async (req, res) => {
    const t = await one('SELECT * FROM thumbnails WHERE id = $1', [req.params.id]);
    const b = req.body || {};
    const F = FORMATS[t.format];
    const cloudText = (await getSetting('image_provider')) !== 'local' && ((await getSetting('gemini_key')) || (await getSetting('openai_key')));
    const mode = b.mode === 'overlay' || b.base || !cloudText ? 'overlay' : 'ai';
    if (mode === 'ai') {
      const refs = [];
      for (const r of (t.refs || []).slice(0, 2)) { try { refs.push(fs.readFileSync(await toLocal(r, path.join(WORK_DIR, `tref_${crypto.randomBytes(4).toString('hex')}`)))); } catch {} }
      const buf = await generateWith(await aiProviders(), aiPrompt(t, b, refs.length > 0), { size: F.size, references: refs });
      const base = await saveBuffer(buf, 'miniatura_ia.png', 'image/png');
      const design = { mode: 'ai', text: clean(b.text).toUpperCase(), highlight: b.highlight || '', color: b.color || '#FFD400', position: b.position || 'left', typography: b.typography || '' };
      const ref = await renderThumb(base, { text: '', shade: false, saturation: 1 }, t.format); // solo se ajusta al tamaño exacto
      const item = { id: crypto.randomBytes(4).toString('hex'), base, out: ref, design, prompt: b.prompt || '' };
      await q(`UPDATE thumbnails SET items = items || $2::jsonb WHERE id = $1`, [t.id, JSON.stringify([item])]);
      return res.json({ ...item, url: publicUrl(ref), baseUrl: publicUrl(base) });
    }
    let base = b.base || null;
    if (!base) {
      const sideText = { left: 'leave empty space on the left third for big text, main subject on the right', right: 'leave empty space on the right third for big text, main subject on the left',
        top: 'leave empty space at the top for big text', bottom: 'leave empty space at the bottom for big text' }[b.position] || '';
      const refs = [];
      for (const r of (t.refs || []).slice(0, 2)) { try { refs.push(fs.readFileSync(await toLocal(r, path.join(WORK_DIR, `tref_${crypto.randomBytes(4).toString('hex')}`)))); } catch {} }
      const prompt = `YouTube thumbnail image for a video titled "${t.title}". ${b.prompt || ''}. ${STYLES[t.style] || ''}. ${sideText}. ${refs.length ? 'Use the person from the reference photo as the main subject, keep their face recognizable, exaggerated expressive emotion.' : ''} Eye-catching, high click-through rate composition, subject large and close to camera. Absolutely no text, letters, words, logos or watermarks.`;
      const steps = { rapida: 12, normal: 22, alta: 32 }[b.quality] || undefined;
      const buf = await generateImage(prompt, { size: F.size, references: refs, steps });
      base = await saveBuffer(buf, 'miniatura_base.png', 'image/png');
    }
    const design = { text: b.text || '', highlight: b.highlight || '', color: b.color || '#FFD400', position: b.position || 'left', textColor: b.textColor || '#FFFFFF', outline: '#000000', scale: 1, tilt: 0, shade: true,
      effect: b.effect || 'clasico', emoji: b.emoji || '' };
    const ref = await renderThumb(base, design, t.format);
    const item = { id: crypto.randomBytes(4).toString('hex'), base, out: ref, design, prompt: b.prompt || '' };
    await q(`UPDATE thumbnails SET items = items || $2::jsonb WHERE id = $1`, [t.id, JSON.stringify([item])]);
    res.json({ ...item, url: publicUrl(ref), baseUrl: publicUrl(base) });
  }));
  // Cambiar el texto/estilo sin generar otra imagen
  app.patch('/api/thumbs/:id/items/:item', h(async (req, res) => {
    const t = await one('SELECT * FROM thumbnails WHERE id = $1', [req.params.id]);
    const items = t.items || [];
    const it = items.find(x => x.id === req.params.item);
    if (!it) throw new Error('No existe.');
    const old = it.out;
    if (it.design.mode === 'ai') {
      // Texto integrado: la IA edita la propia imagen (cambia el texto y conserva el resto)
      const next = { ...it.design, ...req.body };
      const text = clean(next.text).toUpperCase(), hl = clean(next.highlight).toUpperCase();
      const img = fs.readFileSync(await toLocal(it.base, path.join(WORK_DIR, `tedit_${crypto.randomBytes(4).toString('hex')}`)));
      const instr = `Edit this thumbnail. Replace the headline text with exactly "${text}" (spelled letter by letter, no other words)${hl && hl !== text ? `, with the word "${hl}" in ${colorName(next.color)}` : ''}.
${req.body.typography ? `Typography: ${req.body.typography}.` : 'Keep the same typography style, size, effects and position.'} ${req.body.instructions ? `Also: ${req.body.instructions}.` : 'Keep everything else in the image exactly the same.'} No other text, logos or watermarks.`;
      const buf = await generateWith(await aiProviders(), instr, { size: FORMATS[t.format].size, references: [img] });
      const oldBase = it.base;
      it.base = await saveBuffer(buf, 'miniatura_ia.png', 'image/png');
      it.design = { ...next, text };
      it.out = await renderThumb(it.base, { text: '', shade: false, saturation: 1 }, t.format);
      await removeFile(oldBase).catch(() => {});
    } else {
      it.design = { ...it.design, ...req.body };
      it.out = await renderThumb(it.base, it.design, t.format);
    }
    await q('UPDATE thumbnails SET items = $2 WHERE id = $1', [t.id, JSON.stringify(items)]);
    await removeFile(old).catch(() => {});
    res.json({ ...it, url: publicUrl(it.out), baseUrl: publicUrl(it.base) });
  }));
  app.delete('/api/thumbs/:id/items/:item', h(async (req, res) => {
    const t = await one('SELECT * FROM thumbnails WHERE id = $1', [req.params.id]);
    const items = t.items || [];
    const it = items.find(x => x.id === req.params.item);
    await q('UPDATE thumbnails SET items = $2 WHERE id = $1', [t.id, JSON.stringify(items.filter(x => x !== it))]);
    if (it) { await removeFile(it.out).catch(() => {}); await removeFile(it.base).catch(() => {}); }
    res.json({ ok: true });
  }));
  app.delete('/api/thumbs/:id', h(async (req, res) => {
    const t = await one('SELECT * FROM thumbnails WHERE id = $1', [req.params.id]);
    if (t) for (const it of t.items || []) { await removeFile(it.out).catch(() => {}); await removeFile(it.base).catch(() => {}); }
    await q('DELETE FROM thumbnails WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  }));
}
