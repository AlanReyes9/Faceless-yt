// Vídeos de RANKING ("Top 5 momentos…"): clips en cuenta atrás con los números a la izquierda,
// la etiqueta de cada puesto aparece cuando empieza su clip y se queda, título arriba con la última palabra resaltada.
import fs from 'node:fs';
import path from 'node:path';
import { getProject, updateProject, WORK_DIR, IS_VERCEL } from '../db.js';
import { ffmpeg, probe, assFilter } from './ffmpeg.js';
import { chatJSON } from '../ai/llm.js';
import { download } from '../ai/media.js';
import { register, enqueue } from '../jobs.js';
import { saveFile, inputPath, toLocal, removeFile } from '../storage.js';
import { downloadVideo } from './ytdlp.js';

const W = 1080, H = 1920;
export const RANK_COLORS = ['#FFE600', '#FFFFFF', '#FF2D2D', '#2EE62E', '#FF7AD9', '#3FB6FF', '#FF9F1A', '#B57BFF', '#00F0D0', '#FFC2E0'];
export const RANK_LAYOUT = { top: 250, video: 1400 }; // barra superior + zona de vídeo (debajo queda la barra inferior)

const assColor = hex => { const h = hex.replace('#', ''); return `&H00${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`.toUpperCase(); };
const assText = s => String(s || '').replace(/[{}\\]/g, '').replace(/\n/g, ' ')
  // las fuentes no tienen emojis en color: se quitan para que no salgan cuadrados
  .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '').replace(/\s+/g, ' ').trim();
const t = s => { s = Math.max(0, s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = (s % 60).toFixed(2).padStart(5, '0'); return `${h}:${String(m).padStart(2, '0')}:${x}`; };

/** Título con palabras resaltadas: *así* en amarillo; si no hay asteriscos, se resalta la última palabra. */
function titleASS(title, color) {
  let s = assText(title).toUpperCase();
  if (!s.includes('*')) s = s.replace(/(\S+)$/, '*$1*');
  return s.replace(/\*([^*]+)\*/g, (_, w) => `{\\c${assColor(color)}}${w}{\\c&H00FFFFFF&}`).replace(/\*/g, '');
}

/** Subtítulos ASS del ranking. order: lista de puestos en el orden en que se reproducen; starts[k]: inicio del clip k. */
export function rankingASS({ title, bottom, highlight = '#FFD400', items, order, starts, total }) {
  const n = items.length;
  const { top, video } = RANK_LAYOUT;
  const step = Math.min(170, Math.floor((video - 160) / n));
  const y0 = top + 90 + Math.max(0, Math.floor((video - 160 - step * n) / 4));
  const numSize = Math.min(150, Math.round(step * 0.88)), labelSize = Math.min(104, Math.round(step * 0.62));
  const lines = [];
  // Título (dos líneas como máximo, se reduce si es largo)
  // Tamaño para que el título llene el ancho (Anton: ~0.28 em por carácter en mayúsculas)
  const tl = Math.max(6, assText(title).replace(/\*/g, '').length);
  const tSize = Math.max(64, Math.min(150, Math.floor(1000 / (tl * 0.28))));
  lines.push(`Dialogue: 2,${t(0)},${t(total)},Title,,0,0,0,,{\\an5\\pos(${W / 2},${top / 2 + 6})\\q0}${titleASS(title, highlight)}`);
  if (bottom) lines.push(`Dialogue: 2,${t(0)},${t(total)},Bottom,,0,0,0,,{\\an5\\pos(${W / 2},${top + video + (H - top - video) / 2})}${assText(bottom)}`);
  for (let r = 1; r <= n; r++) {
    const y = y0 + (r - 1) * step + step / 2;
    const col = assColor(RANK_COLORS[(r - 1) % RANK_COLORS.length]);
    lines.push(`Dialogue: 1,${t(0)},${t(total)},Num,,0,0,0,,{\\an4\\pos(46,${y})\\fs${numSize}\\c${col}}${r}.`);
    const k = order.indexOf(r);
    const label = assText(items[r - 1].label);
    if (k >= 0 && label) {
      const x = 46 + Math.round(numSize * (r >= 10 ? 0.78 : 0.5));
      lines.push(`Dialogue: 1,${t(starts[k])},${t(total)},Label,,0,0,0,,{\\an4\\pos(${x},${y})\\fs${labelSize}\\fscx70\\fscy70\\t(0,140,\\fscx112\\fscy112)\\t(140,260,\\fscx100\\fscy100)}${label}`);
    }
  }
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Title,Anton,${tSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,1,0,1,6,3,5,40,40,10,1
Style: Num,Anton,110,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,7,4,4,10,10,10,1
Style: Label,Anton,90,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,1,0,1,6,3,4,10,40,10,1
Style: Bottom,DejaVu Sans,46,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,3,0,5,40,40,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${lines.join('\n')}
`;
}

/** Título y etiquetas sugeridos por la IA a partir del tema y de las notas de cada clip. */
export async function suggestRanking({ topic, notes = [], language = 'Español' }) {
  return chatJSON('Eres editor de Shorts virales de rankings ("Top 5 momentos…").',
    `Tema: "${topic}". Idioma: ${language}. Hay ${notes.length} clips, del puesto 1 (el mejor) al ${notes.length}.
Notas del usuario de cada clip, en orden: ${notes.map((x, i) => `${i + 1}. ${x || 'sin nota'}`).join(' | ')}
Escribe un título corto y llamativo en MAYÚSCULAS (máx. 4 palabras, marca entre *asteriscos* la palabra a resaltar en color)
y una etiqueta muy corta (1–3 palabras, sin emojis) para cada puesto. También un título de YouTube, descripción y etiquetas.
JSON: {"title":"RANKING FUNNY CAT *MOMENT*","labels":["..."],"yt_title":"...","description":"...","tags":["..."]}`, { maxTokens: 1500 });
}

// ---------- Paso 1: preparar cada clip (recorte, 1080×1400, 30 fps, audio estéreo) ----------
register('ranking.prep', async ({ id, i }, ctx) => {
  const p = await getProject(id);
  const o = p.data.options;
  const items = o.items;
  const it = items[i];
  const n = items.length;
  const next = () => i + 1 < n ? enqueue('ranking.prep', { id, i: i + 1 }) : enqueue('ranking.render', { id });
  if (p.data.parts?.[i]) return next(); // ya preparado (reintento)
  await updateProject(id, { status: 'processing', error: null, progress: `Preparando el clip del puesto ${i + 1} (${i + 1}/${n})…`, percent: Math.round(5 + 75 * i / n) });
  const dir = path.join(WORK_DIR, `rank_${id}_${i}_${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    let src;
    if (it.source) src = inputPath(it.source);
    else if (it.url && /\.(mp4|mov|webm|m4v)(\?|$)/i.test(it.url)) src = await download(it.url, path.join(dir, 'in.mp4'));
    else if (it.url) {
      if (IS_VERCEL) throw new Error(`Puesto ${i + 1}: en Vercel no se pueden descargar enlaces de YouTube/TikTok. Sube el archivo o usa la app de escritorio. (400)`);
      src = await downloadVideo(it.url, dir, 'in', (pct, text) => updateProject(id, { progress: `Puesto ${i + 1}: ${text}` }).catch(() => {}));
    } else throw new Error(`Falta el vídeo del puesto ${i + 1}. (400)`);
    const info = await probe(src);
    if (!info.hasVideo) throw new Error(`El vídeo del puesto ${i + 1} no tiene imagen. (400)`);
    const start = Math.max(0, Number(it.start) || 0);
    const maxDur = Math.max(2, Math.min(60, Number(o.maxClipSec) || 15));
    const end = Number(it.end) > start ? Math.min(Number(it.end), info.duration || Infinity) : Math.min((info.duration || maxDur) , start + maxDur);
    const dur = Math.max(1, Math.min(end - start, maxDur));
    const VH = RANK_LAYOUT.video;
    const r = info.width && info.height ? (info.width / info.height) / (W / VH) : 1;
    // Relleno (recorte) si la proporción se parece; si no, fondo difuminado con el vídeo entero
    const fill = o.fit === 'fill' || (o.fit !== 'blur' && r > 0.6 && r < 1.7);
    const vf = fill
      ? `[0:v]scale=${W}:${VH}:force_original_aspect_ratio=increase,crop=${W}:${VH},setsar=1,fps=30,format=yuv420p[v]`
      : `[0:v]split=2[a][b];[a]scale=270:350:force_original_aspect_ratio=increase,crop=270:350,boxblur=8:2,scale=${W}:${VH},eq=brightness=-0.1[bg];[b]scale=${W}:${VH}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=30,format=yuv420p[v]`;
    const out = path.join(dir, 'part.mp4');
    const audio = info.hasAudio && o.keepAudio !== false;
    await ffmpeg(['-ss', String(start), '-t', String(dur), '-i', src,
      ...(audio ? [] : ['-f', 'lavfi', '-t', String(dur), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000']),
      '-filter_complex', vf + (audio ? ';[0:a]aresample=48000,aformat=channel_layouts=stereo,apad[a]' : ''),
      '-map', '[v]', '-map', audio ? '[a]' : '1:a', '-t', String(dur),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-r', '30', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', out],
      { timeoutMs: ctx.remaining() - 20000 });
    const ref = await saveFile(out, `rank_${id}_${i}.mp4`);
    const fresh = await getProject(id);
    const parts = [...(fresh.data.parts || [])]; parts[i] = ref;
    await updateProject(id, { data: { ...fresh.data, parts } });
    await next();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, ({ id }, msg) => updateProject(id, { status: 'error', error: msg, progress: null }));

// ---------- Paso 2: unir en cuenta atrás + título, números y etiquetas ----------
register('ranking.render', async ({ id }, ctx) => {
  const p = await getProject(id);
  const o = p.data.options;
  const n = o.items.length;
  await updateProject(id, { progress: 'Montando el ranking…', percent: 85 });
  const dir = path.join(WORK_DIR, `rankr_${id}_${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    // Orden de reproducción: cuenta atrás (del último puesto al 1) o del 1 al último
    const order = o.order === 'asc' ? [...Array(n)].map((_, k) => k + 1) : [...Array(n)].map((_, k) => n - k);
    const files = [], starts = [];
    let total = 0;
    for (const r of order) {
      const f = await toLocal(p.data.parts[r - 1], path.join(dir, `${r}.mp4`));
      starts.push(total);
      total += (await probe(f)).duration;
      files.push(f);
    }
    const list = path.join(dir, 'list.txt');
    fs.writeFileSync(list, files.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
    const joined = path.join(dir, 'joined.mp4');
    await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined]);
    const ass = path.join(dir, 'r.ass');
    fs.writeFileSync(ass, rankingASS({ title: o.title, bottom: o.bottom, highlight: o.highlight, items: o.items, order, starts, total }));
    const out = path.join(dir, 'final.mp4');
    const bg = o.background || '#000000';
    await ffmpeg(['-i', joined, '-f', 'lavfi', '-i', `color=c=${bg.replace('#', '0x')}:s=${W}x${H}:r=30`,
      '-filter_complex', `[1:v][0:v]overlay=0:${RANK_LAYOUT.top}:shortest=1,${assFilter(ass)},format=yuv420p[v]`,
      '-map', '[v]', '-map', '0:a', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-c:a', 'copy', '-movflags', '+faststart', out],
      { timeoutMs: ctx.remaining() - 20000 });
    const info = await probe(out);
    const ref = await saveFile(out, `ranking_${id}.mp4`);
    await removeFile(p.output);
    await updateProject(id, { status: 'ready', ready_at: new Date().toISOString(), output: ref, duration: info.duration, progress: 'Ranking listo', percent: 100 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, ({ id }, msg) => updateProject(id, { status: 'error', error: msg, progress: null }));
