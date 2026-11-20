// Multi Edit: varias versiones distintas de un mismo clip (gancho, subtítulos, color, posición, zoom, filtro, recorte).
// Cada versión es un clip nuevo del proyecto que se renderiza como cualquier otro.
import { q, one, getProject } from '../db.js';
import { chatJSON } from '../ai/llm.js';
import { enqueue } from '../jobs.js';
import { sliceWords } from './ass.js';

const MULTI = {
  styles: ['impacto', 'clasico', 'marcador', 'minimal'],
  colors: ['#FFD400', '#00E5FF', '#FF3B6B', '#7CFF4F', '#FF8A00', '#B388FF', '#FFFFFF'],
  pos: [0.74, 0.62, 0.5, 0.8],
  sizes: [1, 1.15, 0.9, 1.25],
  zooms: [1, 1.1, 1.18, 1.05],
  grades: ['', 'vivo', 'calido', 'cine', 'frio', 'brillo'],
  trims: [[0, 0], [-1, 0], [0.8, 0], [-0.5, 1], [0.5, -0.5], [-1.5, 0.5]],
};
async function clipWords(p, c) {
  if (p.type !== 'live') return p.data.transcript?.words || [];
  const rows = await q('SELECT words FROM live_segments WHERE project_id = $1 AND start < $3 AND start + dur > $2 ORDER BY seg', [p.id, c.start, c.end]);
  return rows.flatMap(r => r.words || []);
}

/** Crea `count` versiones del clip `c` y las pone a renderizar. Devuelve { ids, count, hooks }. */
export async function createVersions(c, { count, vary } = {}) {
  const n = Math.max(2, Math.min(20, Math.round(Number(count) || 5)));
  const v = { hook: true, style: true, color: true, position: true, zoom: true, grade: true, trim: false, ...(vary || {}) };
  const p = await getProject(c.project_id);
  const base = c.edit || {};
  // Ganchos y títulos distintos (IA): uno por versión
  let texts = [];
  if (v.hook) {
    const all = await clipWords(p, c);
    const said = sliceWords(base.words || all, c.start, c.end).map(w => w.word).join(' ').slice(0, 2500);
    const lang = p.data.options?.titleLanguage || p.data.options?.language || '';
    try {
      const r = await chatJSON('Eres editor de vídeos cortos virales. Escribes ganchos muy distintos entre sí para probar cuál funciona mejor.',
        `Clip: título "${c.title || ''}", gancho actual "${c.hook || ''}". Lo que se dice: """${said}"""
Escribe ${lang ? 'en el idioma con código ' + lang : 'en el idioma del texto'} ${n} variantes distintas (pregunta, polémica, curiosidad, número, emoción, reto…).
JSON: {"items":[{"hook":"gancho de 3 a 7 palabras que sale arriba del vídeo","title":"título con gancho, máx 80 caracteres"}]}`, { maxTokens: 120 + n * 60 });
      texts = (r.items || []).filter(x => x && (x.hook || x.title));
    } catch (e) { console.warn('[multi edit] sin ganchos de la IA:', e.message); }
  }
  // Combinaciones: cada versión cambia varias cosas a la vez y no se repite con la anterior
  const rot = (arr, i, k) => arr[(i * k) % arr.length];
  const existing = (await one('SELECT COUNT(*)::int AS n FROM clips WHERE variant_of = $1', [c.id])).n;
  let idx = (await one('SELECT COALESCE(MAX(idx), 0)::int AS n FROM clips WHERE project_id = $1', [c.project_id])).n;
  const caps = base.captions || {};
  const ids = [];
  for (let i = 1; i <= n; i++) {
    const k = existing + i;
    const style = v.style ? rot(MULTI.styles, k, 1) : (caps.style || c.style || 'clasico');
    const edit = {
      ...base,
      format: base.format || 'v', layout: base.layout || c.layout,
      crop: { mode: base.crop?.mode || 'face', cx: base.crop?.cx ?? 0.5, cy: base.crop?.cy ?? 0.5, keys: base.crop?.keys || [], zoom: v.zoom ? rot(MULTI.zooms, k, 1) * (base.crop?.zoom || 1) : (base.crop?.zoom || 1) },
      captions: {
        ...caps, show: caps.show !== false, style,
        // en "marcador" el color es el fondo de la palabra (texto blanco): el blanco no se leería
        color: v.color ? ((col => style === 'marcador' && col === '#FFFFFF' ? '#FF3B6B' : col)(rot(MULTI.colors, k, 3))) : (caps.color || null),
        y: v.position ? rot(MULTI.pos, k, 1) : (caps.y ?? null),
        size: v.position ? rot(MULTI.sizes, k, 3) : (caps.size || 1),
        upper: v.style ? (k % 3 === 2 ? false : null) : (caps.upper ?? null),
      },
      hookOn: true,
      grade: v.grade ? rot(MULTI.grades, k, 1) || undefined : base.grade,
    };
    const t = texts.length ? texts[(i - 1) % texts.length] : null;
    // Inicio/final algo distinto (no en directos: sus trozos de vídeo son fijos)
    let start = c.start, end = c.end;
    if (v.trim && !c.src) {
      const [ds, de] = rot(MULTI.trims, k, 1);
      start = Math.max(0, c.start + ds); end = Math.min(p.duration || c.end + 2, c.end + de);
      if (end - start < 3) { start = c.start; end = c.end; }
    }
    const label = `V${k}`;
    const row = await one(`INSERT INTO clips (project_id, idx, start, "end", title, hook, score, reason, layout, status, style, keywords, emojis, signals, src, track, edit, variant_of, variant_label)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'rendering',$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
      [c.project_id, ++idx, start, end, String(t?.title || c.title || '').slice(0, 100), String(t?.hook || c.hook || '').slice(0, 80), c.score, `🧬 Versión ${k} de #${c.idx}`,
        edit.layout, style, JSON.stringify(c.keywords || []), JSON.stringify(c.emojis || []), JSON.stringify(c.signals || {}), c.src, c.track ? JSON.stringify(c.track) : null,
        JSON.stringify(edit), c.id, label]);
    ids.push(row.id);
    await enqueue('clip.render', { clipId: row.id });
  }
  return { ids, count: ids.length, hooks: texts.length };
}
