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
export function buildASS(words, { hook = '', hookSeconds = 4, duration = 60, highlight = '#FFD400', captionMarginV = 560, wordsPerGroup = 3, captions = true, width = 1080, height = 1920, capSize = 80, hookSize = 80, overlay = '' } = {}) {
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
    const hl = assColor(highlight);
    const groups = [];
    for (let i = 0; i < words.length; i += wordsPerGroup) groups.push(words.slice(i, i + wordsPerGroup));
    groups.forEach((g, gi) => {
      const nextStart = groups[gi + 1]?.[0]?.start ?? g[g.length - 1].end + 0.4;
      g.forEach((w, wi) => {
        const start = w.start;
        let end = wi < g.length - 1 ? g[wi + 1].start : Math.min(nextStart, w.end + 0.5);
        if (end <= start) end = start + 0.08;
        const text = g.map((x, xi) => {
          const t = esc(x.word.toUpperCase());
          return xi === wi ? `{\\c${hl}\\fscx108\\fscy108}${t}{\\c&H00FFFFFF&\\fscx100\\fscy100}` : t;
        }).join(' ');
        lines.push(`Dialogue: 0,${ts(start)},${ts(Math.min(end, duration))},Cap,,0,0,0,,${text}`);
      });
    });
  }
  return header + lines.join('\n') + '\n';
}

/** Recorta las palabras de una transcripción al rango [start,end] y las hace relativas. */
export function sliceWords(words, start, end) {
  return words.filter(w => w.end > start && w.start < end)
    .map(w => ({ word: w.word, start: Math.max(0, w.start - start), end: Math.min(end, w.end) - start }));
}
