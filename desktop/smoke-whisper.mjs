// Prueba de la transcripción local (whisper.cpp) con la muestra de whisper.cpp (JFK, inglés).
// Uso: WHISPER_CLI=… node desktop/smoke-whisper.mjs ruta/a/jfk.wav
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clippers-wsmoke-'));
const { transcribeLocal, whisperBinary } = await import('../server/ai/localwhisper.js');
console.log('whisper-cli:', whisperBinary());
const t = Date.now();
const r = await transcribeLocal(process.argv[2], { model: process.env.WHISPER_TEST_MODEL || 'base', language: 'english',
  onProgress: ({ stage, pct }) => process.stdout.write(`\r${stage} ${pct || ''}   `) });
console.log(`\nidioma: ${r.language} · ${r.words.length} palabras · ${r.segments.length} frases · ${((Date.now() - t) / 1000).toFixed(1)} s`);
console.log(r.words.slice(0, 8).map(w => `${w.word}[${w.start.toFixed(2)}-${w.end.toFixed(2)}]`).join(' '));
console.log(r.segments.map(s => s.text).join(' | '));
const text = r.words.map(w => w.word.toLowerCase()).join(' ');
if (!/country/.test(text) || r.words.length < 15 || !(r.words.every((w, i) => !i || w.start >= r.words[i - 1].start))) { console.error('FALLO: transcripción inesperada'); process.exit(1); }
console.log('OK');
