// Prueba de la IA de texto local (llama.cpp) con un modelo pequeño: debe devolver JSON válido.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clippers-lsmoke-'));
process.env.LOCAL_LLM_MODEL ||= 'qwen2.5-0.5b';
process.env.LOCAL_LLM_CTX ||= '4096';
const { chatLocal, llamaBinary } = await import('../server/ai/localmodels.js');
const { parseJSON } = await import('../server/ai/llm.js');
console.log('llama-server:', llamaBinary());
const t = Date.now();
const out = await chatLocal('Eres un experto en YouTube. Respondes solo JSON.',
  'Vídeo: "Cómo ahorrar 1000 euros en un mes". Devuelve JSON {"titles":["3 títulos con gancho en español"],"hashtags":["3 hashtags"]}',
  { json: true, maxTokens: 300, onProgress: p => console.log(p.stage) });
console.log(`respuesta en ${((Date.now() - t) / 1000).toFixed(1)} s:`, out.slice(0, 400));
const j = parseJSON(out);
if (!Array.isArray(j.titles) || !j.titles.length) { console.error('FALLO: JSON sin títulos'); process.exit(1); }
console.log('OK', j.titles.length, 'títulos');
process.exit(0);
