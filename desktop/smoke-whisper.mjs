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
let last;
for (const model of ['base', 'small']) {
  await ensureModel(model); // la descarga no cuenta
  await run(model); // calentamiento
  for (const [name, args, th] of [['por defecto (beam 5)', []], ['búsqueda simple', ['-bs', '1', '-bo', '1']], ['simple + flash', ['-bs', '1', '-bo', '1', '-fa']], ['beam 5 + flash', ['-fa']],
    ['por defecto, todos los núcleos', [], os.cpus().length]]) {
    const x = await run(model, args, th); last = x.r;
    console.log(`BENCH ${model.padEnd(5)} · ${name.padEnd(30)} ${x.s.toFixed(1)} s`);
  }
}
const text = last.words.map(w => w.word.toLowerCase()).join(' ');
if ((text.match(/country/g) || []).length < 5) { console.error('FALLO: transcripción inesperada'); process.exit(1); }
console.log('OK');
