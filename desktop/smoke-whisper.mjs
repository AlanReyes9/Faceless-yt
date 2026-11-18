// Prueba de la transcripción local (whisper.cpp) con la muestra de whisper.cpp (JFK, inglés) y medición de velocidad
// de varias configuraciones con ~1 min de audio. Uso: WHISPER_CLI=… node desktop/smoke-whisper.mjs ruta/a/jfk.wav
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clippers-wsmoke-'));
const { transcribeLocal, whisperBinary, ensureModel } = await import('../server/ai/localwhisper.js');
const { ffmpeg } = await import('../server/video/ffmpeg.js');
console.log('whisper-cli:', whisperBinary(), '· núcleos lógicos:', os.cpus().length);
const long = path.join(process.env.DATA_DIR, 'largo.wav');
await ffmpeg(['-stream_loop', '5', '-i', process.argv[2], '-ar', '16000', '-ac', '1', long]); // ~66 s
const run = async (model, extraArgs = [], threads) => { const t = Date.now(); const r = await transcribeLocal(long, { model, language: 'english', extraArgs, threads }); return { r, s: (Date.now() - t) / 1000 }; };
const { WHISPER_FAST_ARGS } = await import('../server/ai/localwhisper.js');
await ensureModel('base'); await run('base'); // la descarga y la primera carga no cuentan
const a = await run('base', []), b = await run('base', WHISPER_FAST_ARGS);
console.log(`BENCH whisper por defecto: ${a.s.toFixed(1)} s · configuración de la app (${WHISPER_FAST_ARGS.join(' ')}): ${b.s.toFixed(1)} s · audio de 66 s`);
const last = b.r;
const text = last.words.map(w => w.word.toLowerCase()).join(' ');
if ((text.match(/country/g) || []).length < 5) { console.error('FALLO: transcripción inesperada'); process.exit(1); }
console.log('OK');
