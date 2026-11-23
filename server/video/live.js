// Clips virales de un vídeo EN DIRECTO.
// El directo se graba por segmentos encadenados (cada uno es un paso corto, apto para Vercel) y,
// en paralelo, cada segmento se transcribe y la IA busca momentos virales para cortarlos al instante.
import fs from 'node:fs';
import path from 'node:path';
import { q, one, getProject, updateProject, WORK_DIR, IS_VERCEL } from '../db.js';
import { ffmpeg, probe, run, FFMPEG } from './ffmpeg.js';
import { sliceWords, normWord } from './ass.js';
import { buildSignals } from './signals.js';
import { transcribeChunk } from '../ai/transcribe.js';
import { register, enqueue } from '../jobs.js';
import { saveFile, inputPath } from '../storage.js';
import { pickClips, snap, checkDone } from './shorts.js';
import { resolvePlaylist, recordMedia } from './hls.js';
import { ytdlp, parseOut } from './ytdlp.js';
import { chatJSON } from '../ai/llm.js';

/** Directos a los que se pidió "✂ Clip ahora": el segmento en curso se corta ya para no esperar a que termine. */
export const liveCuts = new Set();
const OVERLAP = 60; // segundos del segmento anterior que se reanalizan (momentos que cruzan el corte)

/** Actualiza un campo de project.data de forma atómica (grabar y analizar corren a la vez). */
export async function setLive(id, patch) {
  await q(`UPDATE projects SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{live}', COALESCE(data->'live', '{}'::jsonb) || $2::jsonb, true) WHERE id = $1`,
    [id, JSON.stringify(patch)]);
}

/** Convierte el enlace del directo en una URL de vídeo (HLS) que ffmpeg pueda grabar. */
export async function resolveStream(url) {
  if (/\.m3u8(\?|$)/i.test(url) || /^(rtmps?|srt|rtsp):\/\//i.test(url)) return url;
  if (IS_VERCEL) throw new Error('En Vercel solo se pueden grabar enlaces directos .m3u8 (YouTube/Twitch bloquean los servidores en la nube). Para usar enlaces de YouTube, Twitch o Kick, instala la app en tu PC. (400)');
  // Se pide la información completa y se usa la lista HLS maestra del directo (con todas las calidades y el audio):
  // así no depende de que exista un formato concreto (YouTube a veces solo ofrece vídeo y audio por separado).
  let j = null, lastErr = null;
  for (let i = 0; i < 3 && !j; i++) {
    try { j = parseOut((await ytdlp(['-J', url], { stallMs: 90000, timeoutMs: 150000, fullOutput: true })).out); }
    catch (e) { lastErr = e; if (i < 2) await new Promise(r => setTimeout(r, 8000)); }
  }
  if (j) {
    if (j.live_status === 'is_upcoming') throw new Error('El directo aún no ha empezado. Inténtalo cuando esté emitiendo. (400)');
    if (j.live_status && j.live_status !== 'is_live') throw new Error('Ese directo ya terminó. Para sacar clips de la grabación usa "Convertir a Clips" con el enlace. (400)');
    const hls = f => /m3u8/.test(f.protocol || '') || /\.m3u8/.test(f.url || '');
    if (j.manifest_url && /m3u8/.test(j.manifest_url)) return j.manifest_url;
    const all = (j.formats || []).filter(f => f.url && hls(f));
    const fmts = all.filter(f => f.vcodec !== 'none');
    const best = fmts.filter(f => !f.height || f.height <= 1080).sort((a, b) => (b.height || 0) - (a.height || 0) || (b.tbr || 0) - (a.tbr || 0))[0] || fmts[0];
    if (best) {
      // YouTube ofrece ahora la imagen y el sonido por separado: si el vídeo elegido no lleva audio, se graba también
      // la mejor pista de solo audio (sin ella el directo se grababa mudo y no se podía transcribir)
      if (best.acodec === 'none') {
        const aud = all.filter(f => f.vcodec === 'none').sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))[0];
        if (aud) return { video: best.url, audio: aud.url };
      }
      return best.url;
    }
    if (j.url) return j.url;
  }
  // Último recurso: que yt-dlp elija cualquier formato del directo
  const { out } = await ytdlp(['-g', '-f', 'best[protocol*=m3u8]/best/bv*+ba', url], { stallMs: 90000, timeoutMs: 120000 })
    .catch(e => { throw new Error('No se pudo abrir el directo (¿está emitiendo ahora mismo?): ' + (lastErr || e).message.slice(-300)); });
  const u = out.trim().split('\n').filter(Boolean)[0];
  if (!u) throw new Error('No se encontró la emisión en directo de ese enlace.');
  return u;
}

async function liveStatus(id) {
  const r = await one(`SELECT COUNT(*)::int AS segs, COALESCE(SUM(dur), 0)::float AS secs FROM live_segments WHERE project_id = $1`, [id]);
  const c = await one(`SELECT COUNT(*)::int AS n FROM clips WHERE project_id = $1`, [id]);
  return { ...r, clips: c.n };
}
const fmtMin = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// ---------- Grabar un segmento ----------
register('live.capture', async ({ id, seg }, ctx) => {
  const p = await getProject(id);
  if (!p || p.deleted_at) return;
  const o = p.data.options || {};
  const live = p.data.live || {};
  if (live.stopRequested || live.ended) return finish(id, 'detenido');
  const maxSec = (Number(o.maxMinutes) || 120) * 60;
  const st = await liveStatus(id);
  if (st.secs >= maxSec) return finish(id, 'duración máxima alcanzada');

  // Duración del segmento: lo configurado, sin pasarse del tiempo que queda en esta ejecución
  // El primer segmento es corto (máx. 60 s) para que los primeros clips lleguen antes
  const manual = o.clipMode === 'manual' || o.clipMode === 'smart';
  // Modo "Hacer clips" a mano: se graba en trozos internos de 5 min (se transcriben mientras tanto) y los clips
  // se buscan solo cuando el usuario pulsa el botón. Modo automático: el primer segmento es corto para ver clips antes.
  const want = manual ? (o.clipMode === 'smart' ? Math.min(300, Number(process.env.LIVE_BATCH_EVERY_SEC) || Math.max(5, Number(o.batchEvery) || 10) * 60) : 300) : seg === 0 ? Math.min(60, Math.max(30, Number(o.segmentSec) || 120)) : Math.max(30, Number(o.segmentSec) || 120);
  const segSec = Math.floor(Math.min(want, maxSec - st.secs, (ctx.remaining() - 45000) / 1000));
  if (segSec < 20) { await enqueue('live.capture', { id, seg }); return; } // sin tiempo: a una ejecución nueva

  await updateProject(id, { status: 'processing', error: null, progress: `🔴 Grabando el directo · ${fmtMin(st.secs)} grabados · ${st.clips} clips` });
  const src = await resolveStream(p.source_url);
  const url = typeof src === 'string' ? src : src.video;
  await setLive(id, { recWall: Date.now(), recPos: st.secs }); // para "✂ Clip ahora": posición del directo en cada momento
  const out = path.join(WORK_DIR, `live_${id}_${seg}_${Date.now()}.mp4`);
  const tmp = [];
  let rec = null, wasCut = false;
  try {
    if (/\.m3u8(\?|$)/i.test(url) || /mpegurl/i.test(url)) {
      // HLS: grabador propio en Node (continúa donde terminó el segmento anterior, sin huecos)
      const pl = await resolvePlaylist(url);
      if (src.audio && !pl.audio) pl.audio = (await resolvePlaylist(src.audio)).video; // audio en una lista aparte (YouTube)
      const deadline = Date.now() + Math.min(segSec * 1000 + 60000, ctx.remaining() - 30000);
      const vfile = path.join(WORK_DIR, `live_${id}_${seg}_v.ts`), afile = path.join(WORK_DIR, `live_${id}_${seg}_a.ts`);
      tmp.push(vfile, afile);
      const tick = got => updateProject(id, { progress: `🔴 Grabando el directo · ${fmtMin(st.secs + got)} grabados · ${st.clips} clips` }).catch(() => {});
      let last = 0;
      const [v, a] = await Promise.all([
        recordMedia(pl.video, vfile, { seconds: segSec, fromSeq: live.vSeq ?? null, deadline, stop: () => liveCuts.has(id), onProgress: g => { if (g - last >= 15) { last = g; tick(g); } } }),
        pl.audio ? recordMedia(pl.audio, afile, { seconds: segSec, fromSeq: live.aSeq ?? null, deadline, stop: () => liveCuts.has(id) }) : null,
      ]);
      rec = v;
      wasCut = liveCuts.has(id);
      liveCuts.delete(id);
      await setLive(id, { vSeq: v.lastSeq, ...(a ? { aSeq: a.lastSeq } : {}), ...(v.gap ? { gaps: (live.gaps || 0) + 1 } : {}) });
      if (v.seconds > 0) await ffmpeg([...(a ? await syncInputs(vfile, afile) : ['-i', vfile, '-map', '0:v:0', '-map', '0:a:0?']),
        '-c', 'copy', '-movflags', '+faststart', out], { timeoutMs: 120000 });
    } else {
      // RTMP / SRT / RTSP / enlaces de vídeo: ffmpeg lee el directo (copia sin recodificar)
      const reconnect = /^https?:/i.test(url) ? ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'] : [];
      await ffmpeg([...reconnect, '-i', url, '-t', String(segSec),
        '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', out], { timeoutMs: (segSec + 40) * 1000 })
        .catch(async e => { if (!fs.existsSync(out) || fs.statSync(out).size < 1e5) throw e; }); // si se cortó pero hay vídeo, se aprovecha
    }
    const info = await probe(out).catch(() => ({ duration: 0 }));
    if (info.duration < 5) {
      if (seg === 0) throw new Error('No se pudo grabar el directo. Comprueba que está emitiendo y que el enlace es correcto.');
      // Se pulsó "Hacer clips" / "Clip ahora" justo después de otro corte: el trozo es diminuto, no es el final del directo
      if (wasCut && !(await getProject(id)).data.live?.stopRequested) {
        const l2 = (await getProject(id)).data.live || {};
        if (manual && l2.batchAt) { await setLive(id, { batchAt: null }); await enqueue('live.analyze', { id, seg: seg - 1, batch: true }); }
        await enqueue('live.capture', { id, seg });
        return;
      }
      return finish(id, 'el directo terminó');
    }
    if (seg === 0) await q(`UPDATE projects SET data = data || $2::jsonb, duration = 0 WHERE id = $1`, [id, JSON.stringify({ width: info.width, height: info.height })]);
    const ref = await saveFile(out, `live_${id}_${seg}.mp4`);
    const start = st.secs;
    await q(`INSERT INTO live_segments (project_id, seg, ref, start, dur) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (project_id, seg) DO UPDATE SET ref = EXCLUDED.ref, start = EXCLUDED.start, dur = EXCLUDED.dur`, [id, seg, ref, start, info.duration]);
    await updateProject(id, { duration: start + info.duration });
    const endedNow = rec ? rec.ended : info.duration < segSec * 0.5; // (un corte por "Clip ahora" no cuenta como final) // se grabó mucho menos de lo pedido: el directo terminó
    const fresh = await getProject(id);
    const stop = endedNow || fresh.data.live?.stopRequested || start + info.duration >= maxSec;
    // Primero se encadena la grabación (para no dejar huecos) y después el análisis de este segmento
    if (!stop) await enqueue('live.capture', { id, seg: seg + 1 });
    else await setLive(id, { stopping: true, reason: endedNow ? 'el directo terminó' : fresh.data.live?.stopRequested ? 'detenido' : 'duración máxima alcanzada' });
    // Modo manual: la tanda se cierra si se pulsó "Hacer clips" (o si el directo termina).
    // Modo "smart": además, sola cuando el tramo llega a los minutos elegidos.
    const every = Number(process.env.LIVE_BATCH_EVERY_SEC) || Math.max(5, Math.min(60, Number(o.batchEvery) || 10)) * 60; // (variable: solo para pruebas)
    const due = o.clipMode === 'smart' && start + info.duration - (Number(fresh.data.live?.batchFromT) || 0) >= every - 20;
    const batch = manual && (stop || due || !!fresh.data.live?.batchAt);
    if (batch && fresh.data.live?.batchAt) await setLive(id, { batchAt: null });
    await enqueue('live.analyze', { id, seg, last: stop, ...(batch ? { batch: true } : {}) });
  } finally { for (const f of [out, ...tmp]) fs.rmSync(f, { force: true }); }
}, async ({ id }, msg) => {
  await setLive(id, { ended: true });
  await updateProject(id, { status: 'error', error: 'Grabación del directo: ' + msg, progress: null });
});

// Instante en que empieza un archivo grabado (tiempo del directo, igual en las listas de vídeo y de audio)
async function startTime(file) {
  const { err } = await run(FFMPEG, ['-hide_banner', '-i', file], { allowFail: true, timeoutMs: 30000 });
  const m = /start: (-?[\d.]+)/.exec(err);
  return m ? Number(m[1]) : null;
}
/**
 * Vídeo y audio de un directo se graban por separado y cada uno empieza donde iba su lista (pueden diferir varios
 * segundos). Se alinean por su tiempo real: si el audio empezó antes se recorta su principio; si empezó después se
 * retrasa. Así la voz coincide con la imagen y con los subtítulos.
 */
export async function syncInputs(vfile, afile) {
  const [vs, as] = await Promise.all([startTime(vfile), startTime(afile)]);
  const d = vs != null && as != null ? as - vs : 0;
  const ok = Math.abs(d) > 0.02 && Math.abs(d) < 600;
  if (ok) console.log(`[directo] audio ${d > 0 ? 'retrasado' : 'adelantado'} ${Math.abs(d).toFixed(2)} s respecto al vídeo: se alinea`);
  return ['-i', vfile, ...(ok && d < 0 ? ['-ss', (-d).toFixed(3)] : []), ...(ok && d > 0 ? ['-itsoffset', d.toFixed(3)] : []), '-i', afile, '-map', '0:v:0', '-map', '1:a:0'];
}

// "✂ Clip ahora": momentos marcados a mano durante el directo (los últimos N segundos), sin pasar el filtro de nota
async function manualClips(id, row, prev, winStart, transcript, o, last) {
  const segEnd = row.start + row.dur;
  const pending = ((await getProject(id)).data.live?.marks || []).filter(m => !m.done && m.t >= winStart && (m.t <= segEnd + 3 || last));
  if (!pending.length) return;
  for (const m of pending) {
    let { start, end } = snap(transcript.words, Math.max(winStart, m.t - m.len), Math.min(segEnd, m.t + 2));
    start = Math.max(winStart, start); end = Math.min(segEnd, end);
    if (end - start >= 5) {
      const said = sliceWords(transcript.words, start, end).map(w => w.word).join(' ');
      let meta = {};
      try {
        meta = await chatJSON('Eres editor de vídeos cortos virales.', `Texto de un clip de un directo: """${said.slice(0, 3000)}"""
Escribe en ${o.titleLanguage || 'el idioma del texto'} JSON {"title":"título con gancho (máx 70 caracteres)","hook":"gancho de 3 a 7 palabras"}`, { maxTokens: 200 });
      } catch {}
      const parts = [];
      if (prev && start < row.start) parts.push({ ref: prev.ref, ss: start - prev.start, dur: row.start - start });
      parts.push({ ref: row.ref, ss: Math.max(0, start - row.start), dur: end - Math.max(start, row.start) });
      const idx = (await one('SELECT COALESCE(MAX(idx), 0)::int AS n FROM clips WHERE project_id = $1', [id])).n + 1;
      const clip = await one(`INSERT INTO clips (project_id, idx, start, "end", title, hook, score, reason, layout, status, style, keywords, emojis, signals, src)
        VALUES ($1,$2,$3,$4,$5,$6,10,$7,$8,'rendering',$9,'[]','[]','{}',$10) RETURNING id`,
        [id, idx, start, end, String(meta.title || 'Momento del directo').slice(0, 100), String(meta.hook || '').slice(0, 80), '✂ Marcado por ti durante el directo',
          o.layout || 'face', o.captionStyle || 'clasico', JSON.stringify(parts)]);
      await enqueue('clip.render', { clipId: clip.id, fast: true });
      console.log(`[directo ${id}] clip manual #${idx} ${start.toFixed(0)}–${end.toFixed(0)} s`);
    }
  }
  // marcar como hechas (releyendo por si se añadieron marcas mientras tanto)
  const done = new Set(pending.map(m => m.at));
  const marks = ((await getProject(id)).data.live?.marks || []).map(m => done.has(m.at) ? { ...m, done: true } : m);
  await setLive(id, { marks });
}

async function finish(id, reason) {
  await setLive(id, { ended: true, reason, endedAt: new Date().toISOString() });
  const st = await liveStatus(id);
  await updateProject(id, { progress: `Directo finalizado (${reason}) · ${fmtMin(st.secs)} grabados · ${st.clips} clips` });
  await checkDone(id);
  const p = await getProject(id);
  if (p.status === 'processing' && !st.clips) await updateProject(id, { status: 'ready', percent: 100, ready_at: new Date().toISOString(), progress: `Directo finalizado (${reason}) · no hubo momentos virales suficientes` });
}

// Transcribe un trozo grabado (si aún no lo está) con tiempos absolutos del directo
async function transcribeRow(id, row, o, stage = async () => {}) {
  if (row.analyzed && row.words) return row;
  await stage('transcribiendo…');
  const info = await probe(inputPath(row.ref)).catch(() => ({ hasAudio: true }));
  if (!info.hasAudio) {
    await setLive(id, { warning: 'La grabación del directo no tiene sonido, así que no se puede transcribir ni buscar momentos. Detén el directo y vuelve a empezarlo; si sigue pasando, avísanos.' });
    throw new Error('El segmento grabado no tiene audio. (400)');
  }
  const r = await transcribeChunk(inputPath(row.ref), { offset: 0, len: row.dur + 1, language: o.language });
  const shift = x => ({ ...x, start: x.start + row.start, end: x.end + row.start });
  const words = r.words.filter(w => w.start < row.dur).map(shift);
  const segments = r.segments.filter(s => s.start < row.dur).map(shift);
  const energy = (r.energy || []).map(e => ({ ...e, t: e.t + Math.round(row.start) }));
  await q('UPDATE live_segments SET words = $3, segments = $4, energy = $5, analyzed = true WHERE project_id = $1 AND seg = $2',
    [id, row.seg, JSON.stringify(words), JSON.stringify(segments), JSON.stringify(energy)]);
  Object.assign(row, { words, segments, energy, analyzed: true });
  await setLive(id, { warning: null }); // se transcribió bien: se quita cualquier aviso anterior
  return row;
}

// Trozos de vídeo de un momento [start, end] que puede abarcar varios trozos grabados
function partsFor(rows, start, end) {
  return rows.filter(r => r.ref && r.start < end && r.start + r.dur > start).map(r => {
    const a = Math.max(start, r.start), b = Math.min(end, r.start + r.dur);
    return { ref: r.ref, ss: +(a - r.start).toFixed(3), dur: +(b - a).toFixed(3) };
  }).filter(x => x.dur > 0.05);
}

/**
 * Modo "Hacer clips": analiza todo lo grabado desde la última tanda hasta el trozo `seg` (incluido) y crea los clips.
 */
async function batchClips(id, seg, o, last) {
  const live = (await getProject(id)).data.live || {};
  const fromSeg = Number(live.batchFromSeg) || 0, n = (Number(live.batches) || 0) + 1;
  const stage = t => setLive(id, { stage: t ? `Tanda ${n}: ${t}` : null }).catch(() => {});
  const rows = await q('SELECT * FROM live_segments WHERE project_id = $1 AND seg >= $2 AND seg <= $3 ORDER BY seg', [id, fromSeg, seg]);
  if (!rows.length) return;
  for (const [i, r] of rows.entries()) await transcribeRow(id, r, o, t => stage(`${t} (${i + 1}/${rows.length})`));
  const winStart = rows[0].start, winEnd = rows[rows.length - 1].start + rows[rows.length - 1].dur;
  const transcript = { segments: rows.flatMap(r => r.segments || []), words: rows.flatMap(r => r.words || []), energy: rows.flatMap(r => r.energy || []) };
  let made = 0;
  if (transcript.segments.length) {
    await stage(`la IA busca los mejores momentos de ${fmtMin(winEnd - winStart)} grabados…`);
    const sig = buildSignals({ energy: transcript.energy, words: transcript.words, cuts: [] });
    const minSec = Number(o.minSec) || 15, maxSec = Number(o.maxSec) || 60;
    const picked = await pickClips(transcript, sig, { count: Math.min(10, Number(o.perSegment) || 3), minSec, maxSec, language: o.titleLanguage, strict: true });
    const existing = await q('SELECT start, "end" FROM clips WHERE project_id = $1', [id]);
    let idx = (await one('SELECT COALESCE(MAX(idx), 0)::int AS n FROM clips WHERE project_id = $1', [id])).n;
    const minScore = Number(o.minScore) || 7;
    for (const c of picked) {
      let { start, end } = snap(transcript.words, Number(c.start), Number(c.end));
      start = Math.max(winStart, start); end = Math.min(winEnd, end);
      if (!(end - start >= Math.min(minSec, 8))) continue;
      if (existing.some(x => Math.min(end, x.end) - Math.max(start, x.start) > 3)) continue;
      const llm = Math.max(1, Math.min(10, Number(c.score) || 5));
      const measured = sig.score(start, end);
      const final = sig.hasAudioData ? Math.round(llm * 0.75 + measured.score * 0.25) : Math.round(llm);
      if (final < minScore) continue;
      const parts = partsFor(rows, start, end);
      if (!parts.length) continue;
      const clipWords = new Set(sliceWords(transcript.words, start, end).map(w => normWord(w.word)));
      const keywords = (c.keywords || []).map(String).filter(k => clipWords.has(normWord(k))).slice(0, 6);
      const emojis = o.emojis === false ? [] : (c.emojis || []).filter(e => e?.emoji && clipWords.has(normWord(e.word))).slice(0, 4);
      const clip = await one(`INSERT INTO clips (project_id, idx, start, "end", title, hook, score, reason, layout, status, style, keywords, emojis, signals, src)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'rendering',$10,$11,$12,$13,$14) RETURNING id`,
        [id, ++idx, start, end, String(c.title || '').slice(0, 100), String(c.hook || '').slice(0, 80), final, c.reason || '',
          o.layout || 'face', o.captionStyle || 'clasico', JSON.stringify(keywords), JSON.stringify(emojis),
          JSON.stringify({ llm, measured: measured.score, scores: c.scores || {}, peaks: measured.peaks, rate: +measured.rate.toFixed(2), laugh: measured.laugh }),
          JSON.stringify(parts)]);
      existing.push({ start, end }); made++;
      await enqueue('clip.render', { clipId: clip.id, fast: true });
      console.log(`[directo ${id}] tanda ${n}: clip #${idx} (${final}/10) ${start.toFixed(0)}–${end.toFixed(0)} s: ${c.title}`);
    }
  }
  const hist = [...(live.batchLog || []), { n, from: winStart, to: winEnd, clips: made, at: Date.now() }].slice(-30);
  await setLive(id, { batchFromSeg: seg + 1, batchFromT: winEnd, batches: n, batchLog: hist, stage: null,
    ...(made || o.clipMode === 'smart' ? {} : { warning: `Tanda ${n}: no hubo momentos con nota ${Number(o.minScore) || 7}/10 o más en esos ${fmtMin(winEnd - winStart)}. Puedes bajar la nota mínima.` }) });
}

// ---------- Analizar un segmento y cortar los momentos virales ----------
register('live.analyze', async ({ id, seg, last, batch }, ctx) => {
  const p = await getProject(id);
  if (!p || p.deleted_at) return;
  const o = p.data.options || {};
  const row = await one('SELECT * FROM live_segments WHERE project_id = $1 AND seg = $2', [id, seg]);
  if (!row) return;

  // 1) Transcribir el segmento (tiempos absolutos del directo)
  const manual = o.clipMode === 'manual' || o.clipMode === 'smart';
  const stage = t => setLive(id, { stage: t ? (manual ? `Trozo ${seg + 1}: ${t}` : `Segmento ${seg + 1}: ${t}`) : null }).catch(() => {});
  // Se transcribe cada trozo en cuanto se graba (así, al pulsar «✂ Hacer clips», los clips salen enseguida)
  await transcribeRow(id, row, o, stage);

  // 2) Ventana: final del segmento anterior + este (para no perder momentos que cruzan el corte)
  const prev = seg > 0 ? await one('SELECT * FROM live_segments WHERE project_id = $1 AND seg = $2 AND analyzed', [id, seg - 1]) : null;
  const winStart = prev ? Math.max(prev.start, row.start - OVERLAP) : row.start;
  const inWin = x => x.start >= winStart;
  const transcript = {
    segments: [...(prev?.segments || []).filter(inWin), ...(row.segments || [])],
    words: [...(prev?.words || []).filter(inWin), ...(row.words || [])],
    energy: [...(prev?.energy || []).filter(e => e.t >= winStart), ...(row.energy || [])],
  };
  // 3) Primero los clips marcados a mano (✂ Clip ahora): salen sin esperar a la IA
  await manualClips(id, row, prev, winStart, transcript, o, last);
  if (manual) {
    if (batch) await batchClips(id, seg, o, last);
  } else if (transcript.segments.length) {
    await stage('la IA busca los mejores momentos…');
    const sig = buildSignals({ energy: transcript.energy, words: transcript.words, cuts: [] });
    const minSec = Number(o.minSec) || 15, maxSec = Number(o.maxSec) || 60;
    const picked = await pickClips(transcript, sig, { count: Number(o.perSegment) || 3, minSec, maxSec, language: o.titleLanguage });
    const existing = await q('SELECT start, "end" FROM clips WHERE project_id = $1', [id]);
    let idx = (await one('SELECT COALESCE(MAX(idx), 0)::int AS n FROM clips WHERE project_id = $1', [id])).n;
    const minScore = Number(o.minScore) || 7;
    for (const c of picked) {
      let { start, end } = snap(transcript.words, Number(c.start), Number(c.end));
      start = Math.max(winStart, start); end = Math.min(row.start + row.dur, end);
      if (!(end - start >= Math.min(minSec, 8))) continue;
      // solo momentos que tocan este segmento y que no repiten un clip ya hecho
      if (end <= row.start || existing.some(x => Math.min(end, x.end) - Math.max(start, x.start) > 3)) continue;
      const llm = Math.max(1, Math.min(10, Number(c.score) || 5));
      const measured = sig.score(start, end);
      const final = sig.hasAudioData ? Math.round(llm * 0.75 + measured.score * 0.25) : Math.round(llm);
      if (final < minScore) continue; // solo cortes con potencial viral alto
      // trozos de vídeo: parte del segmento anterior (si el momento empieza allí) + parte de este
      const parts = [];
      if (prev && start < row.start) parts.push({ ref: prev.ref, ss: start - prev.start, dur: row.start - start });
      parts.push({ ref: row.ref, ss: Math.max(0, start - row.start), dur: end - Math.max(start, row.start) });
      const clipWords = new Set(sliceWords(transcript.words, start, end).map(w => normWord(w.word)));
      const keywords = (c.keywords || []).map(String).filter(k => clipWords.has(normWord(k))).slice(0, 6);
      const emojis = o.emojis === false ? [] : (c.emojis || []).filter(e => e?.emoji && clipWords.has(normWord(e.word))).slice(0, 4);
      const clip = await one(`INSERT INTO clips (project_id, idx, start, "end", title, hook, score, reason, layout, status, style, keywords, emojis, signals, src)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'rendering',$10,$11,$12,$13,$14) RETURNING id`,
        [id, ++idx, start, end, String(c.title || '').slice(0, 100), String(c.hook || '').slice(0, 80), final, c.reason || '',
          o.layout || 'face', o.captionStyle || 'clasico', JSON.stringify(keywords), JSON.stringify(emojis),
          JSON.stringify({ llm, measured: measured.score, scores: c.scores || {}, peaks: measured.peaks, rate: +measured.rate.toFixed(2), laugh: measured.laugh }),
          JSON.stringify(parts)]);
      existing.push({ start, end });
      await enqueue('clip.render', { clipId: clip.id });
      console.log(`[directo ${id}] clip #${idx} (${final}/10) ${start.toFixed(0)}–${end.toFixed(0)} s: ${c.title}`);
    }
  }
  await stage(null);
  if (last) await finish(id, (await getProject(id)).data.live?.reason || 'terminado');
  else {
    const st = await liveStatus(id);
    const pr = await getProject(id);
    if (!pr.data.live?.ended) await updateProject(id, { progress: `🔴 Grabando el directo · ${fmtMin(st.secs)} grabados · ${st.clips} clips` });
  }
}, async ({ id, seg, last }, msg) => {
  console.warn(`[directo ${id}] análisis fallido: ${msg}`);
  await setLive(id, { stage: null, warning: `No se pudo analizar el segmento ${seg + 1}: ${String(msg).replace(/\s*\(\d{3}\)$/, '').slice(0, 300)}` }).catch(() => {});
  if (last) await finish(id, 'terminado');
});
