// Edición automática de un clip: cortar silencios y retomas/falsos comienzos (IA).
// Devuelve los tramos que se conservan (tiempos absolutos del vídeo) y ayuda a rehacer los trozos y los subtítulos.
import { chatJSON } from '../ai/llm.js';

const PAD = 0.12;        // margen alrededor de cada palabra para no comerse sílabas
const SILENCE = 0.55;    // pausa a partir de la cual se corta

/**
 * @param words  palabras con tiempos absolutos (todas las del vídeo; se filtran las del clip)
 * @returns [[inicio, fin], ...] absolutos, o null si no hay nada que cortar
 */
export async function computeKeep({ words, start, end, cutSilence, cutRetakes, condense, language }) {
  const ws = words.filter(w => w.end > start && w.start < end && String(w.word || '').trim()).sort((a, b) => a.start - b.start);
  if (ws.length < 3) return null;
  const removed = new Array(ws.length).fill(false);
  if (cutRetakes) {
    try {
      const list = ws.map((w, i) => `${i}:${String(w.word).trim()}`).join(' ');
      const r = await chatJSON('Eres un editor de vídeo experto en limpiar tomas habladas.', `Palabras numeradas de un clip (índice:palabra):
${list}

Marca para borrar SOLO:
- falsos comienzos y frases que la persona empieza, se traba y vuelve a decir (se queda la ÚLTIMA versión limpia),
- palabras repetidas por tartamudeo ("el el", "que que"),
- muletillas sueltas sin significado ("eh", "este…", "o sea" cuando sobra).${condense ? `
- además, ideas que se repiten con otras palabras (deja la versión más clara y corta).` : ''}
No borres contenido con significado nuevo. Si no hay nada que borrar, devuelve una lista vacía.
JSON: {"remove":[[desde,hasta],...]} con índices inclusivos${language ? ` (el texto está en ${language})` : ''}.`, { maxTokens: 600 });
      for (const rg of r.remove || []) {
        const a = Math.max(0, Math.floor(Number(rg?.[0]))), b = Math.min(ws.length - 1, Math.floor(Number(rg?.[1] ?? rg?.[0])));
        if (Number.isFinite(a) && Number.isFinite(b)) for (let i = a; i <= b; i++) removed[i] = true;
      }
      // Seguridad: si la IA quisiera borrar más de la mitad, se ignora
      if (removed.filter(Boolean).length > ws.length * (condense ? 0.55 : 0.4)) removed.fill(false);
    } catch (e) { console.warn('[edición automática] retomas:', e.message); }
  }
  // Tramos de palabras conservadas
  const ranges = [];
  let cur = null;
  ws.forEach((w, i) => {
    if (removed[i]) { cur = null; return; }
    const prev = i > 0 ? ws[i - 1] : null;
    const gap = prev ? w.start - prev.end : 0;
    if (cur && !(cutSilence && gap > SILENCE)) { cur[1] = w.end + PAD; return; }
    cur = [w.start - PAD, w.end + PAD]; ranges.push(cur);
  });
  if (!ranges.length) return null;
  // Sin cortar silencios: se conserva el principio y el final del clip tal cual
  if (!cutSilence) {
    if (!removed[0]) ranges[0][0] = start;
    if (!removed[ws.length - 1]) ranges[ranges.length - 1][1] = end;
  }
  // Ajustar a los límites del clip y unir tramos que se tocan
  const out = [];
  for (const [a0, b0] of ranges) {
    const a = Math.max(start, a0), b = Math.min(end, b0);
    if (b - a < 0.08) continue;
    if (out.length && a - out[out.length - 1][1] < 0.12) out[out.length - 1][1] = Math.max(out[out.length - 1][1], b);
    else out.push([a, b]);
  }
  const kept = out.reduce((s, [a, b]) => s + b - a, 0), total = end - start;
  if (!out.length || kept < Math.max(3, total * 0.35)) return null; // demasiado recorte: algo salió mal
  if (out.length === 1 && out[0][0] - start < 0.05 && end - out[0][1] < 0.05) return null; // nada que cortar
  return out.map(([a, b]) => [+a.toFixed(3), +b.toFixed(3)]);
}

/**
 * Rehace los trozos de vídeo del clip con solo los tramos conservados.
 * parts: [{ref, ss, dur}] consecutivos que empiezan en clipStart (tiempo absoluto).
 */
export function cutParts(parts, clipStart, keep) {
  const out = [];
  let acc = clipStart;
  for (const p of parts) {
    const p0 = acc, p1 = acc + p.dur;
    for (const [a, b] of keep) {
      const s = Math.max(a, p0), e = Math.min(b, p1);
      if (e - s > 0.04) out.push({ ref: p.ref, ss: +(p.ss + s - p0).toFixed(3), dur: +(e - s).toFixed(3) });
    }
    acc = p1;
  }
  return out;
}

/** Pasa un tiempo relativo al clip original al clip recortado (null si cae en un trozo cortado). */
export function timeMapper(keep, clipStart) {
  const rel = keep.map(([a, b]) => [a - clipStart, b - clipStart]);
  return (t, snap = false) => {
    let acc = 0;
    for (const [a, b] of rel) {
      if (t < a) return snap ? acc : null;
      if (t <= b) return acc + (t - a);
      acc += b - a;
    }
    return snap ? acc : null;
  };
}

/** Palabras (tiempos relativos al clip) colocadas en la línea de tiempo del clip recortado. */
export function remapWords(words, keep, clipStart) {
  const map = timeMapper(keep, clipStart);
  const out = [];
  for (const w of words) {
    const s = map(w.start + 0.02), e = map(w.end - 0.02);
    if (s == null && e == null) continue; // palabra cortada
    const ns = s ?? map(w.start, true), ne = e ?? map(w.end, true);
    out.push({ ...w, start: Math.max(0, ns), end: Math.max(ns + 0.05, ne) });
  }
  return out;
}
