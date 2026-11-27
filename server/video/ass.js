// Generador de subtítulos ASS (estilo "Shorts": palabras grandes, la actual resaltada).
const FONT = process.env.FONT_NAME || 'DejaVu Sans';

function assColor(hex, alpha = '00') {
  const h = (hex || '#FFFFFF').replace('#', '').padEnd(6, 'F');
  return `&H${alpha}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
}
function ts(t) {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60), cs = Math.floor((t % 1) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
const esc = s => String(s).replace(/\\/g, '').replace(/[{}]/g, '').replace(/\n/g, '\\N');

/** Estilos de subtítulos disponibles. */
// Letras disponibles (carpeta fonts/): nombre de familia → etiqueta
export const FONTS = {
  'DejaVu Sans': 'Clásica (DejaVu)', 'Anton': 'Anton (alta y estrecha)', 'Bebas Neue': 'Bebas Neue (titulares)',
  'Poppins Black': 'Poppins Black (moderna)', 'Archivo Black': 'Archivo Black (impacto)', 'Lilita One': 'Lilita One (redondeada)',
  'Bangers': 'Bangers (cómic)', 'DM Serif Display': 'DM Serif (elegante)',
};
/** Estilos del texto fijo (gancho durante todo el clip). */
export const TITLE_STYLES = {
  sticker: 'Sticker (borde doble, como los virales)', contorno: 'Contorno negro', caja: 'Caja de color', amarillo: 'Amarillo con contorno',
  neon: 'Neón', sombra: 'Sombra fuerte',
};
const titleStyleOf = tb => TITLE_STYLES[tb?.style] ? tb.style : (tb?.bg && tb.bg !== 'none' ? 'caja' : 'sticker');
export const CAPTION_STYLES = {
  clasico: { label: 'Clásico (palabra resaltada)', wpg: 3, size: 80, upper: true, mode: 'color' },
  marcador: { label: 'Marcador (palabra con fondo de color)', wpg: 3, size: 80, upper: true, mode: 'box' },
  impacto: { label: 'Impacto (grande, 2 palabras, con pop)', wpg: 2, size: 104, upper: true, mode: 'pop', outline: 10 },
  minimal: { label: 'Minimalista (frase completa, discreto)', wpg: 6, size: 58, upper: false, mode: 'none', outline: 4 },
};
const norm = w => String(w).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]/gu, '');
export { norm as normWord };

const TITLE_TOP = 110;
const titleSize = tb => Math.round(64 * (Number(tb?.size) || 1));
const titleBarBottom = (tb, height) => TITLE_TOP + Math.ceil(String(tb.text).length / 24) * titleSize(tb) * 1.25 + 30;

/** Divide un texto largo en 2 líneas equilibradas. */
function wrap(text, max = 22) {
  if (text.length <= max) return text;
  const words = text.split(' ');
  let best = text, bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' '), b = words.slice(i).join(' ');
    const d = Math.abs(a.length - b.length);
    if (d < bestDiff) { bestDiff = d; best = a + '\\N' + b; }
  }
  return best;
}

/**
 * @param words  [{word,start,end}] con tiempos RELATIVOS al inicio del clip
 * @param opts   { hook, hookSeconds, duration, highlight, captionY, wordsPerGroup }
 */
export function buildASS(words, { hook = '', hookSeconds = 4, duration = 60, highlight = '#FFD400', captionMarginV = 560, wordsPerGroup = 3, captions = true, width = 1080, height = 1920, capSize = 80, hookSize = 80, overlay = '', style = 'clasico', keywords = [], keywordColor = '#3DFF6E', sizeScale = 1, upper, wpg, hookMarginV = 190, layout = null, font = null, textColor = null, titleBar = null } = {}) {
  const F = FONTS[font] ? font : FONT;
  const tStyle = titleStyleOf(titleBar);
  const TF = FONTS[titleBar?.font] ? titleBar.font : tStyle === 'sticker' ? 'Anton' : F;
  const base = textColor && /^#[0-9a-f]{6}$/i.test(textColor) ? assColor(textColor) : '&H00FFFFFF', baseC = base;
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Hook,${F},${hookSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,1,0,0,0,100,100,0,0,1,7,3,8,60,60,${titleBar?.text ? Math.max(hookMarginV, titleBarBottom(titleBar, height) + 30) : hookMarginV},1
Style: Big,${F},${Math.round(hookSize * 1.15)},&H00FFFFFF,&H00FFFFFF,&H00000000,&HA0000000,1,0,0,0,100,100,0,0,3,18,0,5,80,80,0,1
Style: Cap,${F},${capSize},${baseC},${baseC},&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,8,4,2,60,60,${captionMarginV},1
Style: Title,${TF},${titleSize(titleBar)},${tStyle === 'amarillo' ? '&H0000D4FF' : titleBar?.color ? assColor(titleBar.color) : '&H00FFFFFF'},&H00FFFFFF,${tStyle === 'caja' ? assColor(titleBar.bg && titleBar.bg !== 'none' ? titleBar.bg : '#E11D48') : '&H00000000'},&H00000000,1,0,0,0,100,100,0,0,${tStyle === 'caja' ? 3 : 1},${tStyle === 'caja' ? 16 : 7},0,8,70,70,${titleBar?.top || TITLE_TOP},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const lines = [];
  // Título fijo durante todo el clip, arriba, con caja de color opcional
  if (titleBar?.text) {
    // las letras estrechas (Anton, Bebas) se ven pequeñas: se agrandan para ocupar el ancho como en los vídeos virales
    const cond = TF === 'Anton' || TF === 'Bebas Neue', tsz = Math.round(titleSize(titleBar) * (cond ? 1.45 : 1)), acc = assColor(titleBar.accent || '#E11D48');
    const txt = wrap(esc(titleBar.upper === false ? titleBar.text : titleBar.text.toUpperCase()), cond ? 17 : 24);
    // posición libre (arrastrada en el editor): centro del bloque de texto
    const pos = Number.isFinite(titleBar.x) && Number.isFinite(titleBar.y) ? `\\an5\\pos(${Math.round(titleBar.x * width)},${Math.round(titleBar.y * height)})` : '';
    const L = (layer, tags) => lines.push(`Dialogue: ${layer},${ts(0)},${ts(duration)},Title,,0,0,0,,{${pos}\\fs${tsz}${tags}}${txt}`);
    if (tStyle === 'sticker') { L(3, `\\bord${Math.round(tsz * 0.3)}\\3c${acc}\\shad0`); L(4, `\\bord${Math.max(3, Math.round(tsz * 0.09))}\\3c&H00000000&\\shad0`); }
    else if (tStyle === 'neon') { L(3, `\\bord${Math.round(tsz * 0.2)}\\3c${acc}\\blur14\\shad0`); L(4, `\\bord3\\3c${acc}\\shad0`); }
    else if (tStyle === 'sombra') L(3, `\\bord2\\3c&H00000000&\\shad${Math.round(tsz * 0.14)}\\4c&H00000000&\\4a&H30&`);
    else if (tStyle === 'amarillo') L(3, `\\bord${Math.round(tsz * 0.12)}\\3c&H00000000&\\shad3`);
    else L(3, '');
  }
  if (hook) {
    // Línea 1 en color de resalte, línea 2 en blanco (estilo gancho viral)
    const [l1, l2] = wrap(esc(hook.toUpperCase()), 18).split('\\N');
    const txt = `{\\c${assColor(highlight)}}${l1}` + (l2 ? `\\N{\\c&H00FFFFFF&}${l2}` : '');
    lines.push(`Dialogue: 1,${ts(0)},${ts(Math.min(hookSeconds, duration))},Hook,,0,0,0,,{\\fad(150,200)}${txt}`);
  }
  if (overlay) {
    // Texto grande centrado (p. ej. llamada a la acción de un anuncio)
    lines.push(`Dialogue: 2,${ts(0)},${ts(duration)},Big,,0,0,0,,{\\fad(200,0)\\c${assColor(highlight)}}${wrap(esc(overlay.toUpperCase()), 16)}`);
  }
  if (captions && words.length) {
    words = cleanWords(words, duration);
    const st0 = CAPTION_STYLES[style] || CAPTION_STYLES.clasico;
    // Ajustes del editor: tamaño, mayúsculas y palabras por grupo
    const st = { ...st0, size: Math.round(st0.size * (Number(sizeScale) || 1)), upper: upper ?? st0.upper, wpg: Number(wpg) || st0.wpg };
    const capEvents = [];
    const hl = assColor(highlight), kw = assColor(keywordColor);
    const kwSet = new Set((keywords || []).map(norm).filter(Boolean));
    const isKw = w => kwSet.has(norm(w));
    const per = Number(wpg) || (style === 'clasico' || !CAPTION_STYLES[style] ? wordsPerGroup : st.wpg);
    // Agrupa palabras: corta por número, por signos de puntuación o por pausas largas
    const groups = [];
    let cur = [];
    // Reglas de subtitulado profesional: no más de unas pocas letras por grupo, una coma solo corta si ya hay 2 palabras,
    // y no se deja una palabra sola colgando al final de una frase (se añade al grupo anterior).
    const maxChars = Math.max(14, per * 7);
    const len = g => g.reduce((n, x) => n + String(x.word).length, 0) + g.length - 1;
    const endsSentence = w => /[.!?…]["»”]?$/.test(w.word);
    words.forEach((w, i) => {
      if (cur.length && len(cur) + 1 + String(w.word).length > maxChars + 4) { groups.push(cur); cur = []; }
      cur.push(w);
      const next = words[i + 1];
      const pause = next && next.start - w.end > 0.6;
      const orphanNext = next && cur.length <= per && endsSentence(next) && !pause && len(cur) + 1 + String(next.word).length <= maxChars + 4 && next.start - w.end < 0.3;
      if (orphanNext) return; // la siguiente palabra cierra la frase: va en este grupo
      if (cur.length >= per || endsSentence(w) || (/[,;:]$/.test(w.word) && cur.length >= 2) || pause || !next) { groups.push(cur); cur = []; }
    });
    const baseTag = st.size !== capSize ? `{\\fs${st.size}${st.outline != null ? `\\bord${st.outline}` : ''}}` : '';
    groups.forEach((g, gi) => {
      const nextStart = groups[gi + 1]?.[0]?.start ?? g[g.length - 1].end + 0.4;
      // Una palabra muy larga no cabe en el ancho (libass no la parte): se reduce la letra solo en este grupo
      const longest = Math.max(...g.map(x => String(x.word).length));
      const fitSize = Math.min(st.size, Math.floor((width - 140) / (longest * (st.upper ? 0.64 : 0.55) * 1.12)));
      const gTag = fitSize < st.size ? `{\\fs${fitSize}${st.outline != null ? `\\bord${st.outline}` : ''}}` : baseTag;
      g.forEach((w, wi) => {
        const start = w.start;
        let end = wi < g.length - 1 ? g[wi + 1].start : Math.min(nextStart, w.end + 0.5);
        if (end <= start) end = start + 0.08;
        const text = g.map((x, xi) => {
          // en pantalla se quitan comas y puntos finales (se ve más limpio); se mantienen ¿? ¡!
          const shown = String(x.word).replace(/[.,;:…]+(["»”]?)$/, '$1') || x.word;
          const t = esc(st.upper ? shown.toUpperCase() : shown);
          const active = xi === wi && st.mode !== 'none';
          const color = isKw(x.word) ? kw : active ? hl : null;
          if (active && st.mode === 'box') return `{\\3c${hl}\\bord16\\shad0}${t}{\\3c&H00000000&\\bord${st.outline ?? 8}\\shad4}`;
          if (active) return `{${color ? `\\c${color}` : ''}\\fscx110\\fscy110}${t}{\\c${base}\\fscx100\\fscy100}`;
          if (color) return `{\\c${color}}${t}{\\c${base}}`;
          return t;
        }).join(' ');
        // "impacto": cada grupo entra con un pequeño "pop"
        const pop = st.mode === 'pop' && wi === 0 ? '{\\fscx75\\fscy75\\t(0,110,\\fscx100\\fscy100)}' : '';
        capEvents.push({ start, end: Math.min(end, duration), text: `${gTag}${pop}${text}` });
      });
      // Líneas que ocupará el grupo (libass parte el texto si no cabe en el ancho): para colocar los emojis encima
      if (layout) {
        const chars = g.reduce((n, x) => n + String(x.word).length, 0) + g.length - 1;
        const textW = chars * Math.min(st.size, fitSize) * (st.upper ? 0.68 : 0.58) * 1.05;
        layout.push({ start: g[0].start, end: Math.min(nextStart, g[g.length - 1].end + 0.5), size: Math.min(st.size, fitSize), lines: Math.min(3, Math.max(1, Math.ceil(textW / (width - 140)))) });
      }
    });
    // Garantía final: nunca dos subtítulos a la vez (si coinciden, el motor los dibuja uno encima de otro)
    capEvents.sort((x, y) => x.start - y.start);
    for (let i = 0; i < capEvents.length; i++) {
      const e = capEvents[i], next = capEvents[i + 1];
      if (next && e.end > next.start) e.end = next.start;
      // se redondea igual que ts() para que fin y siguiente inicio caigan en la misma centésima
      if (Math.floor(e.end * 100) <= Math.floor(e.start * 100)) continue;
      lines.push(`Dialogue: 0,${ts(e.start)},${ts(e.end)},Cap,,0,0,0,,${e.text}`);
    }
  }
  return header + lines.join('\n') + '\n';
}

/**
 * Limpia los tiempos de Whisper: tiempos crecientes, sin solapes y con duración mínima (sin cambiar el orden).
 * (Whisper a veces devuelve palabras de duración 0 o que empiezan antes de que acabe la anterior.)
 */
export function cleanWords(words, duration = Infinity) {
  const MIN = 0.08;
  const out = words.filter(w => w && String(w.word).trim() && Number.isFinite(w.start))
    // se respeta el orden de las palabras (el de Whisper); solo se corrigen los tiempos hacia delante
    .map(w => ({ ...w, start: Math.max(0, w.start), end: Math.max(w.start, Number.isFinite(w.end) ? w.end : w.start) }));
  for (let i = 0; i < out.length; i++) {
    const w = out[i], prev = out[i - 1];
    if (prev && w.start < prev.start + MIN) w.start = prev.start + MIN;     // dos palabras no empiezan a la vez
    if (prev && prev.end > w.start) prev.end = w.start;                     // la anterior termina cuando empieza esta
    if (w.end < w.start + MIN) w.end = w.start + MIN;                       // duración mínima visible
  }
  return out.filter(w => w.start < duration);
}

/** Recorta las palabras de una transcripción al rango [start,end] y las hace relativas. */
export function sliceWords(words, start, end) {
  return words.filter(w => w.end > start && w.start < end)
    .map(w => ({ word: w.word, start: Math.max(0, w.start - start), end: Math.min(end, w.end) - start }));
}
