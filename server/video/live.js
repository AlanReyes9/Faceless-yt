// Clips virales de un vídeo EN DIRECTO.
// El directo se graba por segmentos encadenados (cada uno es un paso corto, apto para Vercel) y,
// en paralelo, cada segmento se transcribe y la IA busca momentos virales para cortarlos al instante.
import fs from 'node:fs';
import path from 'node:path';
import { q, one, getProject, updateProject, WORK_DIR, IS_VERCEL } from '../db.js';
import { ffmpeg, probe, run } from './ffmpeg.js';
import { sliceWords, normWord } from './ass.js';
import { buildSignals } from './signals.js';
import { transcribeChunk } from '../ai/transcribe.js';
import { register, enqueue } from '../jobs.js';
import { saveFile, inputPath } from '../storage.js';
import { pickClips, snap, checkDone } from './shorts.js';
import { resolvePlaylist, recordMedia } from './hls.js';

const OVERLAP = 60; // segundos del segmento anterior que se reanalizan (momentos que cruzan el corte)

/** Actualiza un campo de project.data de forma atómica (grabar y analizar corren a la vez). */
export async function setLive(id, patch) {
  await q(`UPDATE projects SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{live}', COALESCE(data->'live', '{}'::jsonb) || $2::jsonb, true) WHERE id = $1`,
    [id, JSON.stringify(patch)]);
}

/** Convierte el enlace del directo en una URL de vídeo (HLS) que ffmpeg pueda grabar. */
async function resolveStream(url) {
  if (/\.m3u8(\?|$)/i.test(url) || /^(rtmps?|srt|rtsp):\/\//i.test(url)) return url;
  if (IS_VERCEL) throw new Error('En Vercel solo se pueden grabar enlaces directos .m3u8 (YouTube/Twitch bloquean los servidores en la nube). Para usar enlaces de YouTube, Twitch o Kick, instala la app en tu PC. (400)');
  const { out } = await run('yt-dlp', ['-g', '-f', 'best[height<=1080]/best', '--no-playlist', '--no-warnings', url], { timeoutMs: 60000 })
    .catch(e => { throw new Error('No se pudo abrir el directo (¿está emitiendo ahora mismo?): ' + e.message.slice(-300)); });
  const u = out.trim().split('\n').filter(Boolean).pop();
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
  const want = Math.max(30, Number(o.segmentSec) || 180);
  const segSec = Math.floor(Math.min(want, maxSec - st.secs, (ctx.remaining() - 45000) / 1000));
  if (segSec < 20) { await enqueue('live.capture', { id, seg }); return; } // sin tiempo: a una ejecución nueva

  await updateProject(id, { status: 'processing', error: null, progress: `🔴 Grabando el directo · ${fmtMin(st.secs)} grabados · ${st.clips} clips` });
  const url = await resolveStream(p.source_url);
  const out = path.join(WORK_DIR, `live_${id}_${seg}_${Date.now()}.mp4`);
  const tmp = [];
  let rec = null;
  try {
    if (/\.m3u8(\?|$)/i.test(url) || /mpegurl/i.test(url)) {
      // HLS: grabador propio en Node (continúa donde terminó el segmento anterior, sin huecos)
      const pl = await resolvePlaylist(url);
      const deadline = Date.now() + Math.min(segSec * 1000 + 60000, ctx.remaining() - 30000);
      const vfile = path.join(WORK_DIR, `live_${id}_${seg}_v.ts`), afile = path.join(WORK_DIR, `live_${id}_${seg}_a.ts`);
      tmp.push(vfile, afile);
      const tick = got => updateProject(id, { progress: `🔴 Grabando el directo · ${fmtMin(st.secs + got)} grabados · ${st.clips} clips` }).catch(() => {});
      let last = 0;
      const [v, a] = await Promise.all([
        recordMedia(pl.video, vfile, { seconds: segSec, fromSeq: live.vSeq ?? null, deadline, onProgress: g => { if (g - last >= 15) { last = g; tick(g); } } }),
        pl.audio ? recordMedia(pl.audio, afile, { seconds: segSec, fromSeq: live.aSeq ?? null, deadline }) : null,
      ]);
      rec = v;
      await setLive(id, { vSeq: v.lastSeq, ...(a ? { aSeq: a.lastSeq } : {}), ...(v.gap ? { gaps: (live.gaps || 0) + 1 } : {}) });
      if (v.seconds > 0) await ffmpeg(['-i', vfile, ...(a ? ['-i', afile, '-map', '0:v:0', '-map', '1:a:0'] : ['-map', '0:v:0', '-map', '0:a:0?']),
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
      return finish(id, 'el directo terminó');
    }
    if (seg === 0) await q(`UPDATE projects SET data = data || $2::jsonb, duration = 0 WHERE id = $1`, [id, JSON.stringify({ width: info.width, height: info.height })]);
    const ref = await saveFile(out, `live_${id}_${seg}.mp4`);
    const start = st.secs;
    await q(`INSERT INTO live_segments (project_id, seg, ref, start, dur) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (project_id, seg) DO UPDATE SET ref = EXCLUDED.ref, start = EXCLUDED.start, dur = EXCLUDED.dur`, [id, seg, ref, start, info.duration]);
    await updateProject(id, { duration: start + info.duration });
    const endedNow = rec ? rec.ended : info.duration < segSec * 0.5; // se grabó mucho menos de lo pedido: el directo terminó
    const fresh = await getProject(id);
    const stop = endedNow || fresh.data.live?.stopRequested || start + info.duration >= maxSec;
    // Primero se encadena la grabación (para no dejar huecos) y después el análisis de este segmento
    if (!stop) await enqueue('live.capture', { id, seg: seg + 1 });
    else await setLive(id, { stopping: true, reason: endedNow ? 'el directo terminó' : fresh.data.live?.stopRequested ? 'detenido' : 'duración máxima alcanzada' });
    await enqueue('live.analyze', { id, seg, last: stop });
  } finally { for (const f of [out, ...tmp]) fs.rmSync(f, { force: true }); }
}, async ({ id }, msg) => {
  await setLive(id, { ended: true });
  await updateProject(id, { status: 'error', error: 'Grabación del directo: ' + msg, progress: null });
});

async function finish(id, reason) {
  await setLive(id, { ended: true, reason, endedAt: new Date().toISOString() });
  const st = await liveStatus(id);
  await updateProject(id, { progress: `Directo finalizado (${reason}) · ${fmtMin(st.secs)} grabados · ${st.clips} clips` });
  await checkDone(id);
  const p = await getProject(id);
  if (p.status === 'processing' && !st.clips) await updateProject(id, { status: 'ready', percent: 100, ready_at: new Date().toISOString(), progress: `Directo finalizado (${reason}) · no hubo momentos virales suficientes` });
}

// ---------- Analizar un segmento y cortar los momentos virales ----------
register('live.analyze', async ({ id, seg, last }, ctx) => {
  const p = await getProject(id);
  if (!p || p.deleted_at) return;
  const o = p.data.options || {};
  const row = await one('SELECT * FROM live_segments WHERE project_id = $1 AND seg = $2', [id, seg]);
  if (!row) return;

  // 1) Transcribir el segmento (tiempos absolutos del directo)
  if (!row.analyzed || !row.words) {
    const r = await transcribeChunk(inputPath(row.ref), { offset: 0, len: row.dur + 1, language: o.language });
    const shift = x => ({ ...x, start: x.start + row.start, end: x.end + row.start });
    const words = r.words.filter(w => w.start < row.dur).map(shift);
    const segments = r.segments.filter(s => s.start < row.dur).map(shift);
    const energy = (r.energy || []).map(e => ({ ...e, t: e.t + Math.round(row.start) }));
    await q('UPDATE live_segments SET words = $3, segments = $4, energy = $5, analyzed = true WHERE project_id = $1 AND seg = $2',
      [id, seg, JSON.stringify(words), JSON.stringify(segments), JSON.stringify(energy)]);
    Object.assign(row, { words, segments, energy });
  }

  // 2) Ventana: final del segmento anterior + este (para no perder momentos que cruzan el corte)
  const prev = seg > 0 ? await one('SELECT * FROM live_segments WHERE project_id = $1 AND seg = $2 AND analyzed', [id, seg - 1]) : null;
  const winStart = prev ? Math.max(prev.start, row.start - OVERLAP) : row.start;
  const inWin = x => x.start >= winStart;
  const transcript = {
    segments: [...(prev?.segments || []).filter(inWin), ...(row.segments || [])],
    words: [...(prev?.words || []).filter(inWin), ...(row.words || [])],
    energy: [...(prev?.energy || []).filter(e => e.t >= winStart), ...(row.energy || [])],
  };
  if (transcript.segments.length) {
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
  if (last) await finish(id, (await getProject(id)).data.live?.reason || 'terminado');
  else {
    const st = await liveStatus(id);
    const pr = await getProject(id);
    if (!pr.data.live?.ended) await updateProject(id, { progress: `🔴 Grabando el directo · ${fmtMin(st.secs)} grabados · ${st.clips} clips` });
  }
}, async ({ id, last }, msg) => {
  console.warn(`[directo ${id}] análisis fallido: ${msg}`);
  if (last) await finish(id, 'terminado');
});
