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
// El modelo de prueba (0.5B) es muy pequeño: se comprueba que el motor funciona y devuelve JSON con la estructura pedida
if (!j || typeof j !== 'object' || !Array.isArray(j.titles)) { console.error('FALLO: la IA local no devolvió el JSON pedido'); process.exit(1); }
console.log('OK, JSON válido con', j.titles.length, 'títulos');
process.exit(0);
