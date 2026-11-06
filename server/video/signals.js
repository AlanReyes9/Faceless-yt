// Señales objetivas para detectar momentos virales: energía del audio, cambios de plano y ritmo de habla.
import { run, FFMPEG } from './ffmpeg.js';

/** Nivel RMS (dB) por segundo de un archivo de audio. Devuelve [{t, db}] con t absoluto (+offset). */
export async function audioEnergy(audioFile, offset = 0) {
  const { err } = await run(FFMPEG, ['-hide_banner', '-i', audioFile, '-af',
    'aresample=16000,asetnsamples=n=16000:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level',
    '-f', 'null', '-'], { allowFail: true });
  const out = [];
  let t = null;
  for (const line of err.split('\n')) {
    const mt = line.match(/pts_time:([\d.]+)/);
    if (mt) t = parseFloat(mt[1]);
    const mv = line.match(/RMS_level=(-?[\d.]+|-inf)/);
    if (mv && t != null) { out.push({ t: Math.round(t + offset), db: mv[1] === '-inf' ? -90 : Math.max(-90, parseFloat(mv[1])) }); t = null; }
  }
  return out;
}

/** Cambios de plano analizando solo fotogramas clave (rápido incluso en vídeos largos). Devuelve segundos. */
export async function sceneCuts(input, { threshold = 0.35, timeoutMs = 90000 } = {}) {
  const p = run(FFMPEG, ['-hide_banner', '-skip_frame', 'nokey', '-i', input, '-an', '-vf',
    `scale=160:90,select=gt(scene\\,${threshold}),showinfo`, '-vsync', '0', '-f', 'null', '-'], { allowFail: true });
  const timeout = new Promise(r => setTimeout(() => r(null), timeoutMs));
  const res = await Promise.race([p, timeout]);
  if (!res) return [];
  return [...res.err.matchAll(/pts_time:([\d.]+)/g)].map(m => +parseFloat(m[1]).toFixed(2));
}

const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

/**
 * Calcula estadísticas de referencia del vídeo y una función para describir/puntuar cualquier tramo.
 */
export function buildSignals({ energy = [], words = [], cuts = [] }) {
  const voiced = energy.filter(e => e.db > -60).map(e => e.db);
  const base = median(voiced);
  const mad = median(voiced.map(d => Math.abs(d - base))) || 3;
  const byT = new Map(energy.map(e => [e.t, e.db]));
  const z = t => byT.has(t) ? (byT.get(t) - base) / (mad * 1.48) : 0;
  const wpsAll = words.length && words.at(-1).end > 0 ? words.length / words.at(-1).end : 2.5;

  function describe(start, end) {
    const secs = [];
    for (let t = Math.floor(start); t <= Math.ceil(end); t++) secs.push(z(t));
    const peaks = secs.filter(v => v > 2).length;
    const avgZ = secs.length ? secs.reduce((a, b) => a + b, 0) / secs.length : 0;
    const w = words.filter(x => x.start >= start && x.end <= end);
    const rate = w.length / Math.max(1, end - start);
    const nCuts = cuts.filter(c => c >= start && c <= end).length;
    const laugh = w.some(x => /\b(ja){2,}|risas|\(laugh|haha/i.test(x.word));
    const question = w.some(x => /\?/.test(x.word));
    return { peaks, avgZ, rate, rateRel: rate / wpsAll, cuts: nCuts, laugh, question };
  }

  /** Etiquetas cortas que se añaden a la transcripción para que la IA las tenga en cuenta. */
  function tags(start, end) {
    const d = describe(start, end), t = [];
    if (d.peaks || d.avgZ > 1.2) t.push('🔊energía alta');
    if (d.rateRel > 1.3) t.push('⚡habla rápida');
    if (d.cuts) t.push('🎬cambio de plano');
    if (d.laugh) t.push('😂risas');
    return t.length ? ` [${t.join(' ')}]` : '';
  }

  /** Nota 0-10 basada solo en señales (energía, picos, ritmo, risas). */
  function score(start, end) {
    const d = describe(start, end), dur = Math.max(1, end - start);
    let s = 5;
    s += Math.max(-2, Math.min(2.5, d.avgZ * 1.5));
    s += Math.min(2, d.peaks / dur * 20);
    s += d.rateRel > 1.15 ? 1 : d.rateRel < 0.75 ? -1 : 0;
    s += d.laugh ? 1 : 0;
    s += Math.min(1, d.cuts / dur * 10);
    return { score: Math.max(1, Math.min(10, Math.round(s))), ...d };
  }
  return { describe, tags, score, hasAudioData: voiced.length > 0 };
}
