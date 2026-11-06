import { getSetting, requireKey } from '../settings.js';

export function apiError(text) {
  try { const j = JSON.parse(text); return j.error?.message || j.error?.type || j.message || text.slice(0, 300); } catch { return text.slice(0, 300); }
}

async function post(url, headers, body) {
  // Reintenta los errores temporales del proveedor (saturación, límites de uso, fallos de red)
  for (let attempt = 1; ; attempt++) {
    let r, text;
    try {
      r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
      text = await r.text();
    } catch (e) {
      if (attempt >= 4) throw new Error('No se pudo conectar con la API de IA: ' + e.message);
      await new Promise(res => setTimeout(res, 1500 * attempt));
      continue;
    }
    if (r.ok) return JSON.parse(text);
    if ([429, 500, 502, 503, 504, 529].includes(r.status) && attempt < 4) {
      const wait = Number(r.headers.get('retry-after')) * 1000 || 2000 * attempt * attempt;
      await new Promise(res => setTimeout(res, Math.min(wait, 20000)));
      continue;
    }
    throw new Error(`Error de la API (${r.status}): ${apiError(text)}`);
  }
}

/** Llama al proveedor de texto configurado. Devuelve el texto de la respuesta. */
export async function chat(system, user, { json = false, maxTokens = 4000, provider } = {}) {
  provider = provider || await getSetting('llm_provider');
  const sys = json ? system + '\n\nResponde ÚNICAMENTE con JSON válido, sin texto adicional ni bloques de código.' : system;

  if (provider === 'anthropic') {
    const res = await post('https://api.anthropic.com/v1/messages', {
      'x-api-key': await requireKey('anthropic_key', 'usar Claude'), 'anthropic-version': '2023-06-01',
    }, { model: await getSetting('anthropic_model'), max_tokens: maxTokens, system: sys, messages: [{ role: 'user', content: user }] });
    return res.content.filter(b => b.type === 'text').map(b => b.text).join('');
  }

  if (provider === 'gemini') {
    const model = await getSetting('gemini_model');
    const res = await post(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      { 'x-goog-api-key': await requireKey('gemini_key', 'usar Gemini') }, {
        systemInstruction: { parts: [{ text: sys }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: maxTokens, ...(json ? { responseMimeType: 'application/json' } : {}) },
      });
    return res.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
  }

  // OpenAI y OpenRouter comparten el formato chat/completions
  const isOR = provider === 'openrouter';
  const res = await post(isOR ? 'https://openrouter.ai/api/v1/chat/completions' : (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1') + '/chat/completions', {
    authorization: 'Bearer ' + await requireKey(isOR ? 'openrouter_key' : 'openai_key', 'usar ' + provider),
  }, {
    model: await getSetting(isOR ? 'openrouter_model' : 'openai_model'),
    max_completion_tokens: maxTokens,
    messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
    ...(json && !isOR ? { response_format: { type: 'json_object' } } : {}),
  });
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
