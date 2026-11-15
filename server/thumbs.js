// Miniaturas y portadas con IA: ideas (LLM) → imagen de fondo (proveedor de imágenes) → texto grande encima (ffmpeg + ASS).
// El texto se puede cambiar y volver a componer sin generar otra imagen.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { q, one, WORK_DIR } from './db.js';
import { chatJSON } from './ai/llm.js';
import { generateImage } from './ai/media.js';
import { ffmpeg, assFilter } from './video/ffmpeg.js';
import { saveFile, saveBuffer, toLocal, publicUrl, removeFile } from './storage.js';

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
- "why": por qué funciona (una frase)
JSON: {"ideas":[{"text":"","highlight":"","prompt":"","position":"left","color":"#FFD400","why":""}]}`, { maxTokens: 2000 });
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
    const ass = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n` +
      `Style: T,Anton,${size},${assColor(design.textColor || '#FFFFFF')},&H00FFFFFF,${assColor(design.outline || '#000000')},&H96000000,0,0,0,0,100,100,1,0,1,${Math.max(4, Math.round(size * 0.085))},${Math.max(3, Math.round(size * 0.06))},5,0,0,0,1\n\n` +
      `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:05.00,T,,0,0,0,,{\\an${an}\\pos(${x},${y})${rot}\\q2}${textAss}\n`;
    const assFile = path.join(dir, 't.ass');
    fs.writeFileSync(assFile, ass);
    // Degradado oscuro detrás del texto para que se lea sobre cualquier imagen
    const shade = design.shade === false ? '' : pos === 'left' ? `,drawbox=x=0:y=0:w=${Math.round(W * 0.55)}:h=${H}:color=black@0.28:t=fill`
      : pos === 'right' ? `,drawbox=x=${Math.round(W * 0.45)}:y=0:w=${Math.round(W * 0.55)}:h=${H}:color=black@0.28:t=fill`
      : pos === 'top' ? `,drawbox=x=0:y=0:w=${W}:h=${Math.round(H * 0.4)}:color=black@0.28:t=fill`
      : pos === 'bottom' ? `,drawbox=x=0:y=${Math.round(H * 0.6)}:w=${W}:h=${Math.round(H * 0.4)}:color=black@0.28:t=fill` : '';
    const sat = Number(design.saturation) || 1.15;
    const out = path.join(dir, 'out.png');
    await ffmpeg(['-i', src, '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},eq=saturation=${sat}:contrast=1.05${shade}${text ? ',' + assFilter(assFile) : ''}`,
      '-frames:v', '1', out], { timeoutMs: 60000 });
    return await saveFile(out, `miniatura_${format}.png`, 'image/png');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ---------- Rutas ----------
const out = t => ({ ...t, items: (t.items || []).map(it => ({ ...it, url: publicUrl(it.out), baseUrl: publicUrl(it.base) })), refUrls: (t.refs || []).map(publicUrl) });

export function mountThumbs(app, h) {
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
    let base = b.base || null;
    if (!base) {
      const sideText = { left: 'leave empty space on the left third for big text, main subject on the right', right: 'leave empty space on the right third for big text, main subject on the left',
        top: 'leave empty space at the top for big text', bottom: 'leave empty space at the bottom for big text' }[b.position] || '';
      const refs = [];
      for (const r of (t.refs || []).slice(0, 2)) { try { refs.push(fs.readFileSync(await toLocal(r, path.join(WORK_DIR, `tref_${crypto.randomBytes(4).toString('hex')}`)))); } catch {} }
      const prompt = `YouTube thumbnail image for a video titled "${t.title}". ${b.prompt || ''}. ${STYLES[t.style] || ''}. ${sideText}. ${refs.length ? 'Use the person from the reference photo as the main subject, keep their face recognizable, exaggerated expressive emotion.' : ''} Eye-catching, high click-through rate composition, subject large and close to camera. Absolutely no text, letters, words, logos or watermarks.`;
      const buf = await generateImage(prompt, { size: F.size, references: refs });
      base = await saveBuffer(buf, 'miniatura_base.png', 'image/png');
    }
    const design = { text: b.text || '', highlight: b.highlight || '', color: b.color || '#FFD400', position: b.position || 'left', textColor: b.textColor || '#FFFFFF', outline: '#000000', scale: 1, tilt: 0, shade: true };
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
    it.design = { ...it.design, ...req.body };
    const old = it.out;
    it.out = await renderThumb(it.base, it.design, t.format);
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
