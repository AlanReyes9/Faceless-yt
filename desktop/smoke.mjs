// Prueba rápida del render con el ffmpeg incluido (se ejecuta en GitHub Actions en Windows y Mac).
// Uso: node desktop/smoke.mjs   → sale con código 1 si algún Short falla, mostrando el error de ffmpeg.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clippers-smoke-'));
const { insert, q, one } = await import('../server/db.js');
await import('../server/app.js');
const { enqueue, drain } = await import('../server/jobs.js');
const { saveFile } = await import('../server/storage.js');
const { ffmpeg, FFMPEG, run } = await import('../server/video/ffmpeg.js');

console.log('ffmpeg:', FFMPEG);
console.log((await run(FFMPEG, ['-hide_banner', '-version'])).out.split('\n')[0]);

const src = path.join(process.env.DATA_DIR, 'test.mp4');
await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=30', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=30',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
const source = await saveFile(src, 'test.mp4');

const text = 'hoy te cuento el secreto del dinero que nadie sabe y la policía llegó corriendo sin mirar atrás'.split(' ');
const words = [];
for (let t = 0.2; t < 29.5; t += 0.45) words.push({ word: text[words.length % text.length], start: +t.toFixed(2), end: +(t + 0.4).toFixed(2) });
const segments = [];
for (let t = 0; t < 30; t += 5) segments.push({ start: t, end: t + 5, text: words.filter(w => w.start >= t && w.start < t + 5).map(w => w.word).join(' ') });

const p = await insert('projects', { type: 'shorts', title: 'smoke', source, status: 'processing', duration: 30,
  data: { options: { layout: 'face', captionStyle: 'impacto', emojis: true, captions: true }, width: 1280, height: 720, cuts: [],
    transcript: { language: 'es', words, segments, energy: [] } } });

const cases = [['face', 'impacto'], ['crop', 'clasico'], ['blur', 'marcador'], ['face', 'minimal']];
let idx = 0;
for (const [layout, style] of cases) {
  const c = await one(`INSERT INTO clips (project_id, idx, start, "end", title, hook, score, reason, layout, status, style, keywords, emojis, signals)
    VALUES ($1,$2,$3,$4,$5,$6,8,'',$7,'rendering',$8,$9,$10,'{}') RETURNING id`,
    [p.id, ++idx, 2 + idx, 14 + idx, 'Prueba ' + layout, 'Esto nadie lo sabe', layout, style,
      JSON.stringify(['dinero', 'policía']), JSON.stringify([{ word: 'dinero', emoji: '💰' }])]);
  await enqueue('clip.render', { clipId: c.id });
}
const t = Date.now();
await drain();
let bad = 0;
for (const c of await q('SELECT idx, layout, style, status, error, file FROM clips ORDER BY idx')) {
  console.log(`#${c.idx} ${c.layout}/${c.style}: ${c.status}${c.error ? '\n   ERROR: ' + c.error : ''}`);
  if (c.status !== 'ready') bad++;
}
// Ranking de 3 puestos con el mismo vídeo de prueba
const rk = await insert('projects', { type: 'ranking', title: 'smoke ranking', status: 'pending', data: { parts: [], options: {
  title: 'Ranking de *prueba*', bottom: '@canal', order: 'countdown', fit: 'auto', highlight: '#FFD400', maxClipSec: 3, keepAudio: true,
  items: [{ source, label: 'Primero', start: 1 }, { source, label: 'Segundo', start: 5 }, { source, label: 'Tercero', start: 9 }] } } });
await enqueue('ranking.prep', { id: rk.id, i: 0 });
await drain();
const rr = await one('SELECT status, error, duration FROM projects WHERE id = $1', [rk.id]);
console.log(`Ranking: ${rr.status} ${rr.duration ? rr.duration.toFixed(1) + ' s' : ''}${rr.error ? '\n   ERROR: ' + rr.error : ''}`);
if (rr.status !== 'ready') bad++;
console.log(`Tiempo total: ${((Date.now() - t) / 1000).toFixed(1)} s`);
process.exit(bad ? 1 : 0);
