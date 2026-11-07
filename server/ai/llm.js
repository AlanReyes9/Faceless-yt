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
const PER_CALL_MS = Number(process.env.LLM_TIMEOUT_MS || 100000);

/**
 * Llama al proveedor de texto configurado. Si falla por saturación o tarda demasiado,
 * prueba automáticamente con los demás proveedores de los que haya clave.
 */
export async function chat(system, user, { json = false, maxTokens = 4000, provider } = {}) {
  const preferred = provider || await getSetting('llm_provider');
  const order = [preferred];
  if (!provider) for (const p of ['openai', 'groq', 'anthropic', 'gemini', 'openrouter']) if (p !== preferred && await getSetting(KEY_OF[p])) order.push(p);
  let lastErr;
  for (const p of order) {
    try {
      const out = await chatWith(p, system, user, { json, maxTokens });
      if (p !== preferred) console.log(`[IA] respondió ${p} (respaldo de ${preferred})`);
      return out;
    } catch (e) {
      lastErr = e;
      // Solo se cambia de proveedor ante errores temporales (saturación, lentitud, red), no por claves mal puestas
      const temporal = /tardó demasiado|\((429|500|502|503|504|529)\)|No se pudo conectar|overloaded|high demand/i.test(e.message);
      if (!temporal || provider) throw e;
      console.warn(`[IA] ${p} falló (${e.message.slice(0, 120)}); probando otro proveedor…`);
    }
  }
  throw lastErr;
}

async function chatWith(provider, system, user, { json, maxTokens }) {
  const sys = json ? system + '\n\nResponde ÚNICAMENTE con JSON válido, sin texto adicional ni bloques de código.' : system;
  const opts = { timeoutMs: PER_CALL_MS, retries: 2 };

  if (provider === 'anthropic') {
    const res = await post('https://api.anthropic.com/v1/messages', {
      'x-api-key': await requireKey('anthropic_key', 'usar Claude'), 'anthropic-version': '2023-06-01',
    }, { model: await getSetting('anthropic_model'), max_tokens: maxTokens, system: sys, messages: [{ role: 'user', content: user }] }, opts);
    return res.content.filter(b => b.type === 'text').map(b => b.text).join('');
  }

  if (provider === 'gemini') {
    const model = await getSetting('gemini_model');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const headers = { 'x-goog-api-key': await requireKey('gemini_key', 'usar Gemini') };
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
    let res;
    try { res = await post(url, headers, body(true), opts); }
    catch (e) {
      if (!/\(400\)/.test(e.message) || !/think/i.test(e.message)) throw e;
      res = await post(url, headers, body(false), opts); // el modelo no admite ese parámetro
    }
    const text = res.candidates?.[0]?.content?.parts?.filter(p => !p.thought).map(p => p.text || '').join('') || '';
    if (!text) throw new Error(`Gemini no devolvió texto (${res.candidates?.[0]?.finishReason || res.promptFeedback?.blockReason || 'sin motivo'}).`);
    return text;
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
