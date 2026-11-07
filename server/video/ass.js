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
export const CAPTION_STYLES = {
  clasico: { label: 'Clásico (palabra resaltada)', wpg: 3, size: 80, upper: true, mode: 'color' },
  marcador: { label: 'Marcador (palabra con fondo de color)', wpg: 3, size: 80, upper: true, mode: 'box' },
  impacto: { label: 'Impacto (grande, 2 palabras, con pop)', wpg: 2, size: 104, upper: true, mode: 'pop', outline: 10 },
  minimal: { label: 'Minimalista (frase completa, discreto)', wpg: 6, size: 58, upper: false, mode: 'none', outline: 4 },
};
const norm = w => String(w).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]/gu, '');
export { norm as normWord };

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
export function buildASS(words, { hook = '', hookSeconds = 4, duration = 60, highlight = '#FFD400', captionMarginV = 560, wordsPerGroup = 3, captions = true, width = 1080, height = 1920, capSize = 80, hookSize = 80, overlay = '', style = 'clasico', keywords = [], keywordColor = '#3DFF6E' } = {}) {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Hook,${FONT},${hookSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,1,0,0,0,100,100,0,0,1,7,3,8,60,60,190,1
Style: Big,${FONT},${Math.round(hookSize * 1.15)},&H00FFFFFF,&H00FFFFFF,&H00000000,&HA0000000,1,0,0,0,100,100,0,0,3,18,0,5,80,80,0,1
Style: Cap,${FONT},${capSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,8,4,2,60,60,${captionMarginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const lines = [];
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
    const st = CAPTION_STYLES[style] || CAPTION_STYLES.clasico;
    const capEvents = [];
    const hl = assColor(highlight), kw = assColor(keywordColor);
    const kwSet = new Set((keywords || []).map(norm).filter(Boolean));
    const isKw = w => kwSet.has(norm(w));
    const per = style === 'clasico' || !CAPTION_STYLES[style] ? wordsPerGroup : st.wpg;
    // Agrupa palabras: corta por número, por signos de puntuación o por pausas largas
    const groups = [];
    let cur = [];
    words.forEach((w, i) => {
      cur.push(w);
      const next = words[i + 1];
      if (cur.length >= per || /[.!?…,;:]$/.test(w.word) || (next && next.start - w.end > 0.6) || !next) { groups.push(cur); cur = []; }
    });
    const baseTag = st.size !== capSize ? `{\\fs${st.size}${st.outline != null ? `\\bord${st.outline}` : ''}}` : '';
    groups.forEach((g, gi) => {
      const nextStart = groups[gi + 1]?.[0]?.start ?? g[g.length - 1].end + 0.4;
      g.forEach((w, wi) => {
        const start = w.start;
        let end = wi < g.length - 1 ? g[wi + 1].start : Math.min(nextStart, w.end + 0.5);
        if (end <= start) end = start + 0.08;
        const text = g.map((x, xi) => {
          const t = esc(st.upper ? x.word.toUpperCase() : x.word);
          const active = xi === wi && st.mode !== 'none';
          const color = isKw(x.word) ? kw : active ? hl : null;
          if (active && st.mode === 'box') return `{\\3c${hl}\\bord16\\shad0}${t}{\\3c&H00000000&\\bord${st.outline ?? 8}\\shad4}`;
          if (active) return `{${color ? `\\c${color}` : ''}\\fscx110\\fscy110}${t}{\\c&H00FFFFFF&\\fscx100\\fscy100}`;
          if (color) return `{\\c${color}}${t}{\\c&H00FFFFFF&}`;
          return t;
        }).join(' ');
        // "impacto": cada grupo entra con un pequeño "pop"
        const pop = st.mode === 'pop' && wi === 0 ? '{\\fscx75\\fscy75\\t(0,110,\\fscx100\\fscy100)}' : '';
        capEvents.push({ start, end: Math.min(end, duration), text: `${baseTag}${pop}${text}` });
      });
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
