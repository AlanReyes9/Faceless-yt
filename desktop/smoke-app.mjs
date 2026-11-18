// Prueba de la app en Windows y Mac (GitHub Actions): subidas desde el equipo (rutas con espacios y acentos),
// miniaturas con todos los efectos y grabación de un directo HLS. Sale con código 1 si algo falla.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clippers-app-'));
globalThis.__desktop = { licensed: () => true, license: () => ({}) }; // como en la app de escritorio
const { app } = await import('../server/app.js');
const { startLocalWorker } = await import('../server/jobs.js');
const { ffmpeg, FFMPEG } = await import('../server/video/ffmpeg.js');
startLocalWorker();
const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const B = `http://127.0.0.1:${server.address().port}`;
let bad = 0;
const ok = (name, cond, extra = '') => { console.log(`${cond ? 'OK   ' : 'FALLO'} ${name}${extra ? ' — ' + extra : ''}`); if (!cond) bad++; };
const api = async (u, opt = {}) => {
  const r = await fetch(B + u, { method: opt.method || 'GET', headers: opt.body ? { 'content-type': 'application/json' } : {}, body: opt.body ? JSON.stringify(opt.body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${u} ${r.status}: ${j.error || ''}`);
  return j;
};
const step = async (name, fn) => { try { await fn(); } catch (e) { ok(name, false, e.message); } };
const wait = async (fn, ms = 120000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('tiempo agotado'); await new Promise(r => setTimeout(r, 1000)); } };
const status = async u => (await fetch(B + u)).status;

// Vídeo de prueba en una carpeta con espacios y acentos (como "carrera testimonios .mov" en el Escritorio)
const dir = path.join(process.env.DATA_DIR, 'Vídeos de prueba ñ');
fs.mkdirSync(dir, { recursive: true });
const vid = path.join(dir, 'carrera testimonios .mov');
await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=12', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=12',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-f', 'mov', vid]);
const img = path.join(dir, 'fondo miniatura.png');
await ffmpeg(['-f', 'lavfi', '-i', 'gradients=s=1280x720:c0=0x1e3a8a:c1=0xdb2777', '-frames:v', '1', img]);

await step('Subida por HTTP (navegador)', async () => {
  const fd = new FormData(); fd.append('file', new Blob([fs.readFileSync(vid)], { type: 'video/quicktime' }), 'carrera testimonios .mov');
  const r = await (await fetch(B + '/api/upload', { method: 'POST', body: fd })).json();
  ok('Subida por HTTP (navegador)', !!r.ref && (await status(r.url)) === 200, r.ref || r.error);
});
let localRef;
await step('Copia directa desde el equipo', async () => {
  const { id } = await api('/api/upload-local', { method: 'POST', body: { path: vid } });
  const j = await wait(async () => { const x = await api('/api/upload-local/' + id); if (x.error) throw new Error(x.error); return x.done && x; });
  localRef = j.ref;
  ok('Copia directa desde el equipo (ruta con espacios y acentos)', !!j.ref && (await status(j.url)) === 200, j.ref);
});
await step('Clips desde el vídeo copiado', async () => {
  const p = await api('/api/shorts', { method: 'POST', body: { source: localRef, filename: 'carrera testimonios .mov', count: 2 } });
  // sin IA configurada la transcripción falla, pero el vídeo tiene que haberse leído bien (duración e imagen)
  const x = await wait(async () => { const y = await api('/api/projects/' + p.id); return (y.status === 'error' || y.duration > 0) && y; }, 60000);
  ok('El proyecto lee el vídeo subido', x.duration > 10 || !/imagen|leer|abrir|no such|invalid/i.test(x.error || ''), x.duration ? x.duration.toFixed(1) + ' s' : x.error);
});
await step('Miniaturas', async () => {
  const { id } = await api('/api/upload-local', { method: 'POST', body: { path: img } });
  const base = (await wait(async () => { const x = await api('/api/upload-local/' + id); return x.done && x; })).ref;
  const t = await api('/api/thumbs', { method: 'POST', body: { title: 'Gané 1000 euros', format: 'youtube' } });
  for (const [effect, emoji] of [['clasico', '😱'], ['neon', ''], ['caja', '🔥'], ['3d', '💰']]) {
    const it = await api(`/api/thumbs/${t.id}/generate`, { method: 'POST', body: { base, text: 'GANÉ 1000 EUROS', highlight: 'EUROS', position: 'left', effect, emoji } });
    ok(`Miniatura efecto ${effect}${emoji ? ' + emoji' : ''}`, (await status(it.url)) === 200);
  }
  for (const format of ['short', 'square']) {
    const t2 = await api('/api/thumbs', { method: 'POST', body: { title: 'Prueba', format } });
    const it = await api(`/api/thumbs/${t2.id}/generate`, { method: 'POST', body: { base, text: 'HOLA MUNDO', highlight: 'MUNDO', position: 'top' } });
    ok(`Miniatura formato ${format}`, (await status(it.url)) === 200);
  }
});
await step('Directo', async () => {
  // Emisión HLS de prueba en vivo (ffmpeg) servida por un servidor local
  const hls = path.join(process.env.DATA_DIR, 'hls'); fs.mkdirSync(hls);
  const gen = spawn(FFMPEG, ['-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=330',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-c:a', 'aac', '-f', 'hls', '-hls_time', '2', '-hls_list_size', '15', path.join(hls, 'live.m3u8')], { stdio: 'ignore', env: { ...process.env, GCONV_PATH: '/nonexistent' } });
  const st = http.createServer((q, r) => fs.readFile(path.join(hls, q.url.split('?')[0]), (e, d) => { if (e) { r.statusCode = 404; return r.end(); } r.end(d); })).listen(0);
  await new Promise(r => setTimeout(r, 7000));
  try {
    const p = await api('/api/live', { method: 'POST', body: { url: `http://127.0.0.1:${st.address().port}/live.m3u8`, title: 'directo', segmentSec: 60 } });
    await new Promise(r => setTimeout(r, 12000));
    await api(`/api/projects/${p.id}/mark`, { method: 'POST', body: { len: 10 } }); // ✂ Clip ahora: corta el segmento
    const x = await wait(async () => { const y = await api('/api/projects/' + p.id); return (y.live?.segs >= 1 || y.status === 'error') && y; }, 90000);
    ok('Directo: graba un segmento y lo corta con "Clip ahora"', x.live?.segs >= 1, x.error || `${x.live?.segs} segmento(s), ${Math.round(x.live?.secs || 0)} s`);
    await api(`/api/projects/${p.id}/stop`, { method: 'POST' });
  } finally { gen.kill(); st.close(); }
});

console.log(bad ? `\n${bad} prueba(s) fallaron` : '\nTodo correcto');
process.exit(bad ? 1 : 0);
