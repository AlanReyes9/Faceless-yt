import { getSetting, requireKey } from '../settings.js';

export function apiError(text) {
  try { const j = JSON.parse(text); return j.error?.message || j.error?.type || j.message || text.slice(0, 300); } catch { return text.slice(0, 300); }
}

async function post(url, headers, body, { timeoutMs = 180000, retries = 3 } = {}) {
  // Reintenta los errores temporales del proveedor (saturación, límites de uso, fallos de red)
  for (let attempt = 1; ; attempt++) {
    let r, text;
    try {
      r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      text = await r.text();
    } catch (e) {
      if (e.name === 'TimeoutError') throw new Error(`La IA tardó demasiado en responder (más de ${Math.round(timeoutMs / 1000)} s).`);
      if (attempt > retries) throw new Error('No se pudo conectar con la API de IA: ' + e.message);
      await new Promise(res => setTimeout(res, 1500 * attempt));
      continue;
    }
    if (r.ok) return JSON.parse(text);
    if ([429, 500, 502, 503, 504, 529].includes(r.status) && attempt <= retries) {
      const wait = Number(r.headers.get('retry-after')) * 1000 || 2000 * attempt * attempt;
      await new Promise(res => setTimeout(res, Math.min(wait, 10000)));
      continue;
    }
    throw new Error(`Error de la API (${r.status}): ${apiError(text)}`);
  }
}

const KEY_OF = { openai: 'openai_key', anthropic: 'anthropic_key', gemini: 'gemini_key', groq: 'groq_key', openrouter: 'openrouter_key' };
const PER_CALL_MS = Number(process.env.LLM_TIMEOUT_MS || 100000);       // máximo por llamada a un proveedor
const GEMINI_PER_MODEL_MS = Number(process.env.GEMINI_TIMEOUT_MS || 60000); // máximo por modelo de Gemini
const TOTAL_BUDGET_MS = Number(process.env.LLM_BUDGET_MS || 230000);    // todo el reparto cabe en un paso del servidor
const GEMINI_BASE = () => process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';

// Errores por los que vale la pena probar otro modelo/proveedor (saturación, lentitud, red)
export const isTemporal = msg => /tardó demasiado|\((429|500|502|503|504|529)\)|No se pudo conectar|overloaded|high demand|UNAVAILABLE|RESOURCE_EXHAUSTED|try again later/i.test(msg);
// Para Gemini también se cambia de modelo si está retirado o no existe
const geminiSwitchable = msg => isTemporal(msg) || /\((404)\)|no longer available|not found|is not supported/i.test(msg);

/**
 * Llama al proveedor de texto configurado. Si falla por saturación o tarda demasiado,
 * prueba automáticamente con los demás proveedores de los que haya clave.
 */
export async function chat(system, user, { json = false, maxTokens = 4000, provider } = {}) {
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const preferred = provider || await getSetting('llm_provider');
  const order = [preferred];
  if (!provider) for (const p of ['openai', 'groq', 'anthropic', 'gemini', 'openrouter']) if (p !== preferred && await getSetting(KEY_OF[p])) order.push(p);
  let lastErr;
  for (const p of order) {
    if (deadline - Date.now() < 8000) break; // sin tiempo para otro intento útil
    try {
      const out = await chatWith(p, system, user, { json, maxTokens, deadline });
      if (p !== preferred) console.log(`[IA] respondió ${p} (respaldo de ${preferred})`);
      return out;
    } catch (e) {
      lastErr = e;
      // Solo se cambia de proveedor ante errores temporales, no por claves mal puestas
      if (!isTemporal(e.message) || provider) throw e;
      console.warn(`[IA] ${p} falló (${e.message.slice(0, 120)}); probando otro proveedor…`);
    }
  }
  throw lastErr || new Error('La IA tardó demasiado en responder.');
}

// ---------- Gemini: cadena de modelos de respaldo ----------
let geminiModelsCache = { at: 0, list: [] };
let geminiSticky = { model: null, until: 0 }; // último modelo que funcionó cuando el preferido falló

/** Modelos de texto de Gemini disponibles con esta clave (se consulta a Google y se guarda 6 h). */
async function geminiModels(key) {
  if (Date.now() - geminiModelsCache.at < 6 * 3600e3 && geminiModelsCache.list.length) return geminiModelsCache.list;
  try {
    const out = [];
    let pageToken = '';
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${GEMINI_BASE()}/models?pageSize=200${pageToken ? '&pageToken=' + pageToken : ''}`, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(10000) });
      if (!r.ok) break;
      const j = await r.json();
      out.push(...(j.models || []));
      if (!(pageToken = j.nextPageToken)) break;
    }
    const list = out
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => String(m.name).replace(/^models\//, ''))
      // solo modelos estables de texto: fuera experimentales, de imagen, voz, embeddings, etc.
      .filter(n => /^gemini-\d+(\.\d+)?-(flash|pro)(-lite)?(-\d{3})?$/.test(n));
    const ver = n => parseFloat(n.match(/^gemini-(\d+(?:\.\d+)?)/)[1]);
    const tier = n => /-flash-lite/.test(n) ? 1 : /-flash/.test(n) ? 0 : 2; // flash primero (rápido), luego lite, luego pro
    list.sort((a, b) => ver(b) - ver(a) || tier(a) - tier(b) || a.length - b.length);
    geminiModelsCache = { at: Date.now(), list };
    return list;
  } catch { return geminiModelsCache.list; }
}

async function geminiChain(key) {
  const preferred = await getSetting('gemini_model');
  const custom = String(await getSetting('gemini_fallbacks') || '').split(',').map(x => x.trim().replace(/^models\//, '')).filter(Boolean);
  const auto = custom.length ? [] : await geminiModels(key);
  const chain = [preferred, ...custom, ...auto];
  // si hace poco otro modelo respondió en lugar del preferido, se prueba primero ese
  if (geminiSticky.model && Date.now() < geminiSticky.until) chain.unshift(geminiSticky.model);
  return [...new Set(chain)].slice(0, 5);
}

async function geminiCall(model, key, sys, user, { json, maxTokens, timeoutMs }) {
  const url = `${GEMINI_BASE()}/models/${encodeURIComponent(model)}:generateContent`;
  const headers = { 'x-goog-api-key': key };
  const body = thinking => ({
    systemInstruction: { parts: [{ text: sys }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {
      // el razonamiento interno también gasta tokens de salida: se da margen y se pide pensar poco (más rápido)
      maxOutputTokens: maxTokens + 4000,
      ...(json ? { responseMimeType: 'application/json' } : {}),
      ...(thinking ? { thinkingConfig: { thinkingLevel: 'low' } } : {}),
    },
  });
  const opts = { timeoutMs, retries: 0 }; // ante saturación se salta directamente al siguiente modelo
  let res;
  try { res = await post(url, headers, body(true), opts); }
  catch (e) {
    if (!/\(400\)/.test(e.message) || !/think/i.test(e.message)) throw e;
    res = await post(url, headers, body(false), opts); // este modelo no admite ese parámetro
  }
  const text = res.candidates?.[0]?.content?.parts?.filter(p => !p.thought).map(p => p.text || '').join('') || '';
  if (!text) throw new Error(`Gemini no devolvió texto (${res.candidates?.[0]?.finishReason || res.promptFeedback?.blockReason || 'sin motivo'}).`);
  return text;
}

async function chatGemini(sys, user, { json, maxTokens, deadline }) {
  const key = await requireKey('gemini_key', 'usar Gemini');
  const chain = await geminiChain(key);
  const preferred = await getSetting('gemini_model');
  let lastErr;
  for (const model of chain) {
    const left = deadline - Date.now();
    if (left < 8000) break;
    try {
      const out = await geminiCall(model, key, sys, user, { json, maxTokens, timeoutMs: Math.min(GEMINI_PER_MODEL_MS, left - 3000) });
      if (model !== preferred) {
        console.log(`[IA] Gemini: respondió ${model} (respaldo de ${preferred})`);
        geminiSticky = { model, until: Date.now() + 30 * 60e3 };
      } else geminiSticky = { model: null, until: 0 };
      return out;
    } catch (e) {
      lastErr = e;
      if (!geminiSwitchable(e.message)) throw e; // clave mal puesta, petición inválida…: no tiene sentido cambiar de modelo
      if (geminiSticky.model === model) geminiSticky = { model: null, until: 0 };
      console.warn(`[IA] Gemini ${model} falló (${e.message.slice(0, 100)}); probando otro modelo…`);
    }
  }
  // Se agotaron los modelos de Gemini: se marca como temporal para que entre el respaldo de otros proveedores
  const err = new Error(`Todos los modelos de Gemini probados fallaron (${chain.join(', ')}): ${lastErr?.message || 'sin tiempo'}`.slice(0, 400));
  err.message += /tardó demasiado|\(\d{3}\)/.test(err.message) ? '' : ' (503)';
  throw err;
}

async function chatWith(provider, system, user, { json, maxTokens, deadline = Date.now() + TOTAL_BUDGET_MS }) {
  const sys = json ? system + '\n\nResponde ÚNICAMENTE con JSON válido, sin texto adicional ni bloques de código.' : system;
  const opts = { timeoutMs: Math.max(5000, Math.min(PER_CALL_MS, deadline - Date.now() - 3000)), retries: 2 };

  if (provider === 'gemini') return chatGemini(sys, user, { json, maxTokens, deadline });

  if (provider === 'anthropic') {
    const res = await post('https://api.anthropic.com/v1/messages', {
      'x-api-key': await requireKey('anthropic_key', 'usar Claude'), 'anthropic-version': '2023-06-01',
    }, { model: await getSetting('anthropic_model'), max_tokens: maxTokens, system: sys, messages: [{ role: 'user', content: user }] }, opts);
    return res.content.filter(b => b.type === 'text').map(b => b.text).join('');
  }

  // OpenAI, Groq y OpenRouter comparten el formato chat/completions
  const BASE = { openai: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'), groq: 'https://api.groq.com/openai/v1', openrouter: 'https://openrouter.ai/api/v1' };
  const p = BASE[provider] ? provider : 'openai';
  const res = await post(BASE[p] + '/chat/completions', {
    authorization: 'Bearer ' + await requireKey(KEY_OF[p], 'usar ' + p),
  }, {
    model: await getSetting(p + '_model'),
    max_completion_tokens: maxTokens,
    messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
    ...(json && p !== 'openrouter' ? { response_format: { type: 'json_object' } } : {}),
  }, opts);
  return res.choices?.[0]?.message?.content || '';
}

export function parseJSON(text) {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch {}
  const m = t.match(/[[{][\s\S]*[\]}]/);
  if (m) return JSON.parse(m[0]);
  throw new Error('La IA no devolvió JSON válido.');
}

export async function chatJSON(system, user, opts) {
  return parseJSON(await chat(system, user, { ...opts, json: true }));
}
