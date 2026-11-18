// Prueba de la transcripción local (whisper.cpp) con la muestra de whisper.cpp (JFK, inglés) y medición de velocidad:
// se repite la muestra hasta ~1 min y se compara el modo rápido (búsqueda simple + flash attention) con el anterior.
// Uso: WHISPER_CLI=… node desktop/smoke-whisper.mjs ruta/a/jfk.wav
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clippers-wsmoke-'));
const { transcribeLocal, whisperBinary, ensureModel } = await import('../server/ai/localwhisper.js');
const { ffmpeg } = await import('../server/video/ffmpeg.js');
const model = process.env.WHISPER_TEST_MODEL || 'base';
console.log('whisper-cli:', whisperBinary());
await ensureModel(model); // la descarga no cuenta en la medición
const long = path.join(process.env.DATA_DIR, 'largo.wav');
await ffmpeg(['-stream_loop', '5', '-i', process.argv[2], '-ar', '16000', '-ac', '1', long]); // ~66 s
const run = async fast => { const t = Date.now(); const r = await transcribeLocal(long, { model, language: 'english', fast }); return { r, s: (Date.now() - t) / 1000 }; };
await run(true); // calentamiento (carga del modelo en caché del sistema)
const a = await run(false), b = await run(true);
console.log(`Antes (beam search 5): ${a.s.toFixed(1)} s · Ahora (rápido): ${b.s.toFixed(1)} s · ${(a.s / b.s).toFixed(1)}× más rápido · audio de 66 s`);
const r = b.r;
console.log(r.segments.slice(0, 2).map(s => s.text).join(' | '));
const text = r.words.map(w => w.word.toLowerCase()).join(' ');
if ((text.match(/country/g) || []).length < 5 || !(r.words.every((w, i) => !i || w.start >= r.words[i - 1].start))) { console.error('FALLO: transcripción inesperada'); process.exit(1); }
console.log('OK');
