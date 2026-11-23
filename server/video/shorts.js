import fs from 'node:fs';
import { downloadVideo } from './ytdlp.js';
import path from 'node:path';
import { q, one, getProject, updateProject, getClip, updateClip, WORK_DIR, IS_VERCEL } from '../db.js';
import { ffmpeg, probe, run, assFilter, FFMPEG } from './ffmpeg.js';
import { buildASS, sliceWords, normWord } from './ass.js';
import { trackFaces, trackSpeakers, cropPlan, cropExpr } from './face.js';
import { buildSignals } from './signals.js';
import { emojiImage } from './emoji.js';
import { detectFacecam, gamingFilter, splitFilter } from './gaming.js';
import { transcribeChunk, CHUNK_SECONDS } from '../ai/transcribe.js';
import { chatJSON } from '../ai/llm.js';
import { computeKeep, cutParts, remapWords, timeMapper } from './autocut.js';
import { getSetting } from '../settings.js';
import { register, enqueue } from '../jobs.js';
import { saveFile, inputPath, removeFile } from '../storage.js';

const projectFail = async ({ id }, msg) => updateProject(id, { status: 'error', error: msg, progress: null });

// ---------- Paso 1: preparar origen ----------
/** Descargas en curso por proyecto (para poder cancelarlas). */
export const activeDownloads = new Map();
register('shorts.start', async ({ id }) => {
  const p = await getProject(id);
  await updateProject(id, { status: 'processing', error: null, progress: 'Preparando el vídeo…', percent: 1 });
  let source = p.source;
  // Un origen descargado sin imagen (solo audio) se vuelve a descargar
  if (source && p.source_url && !(await probe(inputPath(source)).catch(() => ({ hasVideo: true }))).hasVideo) {
    await removeFile(source).catch(() => {});
    source = null;
    p.data = { ...p.data, transcript: null };
    await updateProject(id, { source: null });
  }
  if (!source && p.source_url) {
    if (IS_VERCEL) throw new Error('En Vercel no se pueden descargar enlaces (YouTube bloquea los servidores en la nube). Sube el archivo de vídeo directamente. (400)');
    await updateProject(id, { progress: 'Obteniendo el vídeo del enlace…' });
    for (const n of fs.readdirSync(WORK_DIR)) if (n.startsWith(`dl_${id}.`)) fs.rmSync(path.join(WORK_DIR, n), { force: true }); // restos de un intento anterior
    const d = p.data.options?.download || {};
    const ac = new AbortController();
    activeDownloads.set(id, ac);
    let file;
    try {
      file = await downloadVideo(p.source_url, WORK_DIR, `dl_${id}`, (pct, text, extra) => {
        q(`UPDATE projects SET progress = $2, percent = $3, data = jsonb_set(data, '{download}', $4::jsonb, true) WHERE id = $1`,
          [id, text, Math.max(1, Math.round(pct * 0.1)), JSON.stringify({ pct: Math.round(pct), ...(extra || {}), active: true })]).catch(() => {});
      }, { height: d.height, from: d.from, to: d.to, estMB: d.estMB, signal: ac.signal });
    } finally { activeDownloads.delete(id); }
    await q(`UPDATE projects SET data = jsonb_set(data, '{download}', '{"pct":100,"done":true}'::jsonb, true) WHERE id = $1`, [id]);
    await updateProject(id, { progress: 'Guardando el vídeo…', percent: 10 });
    source = await saveFile(file, `source_${id}.mp4`);
    fs.rmSync(file, { force: true });
    await updateProject(id, { source });
  }
  const info = await probe(inputPath(source));
  const multi = p.data.options?.multi;
  if (!info.hasAudio && !multi) throw new Error('El vídeo no tiene audio, no se puede transcribir. (400)');
  if (!info.hasVideo) throw new Error('El archivo no tiene imagen (solo audio): no se pueden crear clips. Sube el vídeo completo. (400)');
  // Los cambios de plano se detectan durante la transcripción (misma lectura del vídeo)
  p.data = { ...p.data, cuts: p.data.cuts || [], width: info.width, height: info.height };
  if (p.data.transcript?.words?.length) { // ya transcrito (reintento): saltar a la selección
    await updateProject(id, { duration: info.duration, data: p.data });
    return enqueue('shorts.pick', { id });
  }
  await updateProject(id, { duration: info.duration, data: { ...p.data, transcript: { language: '', segments: [], words: [], energy: [] } } });
  // Multi Edit sin sonido o sin subtítulos: no hace falta transcribir
  if (multi && (!info.hasAudio || p.data.options.captions === false)) return enqueue('shorts.pick', { id });
  await enqueue('shorts.transcribe', { id, chunk: 0 });
}, projectFail);

// Multi Edit de un vídeo subido: el vídeo entero es el clip original y de él salen las versiones
async function multiFromUpload(p) {
  const o = p.data.options, id = p.id;
  await updateProject(id, { progress: 'Preparando las versiones…', percent: 50 });
  for (const old of await q('SELECT file FROM clips WHERE project_id = $1', [id])) await removeFile(old.file);
  await q('DELETE FROM clips WHERE project_id = $1', [id]);
  const end = Math.min(p.duration || 0, 900);
  if (!(end > 1)) throw new Error('El vídeo es demasiado corto. (400)');
  const title = p.title.replace(/^🧬\s*/, '');
  const base = await one(`INSERT INTO clips (project_id, idx, start, "end", title, hook, score, reason, layout, status, style, keywords, emojis, signals, edit)
    VALUES ($1,1,0,$2,$3,'',10,$4,$5,'rendering',$6,'[]','[]','{}',$7) RETURNING *`,
    [id, end, title.slice(0, 100), '🧬 Vídeo original (con subtítulos)', o.layout || 'crop', o.captionStyle || 'impacto',
      JSON.stringify({ captions: { show: o.captions !== false, style: o.captionStyle || 'impacto' }, hookOn: false, layout: o.layout || 'crop', crop: { mode: 'face', zoom: 1 } })]);
  await enqueue('clip.render', { clipId: base.id });
  const { createVersions } = await import('./multiedit.js');
  const r = await createVersions(base, o.multi);
  await updateProject(id, { progress: `Renderizando ${r.count} versiones…`, percent: 55 });
}

// ---------- Paso 2: transcribir por trozos ----------
register('shorts.transcribe', async ({ id, chunk }) => {
  const p = await getProject(id);
  const chunks = Math.max(1, Math.ceil(p.duration / CHUNK_SECONDS));
  await updateProject(id, { progress: `Transcribiendo audio (${chunk + 1}/${chunks})…`, percent: Math.round(5 + 45 * chunk / chunks) });
  let lastP = 0;
  const r = await transcribeChunk(inputPath(p.source), { offset: chunk * CHUNK_SECONDS, len: CHUNK_SECONDS, language: p.data.options?.language,
    onProgress: ({ stage, pct }) => { if (Date.now() - lastP < 3000) return; lastP = Date.now();
      updateProject(id, { progress: `${stage}${pct ? ` ${pct}%` : ''} (${chunk + 1}/${chunks})`, percent: Math.round(5 + 45 * (chunk + (pct || 0) / 100) / chunks) }).catch(() => {}); } });
  const t = p.data.transcript || { segments: [], words: [] };
  // Evita duplicar si este paso se reintenta
  const from = chunk * CHUNK_SECONDS;
  t.segments = t.segments.filter(s => s.start < from).concat(r.segments);
  t.words = t.words.filter(w => w.start < from).concat(r.words);
  t.energy = (t.energy || []).filter(e => e.t < from).concat(r.energy || []);
  p.data.cuts = (p.data.cuts || []).filter(c => c < from).concat(r.cuts || []);
  t.language ||= r.language;
  await updateProject(id, { data: { ...p.data, transcript: t } });
  if (chunk + 1 < chunks) await enqueue('shorts.transcribe', { id, chunk: chunk + 1 });
  else await enqueue('shorts.pick', { id });
}, projectFail);

// ---------- Paso 3: la IA elige los clips ----------
export async function pickClips(transcript, sig, opts) {
  const { count } = opts;
  // IA local (contexto limitado): los vídeos largos se analizan por partes y se juntan los mejores momentos
  const all = transcript.segments.map(s => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}${sig.tags(s.start, s.end)}`);
  const LIMIT = 55000;
  if ((await getSetting('llm_provider')) === 'local' && all.join('\n').length > LIMIT) {
    const parts = []; let cur = [], len = 0;
    transcript.segments.forEach((s, i) => { cur.push(s); len += all[i].length + 1; if (len > LIMIT) { parts.push(cur); cur = []; len = 0; } });
    if (cur.length) parts.push(cur);
    const per = Math.max(2, Math.ceil(count * 1.5 / parts.length));
    const found = [];
    for (const [i, segs] of parts.entries()) {
      opts.onProgress?.(`La IA local analiza la parte ${i + 1} de ${parts.length}…`);
      found.push(...await pickClipsOnce({ ...transcript, segments: segs }, sig, { ...opts, count: per, onProgress: t => opts.onProgress?.(`Parte ${i + 1} de ${parts.length} · ${t}`) }).catch(e => { console.warn('parte', i, e.message); return []; }));
    }
    return found.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0)).slice(0, count + 3);
  }
  return pickClipsOnce(transcript, sig, opts);
}

async function pickClipsOnce(transcript, sig, { count, minSec, maxSec, language, onProgress, strict }) {
  // IA local: respuesta más corta (sin el desglose de notas) = bastante más rápida en equipos sin gráfica
  const local = (await getSetting('llm_provider')) === 'local';
  const lines = transcript.segments.map(s => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}${sig.tags(s.start, s.end)}`).join('\n');
  const system = `Eres el mejor editor de vídeos cortos virales (YouTube Shorts, TikTok, Reels). Sabes exactamente qué momentos de un vídeo largo retienen a la audiencia y se comparten.
Criterios (de más a menos importante):
1. GANCHO: los primeros 3 segundos deben atrapar (frase impactante, pregunta, conflicto, dato sorprendente). Si la mejor frase está a mitad, empieza el clip ahí.
2. HISTORIA COMPLETA: se entiende sin contexto y tiene planteamiento → tensión → remate o revelación.
3. EMOCIÓN: humor, sorpresa, polémica, indignación, inspiración o vulnerabilidad.
4. VALOR: consejo accionable, secreto, dato que la gente quiera guardar o enviar.
5. FINAL: termina en una frase completa y contundente, sin cortar a media idea.
Las etiquetas entre corchetes son señales medidas del audio y el vídeo: 🔊 energía alta (gritos, risas, emoción), ⚡ habla rápida, 🎬 cambio de plano, 😂 risas. Úsalas como pista, pero manda el contenido.`;
  const user = `Transcripción con marcas de tiempo en segundos:
${lines}

Devuelve hasta ${count} clips que NO se solapen, de entre ${minSec} y ${maxSec} segundos cada uno, ordenados de más a menos viral.${strict ? `
MUY IMPORTANTE: esto es un tramo de un directo y no todo tiene valor. Elige SOLO momentos que de verdad funcionarían solos como vídeo corto
(algo gracioso, sorprendente, emocionante, polémico, una jugada o reacción buena, un consejo o historia que se entienda sin contexto).
Si no hay ninguno así, devuelve {"clips":[]}. NO rellenes con charla de relleno, saludos, silencios, lectura del chat sin gracia ni partes aburridas.
Sé honesto con "score": 8-10 solo si lo subirías sin dudar; 5-7 si es normalito.` : ''}
JSON: {"clips":[{"start":número,"end":número,
 "title":"título para YouTube con gancho (máx 70 caracteres)",
 "hook":"frase de gancho de 3 a 7 palabras para mostrar arriba los primeros 4 segundos",
 ${local ? '' : '"scores":{"hook":1-10,"story":1-10,"emotion":1-10,"value":1-10,"ending":1-10},\n '}"score":entero 1-10 (potencial viral global),
 "keywords":["3 a 6 palabras EXACTAS que se dicen en el clip y conviene resaltar en los subtítulos"],
 "emojis":[{"word":"palabra exacta que se dice","emoji":"un emoji"}] (2 a 4, solo donde aporten),
 "reason":"por qué funcionará, ${local ? 'máx. 12 palabras' : 'en una frase'}"}]}
Escribe title, hook y reason en el idioma: ${language || 'el mismo del vídeo'}. keywords y emojis.word deben aparecer tal cual en la transcripción del clip.`;
  const res = await chatJSON(system, user, { maxTokens: local ? 5000 : 8000, onProgress: onProgress && (p => onProgress(p.stage || p)) });
  return Array.isArray(res) ? res : (res.clips || []);
}

export function snap(words, start, end) {
  const near = (arr, t, k) => arr.filter(w => Math.abs(w[k] - t) < 1.5).sort((a, b) => Math.abs(a[k] - t) - Math.abs(b[k] - t))[0];
  const s = near(words, start, 'start'), e = near(words, end, 'end');
  return { start: Math.max(0, (s?.start ?? start) - 0.1), end: (e?.end ?? end) + 0.25 };
}

register('shorts.pick', async ({ id }) => {
  const p = await getProject(id);
  if (p.data.options?.multi) return multiFromUpload(p);
  if (!p.data.transcript?.segments?.length) throw new Error('No se detectó voz en el vídeo. (400)');
  await updateProject(id, { progress: 'La IA está buscando los mejores momentos…', percent: 50 });
  const opts = { count: 10, minSec: 20, maxSec: 60, layout: 'face', ...p.data.options };
  const sig = buildSignals({ energy: p.data.transcript.energy, words: p.data.transcript.words, cuts: p.data.cuts || [] });
  const picked = await pickClips(p.data.transcript, sig, { ...opts, language: opts.titleLanguage, onProgress: txt => updateProject(id, { progress: txt }).catch(() => {}) });
  if (!picked.length) throw new Error('La IA no encontró clips en la transcripción.');
  for (const old of await q('SELECT file FROM clips WHERE project_id = $1', [id])) await removeFile(old.file);
  await q('DELETE FROM clips WHERE project_id = $1', [id]);
  let n = 0;
  for (const c of picked) {
    let { start, end } = snap(p.data.transcript.words, Number(c.start), Number(c.end));
    end = Math.min(end, p.duration || end);
    if (!(end - start > 3)) continue;
    // Nota final: 75 % criterio de la IA + 25 % señales medidas (si hay datos de audio)
    const llm = Math.max(1, Math.min(10, Number(c.score) || 5));
    const measured = sig.score(start, end);
    const final = sig.hasAudioData ? Math.round(llm * 0.75 + measured.score * 0.25) : Math.round(llm);
    const signals = { llm, measured: measured.score, scores: c.scores || {}, peaks: measured.peaks, rate: +measured.rate.toFixed(2), cuts: measured.cuts, laugh: measured.laugh };
    const clipWords = new Set(sliceWords(p.data.transcript.words, start, end).map(w => normWord(w.word)));
    const keywords = (c.keywords || []).map(String).filter(k => clipWords.has(normWord(k))).slice(0, 6);
    const emojis = (c.emojis || []).filter(e => e?.emoji && clipWords.has(normWord(e.word))).slice(0, 4);
    const clip = await one(`INSERT INTO clips (project_id, idx, start, "end", title, hook, score, reason, layout, status, style, keywords, emojis, signals)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'rendering',$10,$11,$12,$13) RETURNING id`,
      [id, ++n, start, end, String(c.title || '').slice(0, 100), String(c.hook || '').slice(0, 80),
        Math.max(1, Math.min(10, final)), c.reason || '', opts.layout, opts.captionStyle || 'clasico',
        JSON.stringify(keywords), JSON.stringify(opts.emojis === false ? [] : emojis), JSON.stringify(signals)]);
    await enqueue('clip.render', { clipId: clip.id });
  }
  await updateProject(id, { progress: `Renderizando ${n} clips…`, percent: 55 });
  await enqueue('shorts.report', { id }); // informe: títulos, descripción, SEO, capítulos y mejoras
}, projectFail);

// ---------- Paso 4: render de cada clip ----------
// Calidad según el intento: si un render se pasa de tiempo, el siguiente intento es más rápido.
function quality(attempt = 1) {
  const base = process.env.X264_PRESET || (IS_VERCEL ? 'superfast' : 'veryfast');
  if (attempt <= 1) return { preset: base, crf: 22, W: 1080, H: 1920 };
  if (attempt === 2) return { preset: 'ultrafast', crf: 24, W: 1080, H: 1920 };
  return { preset: 'ultrafast', crf: 25, W: 720, H: 1280 };
}

/** Guarda el progreso de un clip (como mucho cada 2 s para no saturar la base de datos). */
function progressWriter(clipId) {
  let last = 0;
  return async (stage, pct, force = false) => {
    if (!force && Date.now() - last < 2000) return;
    last = Date.now();
    await updateClip(clipId, { stage, progress: Math.max(0, Math.min(100, Math.round(pct))) }).catch(() => {});
  };
}

export async function renderClip(clipId, { lang } = {}, ctx = { attempt: 1, remaining: () => Infinity }) {
  const clip = await getClip(clipId);
  if (!clip) return;
  const p = await getProject(clip.project_id);
  // Trozos de vídeo que forman el clip: normalmente el original; en directos, uno o dos segmentos grabados
  let dur = clip.end - clip.start;
  let parts = clip.src ? JSON.parse(clip.src) : [{ ref: p.source, ss: clip.start, dur }];
  if (parts.some(x => !x.ref) || p.data.sourceDeletedAt) throw new Error('El vídeo original se borró para ahorrar espacio; no se puede volver a renderizar. (410)');
  const prog = progressWriter(clipId);
  await updateClip(clipId, { status: 'rendering', error: null });
  await prog(ctx.attempt > 1 ? `Reintento ${ctx.attempt} (modo rápido)…` : 'Preparando…', 0, true);
  const E = clip.edit || null; // ajustes del editor (encuadre, formato, subtítulos, texto corregido)
  let allWords = p.type === 'live' ? await liveWords(p.id, clip.start, clip.end) : (p.data.transcript?.words || []);
  if (E?.words) allWords = [...allWords.filter(w => w.end <= E.wordsFrom || w.start >= E.wordsTo), ...E.words].sort((a, b) => a.start - b.start);
  // Edición automática: cortar silencios y retomas (se calcula una vez y se guarda; [] = nada que cortar)
  const o = p.data.options || {}, AC = E?.autocut || {};
  const cutSilence = AC.silence ?? o.cutSilence, cutRetakes = AC.retakes ?? o.cutRetakes, condense = AC.condense ?? o.condense;
  let keep = clip.keep;
  if (keep == null && (cutSilence || cutRetakes)) {
    await prog(cutRetakes ? 'Quitando retomas y silencios…' : 'Quitando silencios…', 0, true);
    keep = await computeKeep({ words: allWords, start: clip.start, end: clip.end, cutSilence, cutRetakes, condense, language: o.titleLanguage || o.language }) || [];
    await updateClip(clipId, { keep });
    if (keep.length) console.log(`[edición automática] clip ${clipId}: ${keep.length} tramo(s), ${(clip.end - clip.start).toFixed(1)} s → ${keep.reduce((t, [a, b]) => t + b - a, 0).toFixed(1)} s`);
  }
  if (!(cutSilence || cutRetakes)) keep = null;
  if (keep?.length) parts = cutParts(parts, clip.start, keep);
  // Varios trozos: cada uno dura un número exacto de fotogramas (vídeo y audio se recortan igual al unirlos)
  if (parts.length > 1) { parts = parts.map(x => ({ ...x, dur: Math.max(1, Math.round(x.dur * 30)) / 30 })); dur = parts.reduce((t, x) => t + x.dur, 0); }
  const inputs = parts.map(x => inputPath(x.ref));
  const words0 = lang ? (clip.variants[lang]?.words || []) : sliceWords(allWords, clip.start, clip.end);
  const words = keep?.length ? remapWords(words0, keep, clip.start) : words0;
  const mapT = keep?.length ? timeMapper(keep, clip.start) : null;
  const hook = lang ? (clip.variants[lang]?.hook || '') : (E?.hookOn === false ? '' : clip.hook);
  const FMT = { v: [1080, 1920], sq: [1080, 1080], p45: [1080, 1350] }[E?.format] || [1080, 1920];
  const [OW, OH] = FMT;
  const C = E?.captions || {};
  const capMargin = C.y != null ? Math.round((1 - Number(C.y)) * OH) : (clip.layout === 'blur' ? 560 : 420) * OH / 1920;
  const tag = `c${clip.id}${lang ? '_' + lang : ''}_${Date.now()}`;
  const assFile = path.join(WORK_DIR, `${tag}.ass`);
  const out = path.join(WORK_DIR, `${tag}.mp4`);
  try {
    const capLayout = []; // líneas que ocupa cada subtítulo (para colocar los emojis encima sin taparlo)
    fs.writeFileSync(assFile, buildASS(words, { layout: capLayout, font: E?.font, textColor: C.textColor,
      // El gancho se muestra como texto fijo arriba durante todo el clip, con el estilo elegido en el editor
      titleBar: hook ? { color: E?.titleBar?.color || '#FFFFFF', bg: E?.titleBar?.bg || 'none', size: E?.titleBar?.size || 1, text: hook,
        top: (E?.layout || clip.layout) === 'gaming' ? Math.round(OH * 0.355) + 40 : undefined } : null,
      hook: '', duration: dur, highlight: C.color || await getSetting('caption_color'),
      captionMarginV: Math.round(capMargin), width: OW, height: OH,
      captions: C.show != null ? C.show !== false : p.data.options?.captions !== false,
      style: C.style || clip.style || p.data.options?.captionStyle || 'clasico', keywords: lang ? [] : (clip.keywords || []),
      sizeScale: C.size, upper: C.upper, wpg: C.wpg,
      // Gaming: el gancho va justo debajo de la cámara del jugador (arriba del juego) para no taparle la cara
      ...((E?.layout || clip.layout) === 'gaming' ? { hookMarginV: Math.round(OH * 0.355) + 40 } : {}),
    }));
    const ass = assFilter(assFile);
    const input = inputs[0];
    // Recorre los trozos del clip aplicando un análisis y uniendo los resultados en una sola línea de tiempo
    const overParts = async fn => {
      const outAll = []; let acc = 0;
      for (const [i, part] of parts.entries()) {
        const r = await fn(inputs[i], part, acc);
        if (!r) return null;
        outAll.push(...r.map(x => ({ ...x, t: x.t + acc })));
        acc += part.dur;
      }
      return outAll;
    };
    // Encuadre "face": la ventana vertical sigue a la persona que habla
    let layout = E?.layout || clip.layout, facePlan = null;
    const manualKeys = E?.crop?.mode === 'manual' && E.crop.keys?.length ? E.crop.keys : null;
    if (layout === 'face' && !manualKeys && E?.crop?.mode !== 'fixed') {
      const W = p.data.width || (await probe(input)).width, H = p.data.height || (await probe(input)).height;
      // v2: encuadre en quien habla (los encuadres guardados con la versión anterior se recalculan)
      const keepKey = keep?.length ? JSON.stringify(keep) : '';
      const cached = clip.track && clip.track.v === 2 && clip.track.start === clip.start && clip.track.end === clip.end && (clip.track.keep || '') === keepKey ? clip.track : null;
      facePlan = cached ? cached.plan : null;
      if (!cached) {
        try {
          let samples = await overParts((inp, part) => trackFaces(inp, part.ss, part.dur, {
            onProgress: f => prog('Detectando caras', f * 40),
            timeoutMs: Math.max(30000, Math.min(150000, ctx.remaining() - 20000)),
          }));
          // Varias personas en plano: se encuadra a quien está hablando
          const multi = samples.filter(x => x.n >= 2).length >= samples.length * 0.3;
          if (multi) {
            try {
              const voice = words;
              const t0 = Date.now();
              const spk = await overParts((inp, part, acc) => trackSpeakers(inp, part.ss, part.dur, {
                words: voice.filter(w => w.start >= acc && w.start < acc + part.dur).map(w => ({ ...w, start: w.start - acc, end: w.end - acc })),
                onProgress: f => prog('Detectando quién habla', 40 + f * 60),
                timeoutMs: Math.max(30000, Math.min(150000, ctx.remaining() - 60000)),
              }));
              if (spk?.some(x => x.cx != null)) {
                samples = spk;
                const changes = spk.reduce((n, x, i) => n + (i && x.speaker !== spk[i - 1].speaker ? 1 : 0), 0);
                console.log(`[caras] clip ${clipId}: ${new Set(spk.map(x => x.speaker)).size} persona(s), ${changes} cambio(s) de hablante en ${((Date.now() - t0) / 1000).toFixed(1)} s`);
              }
            } catch (e) { console.warn('hablante:', e.message); } // si falla, se usa la cara principal
          }
          facePlan = cropPlan(samples, W, H);
        } catch (e) { console.warn('caras:', e.message); }
        await updateClip(clipId, { track: { v: 2, start: clip.start, end: clip.end, keep: keepKey, plan: facePlan } });
        // En Vercel el render va en un paso nuevo para tener el tiempo completo
        if (ctx.remaining() < 200000) {
          await prog('En cola para renderizar', 0, true);
          await enqueue('clip.render', { clipId, lang });
          return 'requeued';
        }
      }
      if (facePlan) facePlan.H = H;
      else if (!E) layout = 'blur'; // sin caras detectadas: fondo difuminado (en el editor: encuadre fijo)
    }
    // Plantilla Gaming: facecam arriba (detectada una vez por proyecto, o la ajustada en el editor) y partida abajo
    let cam = null;
    if (layout === 'gaming') {
      if (E?.facecam) cam = E.facecam;
      else if (p.data.facecam && 'rect' in p.data.facecam) cam = p.data.facecam.rect;
      else {
        await prog('Buscando la cámara del jugador', 5, true);
        cam = await detectFacecam(input, { from: parts[0].ss, dur: Math.min(parts[0].dur, 90) }).catch(e => { console.warn('facecam:', e.message); return null; });
        await q(`UPDATE projects SET data = jsonb_set(data, '{facecam}', $2::jsonb, true) WHERE id = $1`, [p.id, JSON.stringify({ rect: cam, at: new Date().toISOString() })]);
        console.log(`[gaming] proyecto ${p.id}: facecam ${cam ? JSON.stringify(Object.fromEntries(Object.entries(cam).map(([k, v]) => [k, +v.toFixed(3)]))) : 'no encontrada'}`);
      }
    }
    let vf;
    // Los subtítulos y emojis se diseñan a 1080x1920; en modo rápido se escala al final
    const Q = quality(ctx.attempt);
    // Varios trozos: se unen (vídeo y audio) antes de aplicar el encuadre
    const vin = parts.length > 1 ? '[cv]' : '[0:v]';
    const pre = parts.length > 1 ? parts.map((x, i) => `[${i}:v]fps=30,trim=duration=${x.dur.toFixed(5)},setpts=PTS-STARTPTS,setsar=1[pv${i}];` +
        `[${i}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration=${x.dur.toFixed(5)},asetpts=PTS-STARTPTS[pa${i}];`).join('') +
      `${parts.map((_, i) => `[pv${i}][pa${i}]`).join('')}concat=n=${parts.length}:v=1:a=1[cv][ca];` : '';
    if (layout === 'split') {
      // Pantalla dividida: dos recuadros del original, uno arriba y otro abajo
      const W = p.data.width || (await probe(input)).width, H = p.data.height || (await probe(input)).height;
      vf = splitFilter({ vin: '[0:v]', W, H, a: E?.facecam || { x: 0, y: 0, w: 0.5, h: 1 }, b: E?.split2 || { x: 0.5, y: 0, w: 0.5, h: 1 }, OW, OH, ass, top: Number(E?.splitTop) || 0.5 });
    } else if (layout === 'gaming') {
      const W = p.data.width || (await probe(input)).width, H = p.data.height || (await probe(input)).height;
      vf = gamingFilter({ vin: '[0:v]', W, H, cam, OW, OH, ass });
    } else if (E && layout !== 'blur') {
      // Encuadre del editor: zoom, posición vertical, fotogramas manuales, seguimiento de cara o fijo
      const W = p.data.width || (await probe(input)).width, H = p.data.height || (await probe(input)).height;
      const z = Math.max(1, Math.min(3, Number(E.crop?.zoom) || 1));
      let ch = Math.round(H / z / 2) * 2, cw = Math.round(ch * OW / OH / 2) * 2;
      if (cw > W) { cw = Math.floor(W / 2) * 2; ch = Math.min(H, Math.round(cw * OH / OW / 2) * 2); }
      const y = Math.max(0, Math.min(H - ch, Math.round((Number(E.crop?.cy ?? 0.5)) * H - ch / 2)));
      const clampX = cx => Math.max(0, Math.min(W - cw, Math.round(cx * W - cw / 2)));
      let keys;
      if (manualKeys) {
        // El cambio se aplica en el fotograma donde se puso la marca: se adelanta 0,6 fotogramas (las marcas antiguas del
        // editor estaban en el centro del fotograma y el corte salía un fotograma tarde)
        let fps = Number(p.data.fps) || 0;
        if (!fps) { fps = (await probe(input).catch(() => ({}))).fps || 30; await q(`UPDATE projects SET data = data || $2::jsonb WHERE id = $1`, [p.id, JSON.stringify({ fps })]).catch(() => {}); }
        const early = 0.6 / fps;
        keys = [...manualKeys].sort((a, b) => a.t - b.t).map(k => ({ t: Math.max(0, (mapT ? mapT(k.t - clip.start, true) : k.t - clip.start) - early), x: clampX(k.cx), cut: !!k.cut }));
      }
      else if (layout === 'face' && facePlan) keys = facePlan.keys.map(k => ({ ...k, x: clampX((k.x + facePlan.cw / 2) / W) }));
      else keys = [{ t: 0, x: clampX(Number(E.crop?.cx ?? 0.5)), cut: true }];
      if (keys[0].t > 0) keys.unshift({ ...keys[0], t: 0, cut: true });
      vf = `[0:v]crop=w=${cw}:h=${ch}:x=${cropExpr({ keys })}:y=${y},scale=${OW}:${OH},setsar=1,${ass}[base]`;
    } else if (layout === 'blur' && E) vf = `[0:v]split=2[a][b];[a]scale=${OW / 4}:${OH / 4}:force_original_aspect_ratio=increase,crop=${OW / 4}:${OH / 4},boxblur=10:2,scale=${OW}:${OH},eq=brightness=-0.06[bg];` +
      `[b]scale=${OW}:${OH}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,${ass}[base]`;
    else if (layout === 'face') vf = `[0:v]crop=w=${facePlan.cw}:h=${facePlan.H}:x=${cropExpr(facePlan)}:y=0,scale=1080:1920,setsar=1,${ass}[base]`;
    else if (layout === 'crop') vf = `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,${ass}[base]`;
    else vf = `[0:v]split=2[a][b];[a]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=10:2,scale=1080:1920,eq=brightness=-0.06[bg];` +
      `[b]scale=1080:1920:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,${ass}[base]`;
    // Multi Edit: filtro de color de la versión (se aplica a la imagen antes del encuadre y los subtítulos)
    const GRADES = { vivo: 'eq=saturation=1.28:contrast=1.06', calido: 'colorbalance=rs=0.07:gs=0.02:bs=-0.06,eq=saturation=1.1', frio: 'colorbalance=rs=-0.05:bs=0.08,eq=contrast=1.04',
      cine: 'eq=contrast=1.12:saturation=0.88:brightness=-0.02', brillo: 'eq=brightness=0.04:contrast=1.04:saturation=1.12', bn: 'hue=s=0,eq=contrast=1.1' };
    // Ajustes del editor: brillo, contraste y saturación (-50…50)
    const A = E?.adjust || {}, ab = Number(A.b) || 0, ac = Number(A.c) || 0, as = Number(A.s) || 0;
    const adj = ab || ac || as ? `eq=brightness=${(ab / 100 * 0.3).toFixed(3)}:contrast=${(1 + ac / 100).toFixed(3)}:saturation=${Math.max(0, 1 + as / 100).toFixed(3)},` : '';
    const grade = (GRADES[E?.grade] ? GRADES[E.grade] + ',' : '') + adj;
    // Espejo y zoom suave cada N s: sobre la imagen ya encuadrada, antes de los textos (que no se voltean)
    const every = Math.max(0, Math.min(30, Number(E?.motion) || 0));
    const Z = every ? `if(eq(mod(floor(t/${every})\\,2)\\,1)\\,1.12\\,1)` : null;
    const post = (E?.mirror ? 'hflip,' : '') + (Z ? `scale=w='trunc(${OW}*${Z}/2)*2':h='trunc(${OH}*${Z}/2)*2':eval=frame,crop=${OW}:${OH},setsar=1,` : '');
    if (post) vf = vf.replace(ass, post + ass);
    // Un solo trozo: se pasa a 30 fps al principio (como con varios trozos), para que los cambios de encuadre caigan en su fotograma
    vf = pre + vf.replace('[0:v]', vin + (parts.length > 1 ? '' : 'fps=30,') + grade);

    // Emojis animados sobre los subtítulos cuando se dice la palabra
    const extra = [];
    let last = 'base';
    const emojiList = lang || E?.emojis === false ? [] : (clip.emojis || []);
    const capY = OH - capMargin; // misma altura que los subtítulos
    let k = 0;
    for (const e of emojiList) {
      const w = words.find(x => normWord(x.word) === normWord(e.word));
      if (!w) continue;
      const img = await emojiImage(e.emoji).catch(() => null);
      if (!img) continue;
      const i = parts.length + k++;
      extra.push('-loop', '1', '-i', img);
      const t0 = Math.max(0, w.start - 0.05).toFixed(2), t1 = (w.start + 1.3).toFixed(2);
      // aparece con un pequeño rebote de escala
      // altura del bloque de subtítulos mientras se ve el emoji (la más alta si cambia de grupo)
      const blocks = capLayout.filter(b => b.end > w.start - 0.05 && b.start < w.start + 1.3);
      const blockH = Math.max(1, ...blocks.map(b => b.lines)) * (blocks[0]?.size || 90) * 1.22;
      const ey = Math.max(30, Math.round(capY - blockH - 170 - 30));
      vf += `;[${i}:v]format=rgba,scale=170:170,fade=in:st=${t0}:d=0.12:alpha=1,fade=out:st=${(w.start + 1.1).toFixed(2)}:d=0.2:alpha=1[e${i}];` +
        `[${last}][e${i}]overlay=x=(W-w)/2:y=${ey}-20*sin(min(1\\,(t-${t0})*6)*PI):enable='between(t,${t0},${t1})':shortest=1[o${i}]`;
      last = `o${i}`;
    }
    // Fotos y logos colocados en el editor (posición y tamaño normalizados; desde/hasta en segundos del clip)
    for (const ov of (E?.overlays || []).slice(0, 10)) {
      if (!ov?.ref) continue;
      const i = parts.length + extra.filter(x => x === '-i').length;
      extra.push('-loop', '1', '-i', inputPath(ov.ref));
      const w = Math.max(20, Math.round(OW * Math.max(0.05, Math.min(1, Number(ov.w) || 0.3)) / 2) * 2);
      const x = Math.round((Number(ov.x) || 0.5) * OW - w / 2), y = `${Math.round((Number(ov.y) || 0.3) * OH)}-h/2`;
      const a = Math.max(0, Number(ov.from) || 0), b = Number(ov.to) > a ? Number(ov.to) : dur + 1;
      const op = ov.kind === 'logo' ? Math.max(0.1, Math.min(1, Number(ov.opacity) || 1)) : 1;
      const when = ov.kind === 'logo' ? '' : `:enable='between(t,${a.toFixed(2)},${b.toFixed(2)})'`;
      vf += `;[${i}:v]format=rgba,scale=${w}:-2${op < 1 ? `,colorchannelmixer=aa=${op.toFixed(2)}` : ''}[ov${i}];[${last}][ov${i}]overlay=x=${x}:y=${y}${when}:shortest=1[ovo${i}]`;
      last = `ovo${i}`;
    }
    // Mi marca: marco y logo encima de todo (si el proyecto o el clip lo piden)
    if (E?.brand ?? p.data.options?.brand) {
      const { brandFilter } = await import('../brand.js');
      const bf = await brandFilter({ last, firstInput: parts.length + k, OW, OH });
      extra.push(...bf.args); vf += bf.filter; last = bf.last;
    }
    vf += Q.W !== 1080 ? `;[${last}]scale=${Q.W}:${Math.round(Q.W * OH / OW / 2) * 2}[v]` : `;[${last}]null[v]`;
    if (ctx.remaining() < 45000) { // no empezar un render sin tiempo suficiente: va a una ejecución nueva
      await prog('En cola para renderizar', 0, true);
      await enqueue('clip.render', { clipId, lang });
      return 'requeued';
    }
    // Audio: volumen parejo (loudnorm) y música de fondo que baja cuando se habla
    let amap = parts.length > 1 ? '[ca]' : '0:a?';
    const normalize = E?.audio?.normalize ?? o.normalize, music = E?.audio?.music ?? o.music;
    if (!lang && (normalize || music)) {
      const hasA = parts.length > 1 || (await probe(inputs[0]).catch(() => ({ hasAudio: true }))).hasAudio;
      let a = parts.length > 1 ? '[ca]' : hasA ? '[0:a]' : null;
      if (a && normalize) {
        // Volumen parejo: se mide el volumen real del tramo y se aplica una ganancia fija con limitador
        // (el loudnorm dinámico movía el audio unos ms al final del clip)
        let sum = 0, tot = 0;
        for (const [i, x] of parts.entries()) {
          const { err } = await run(FFMPEG, ['-hide_banner', '-ss', x.ss.toFixed(3), '-t', x.dur.toFixed(3), '-i', inputs[i], '-vn', '-af', 'ebur128=framelog=quiet', '-f', 'null', '-'], { allowFail: true, timeoutMs: 60000 }).catch(() => ({ err: '' }));
          const I = Number((err.match(/I:\s+(-?[\d.]+) LUFS/g) || []).pop()?.match(/-?[\d.]+/)?.[0]);
          if (Number.isFinite(I) && I > -70) { sum += Math.pow(10, I / 10) * x.dur; tot += x.dur; }
        }
        const I = tot ? 10 * Math.log10(sum / tot) : null;
        if (I != null) {
          const gain = Math.max(-20, Math.min(24, -14 - I));
          vf += `;${a}aresample=48000,volume=${gain.toFixed(2)}dB,alimiter=limit=0.84:level=false[an]`; a = '[an]';
        }
      }
      if (music) {
        const mi = parts.length + extra.filter(x => x === '-i').length;
        extra.push('-stream_loop', '-1', '-i', inputPath(music));
        const vol = Math.max(0.02, Math.min(1, Number(E?.audio?.musicVolume ?? o.musicVolume) || 0.18));
        vf += `;[${mi}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${vol.toFixed(2)}[mus]`;
        if (a) vf += `;${a}aformat=channel_layouts=stereo,asplit=2[a1][a2];[mus][a2]sidechaincompress=threshold=0.03:ratio=6:attack=15:release=350[duck];[a1][duck]amix=inputs=2:duration=first:normalize=0[aout]`;
        else vf += `;[mus]atrim=0:${dur.toFixed(3)}[aout]`;
        a = '[aout]';
      }
      if (a && a !== '[0:a]' && a !== '[ca]') amap = a;
    }
    // Velocidad de la voz y del vídeo (1,1x…1,5x): se acelera el resultado ya montado (textos incluidos, que van a su ritmo)
    const speed = lang ? 1 : Math.max(1, Math.min(1.5, Number(E?.speed) || 1));
    let outDur = dur;
    if (speed > 1.001) {
      vf = vf.replace(/;\[(\w+)\](scale=[^;\[]*|null)\[v\]/, (m, l, f) => `;[${l}]setpts=PTS/${speed.toFixed(3)},${f}[v]`);
      const hasA = amap !== '0:a?' || (await probe(inputs[0]).catch(() => ({ hasAudio: true }))).hasAudio;
      if (hasA) { const src = amap === '0:a?' ? '[0:a]' : amap; vf += `;${src}atempo=${speed.toFixed(3)}[asp]`; amap = '[asp]'; }
      outDur = dur / speed;
    }
    await prog('Renderizando', 0, true);
    const inArgs = parts.flatMap((x, i) => ['-ss', x.ss.toFixed(3), ...(parts.length > 1 ? ['-t', (x.dur + 0.5).toFixed(3)] : []), '-i', inputs[i]]);
    await ffmpeg(['-threads', '0', ...inArgs, ...extra, '-t', outDur.toFixed(3),
      '-filter_complex', vf, '-map', '[v]', '-map', amap,
      '-c:v', 'libx264', '-preset', Q.preset, '-crf', String(Q.crf), '-pix_fmt', 'yuv420p', '-r', '30',
      '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out], {
      onProgress: sec => prog('Renderizando', (sec / outDur) * 95),
      timeoutMs: ctx.remaining() - 15000, // parar antes de que el servidor corte la función
    });
    await prog('Guardando', 97, true);
    const ref = await saveFile(out, `short_${tag}.mp4`);
    const fresh = await getClip(clipId);
    if (lang) {
      const old = fresh.variants[lang]?.file;
      fresh.variants[lang] = { ...fresh.variants[lang], file: ref };
      await updateClip(clipId, { variants: fresh.variants, status: 'ready', progress: 100, stage: null });
      await removeFile(old);
    } else {
      await removeFile(fresh.file);
      await updateClip(clipId, { file: ref, status: 'ready', progress: 100, stage: null });
    }
  } finally {
    fs.rmSync(assFile, { force: true }); fs.rmSync(out, { force: true });
  }
  await checkDone(clip.project_id);
}

/** Palabras de un directo entre dos instantes (se guardan por segmento). */
export async function liveWords(projectId, start, end) {
  const rows = await q('SELECT words FROM live_segments WHERE project_id = $1 AND start < $3 AND start + dur > $2 ORDER BY seg', [projectId, start, end]);
  return rows.flatMap(r => r.words || []);
}

export async function checkDone(projectId) {
  const pr = await getProject(projectId);
  if (pr?.type === 'live' && !pr.data.live?.ended) return; // el directo sigue: el proyecto continúa en curso
  const r = await one(`SELECT COUNT(*) FILTER (WHERE status IN ('rendering','pending'))::int AS busy,
      COUNT(*) FILTER (WHERE status = 'ready')::int AS ready, COUNT(*) FILTER (WHERE status = 'error')::int AS failed
    FROM clips WHERE project_id = $1`, [projectId]);
  if (r.busy) return;
  if (!r.ready && r.failed) {
    await updateProject(projectId, { status: 'error', error: `No se pudo renderizar ningún Short (${r.failed} con error). Pulsa "Reintentar" para volver a renderizarlos.`, progress: null });
  } else {
    await updateProject(projectId, { status: 'ready', ready_at: new Date().toISOString(), error: null, percent: 100, progress: `${r.ready} clips listos${r.failed ? ` · ${r.failed} con error` : ''}` });
  }
}
const clipFail = async ({ clipId }, msg) => {
  await updateClip(clipId, { status: 'error', error: msg, stage: null });
  const c = await getClip(clipId);
  if (c) await checkDone(c.project_id);
};

register('clip.render', ({ clipId, lang }, ctx) => renderClip(clipId, { lang }, ctx), clipFail);

// ---------- Traducción ----------
register('clip.translate', async ({ clipId, lang }, ctx) => {
  const clip = await getClip(clipId);
  const p = await getProject(clip.project_id);
  const allSegs = p.type === 'live' ? (await q('SELECT segments FROM live_segments WHERE project_id = $1 ORDER BY seg', [p.id])).flatMap(r => r.segments || []) : (p.data.transcript?.segments || []);
  const segs = allSegs.filter(s => s.end > clip.start && s.start < clip.end)
    .map(s => ({ start: Math.max(0, s.start - clip.start), end: Math.min(clip.end, s.end) - clip.start, text: s.text }));
  const res = await chatJSON('Eres un traductor profesional de subtítulos para vídeos cortos. Traduces de forma natural y breve, manteniendo el tono.',
    `Traduce al idioma "${lang}". Devuelve {"hook":"...","title":"...","segments":["texto traducido 1", ...]} con el mismo número de segmentos (${segs.length}).
Gancho: ${clip.hook}
Título: ${clip.title}
Segmentos:
${segs.map((s, i) => `${i + 1}. ${s.text}`).join('\n')}`);
  const words = [];
  segs.forEach((s, i) => {
    const parts = String(res.segments?.[i] || '').split(/\s+/).filter(Boolean);
    const step = (s.end - s.start) / Math.max(1, parts.length);
    parts.forEach((w, j) => words.push({ word: w, start: s.start + j * step, end: s.start + (j + 1) * step }));
  });
  clip.variants[lang] = { ...clip.variants[lang], hook: res.hook || '', title: res.title || '', words };
  await updateClip(clipId, { variants: clip.variants });
  await enqueue('clip.render', { clipId, lang }); // el render va en su propio paso
}, clipFail);
