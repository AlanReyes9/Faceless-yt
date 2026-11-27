// Voces gratis: las del propio sistema (Mac «say», Windows SAPI, Linux espeak-ng) y las de Gemini
// (Google AI Studio tiene plan gratuito con tu clave). Se usan en Historias IA y Frutinovelas.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ffmpeg, run } from '../video/ffmpeg.js';
import { getSetting, requireKey } from '../settings.js';
import { apiError } from './llm.js';

// ---------- Voces del sistema ----------
// macOS: género de las voces conocidas (say -v '?' no lo indica)
const MAC_FEMALE = /^(Mónica|Monica|Paulina|Angélica|Angelica|Francisca|Isabela|Marisol|Soledad|Paloma|Flo|Sandy|Shelley|Grandma|Abuela|Samantha|Karen|Moira|Tessa|Victoria|Kathy|Ellen|Siri)/i;
let sysCache = null;
/** Voces instaladas en el equipo: [{ id, name, lang, gender }] (primero las de español). */
export async function systemVoices() {
  if (sysCache) return sysCache;
  let list = [];
  try {
    if (process.platform === 'darwin') {
      const { out } = await run('say', ['-v', '?'], { timeoutMs: 15000 });
      list = out.split('\n').map(l => l.match(/^(.+?)\s{2,}([a-z]{2}[_-][A-Z]{2})/)).filter(Boolean)
        .map(([, name, lang]) => ({ id: name.trim(), name: name.trim(), lang: lang.replace('_', '-'), gender: MAC_FEMALE.test(name.trim()) ? 'female' : 'male' }));
    } else if (process.platform === 'win32') {
      const ps = 'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.GetInstalledVoices() | ForEach-Object { $v = $_.VoiceInfo; "$($v.Name)|$($v.Culture)|$($v.Gender)" }';
      const { out } = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeoutMs: 20000 });
      list = out.split(/\r?\n/).filter(l => l.includes('|')).map(l => { const [name, lang, g] = l.trim().split('|'); return { id: name, name: name.replace(/^Microsoft\s+/, '').replace(/\s+Desktop$/, ''), lang, gender: /female/i.test(g) ? 'female' : 'male' }; });
    } else {
      await run('espeak-ng', ['--version'], { timeoutMs: 5000 });
      list = [{ id: 'es-419', name: 'espeak (latino)', lang: 'es-419', gender: 'male' }, { id: 'es-419+f3', name: 'espeak (latino, mujer)', lang: 'es-419', gender: 'female' }, { id: 'es', name: 'espeak (España)', lang: 'es-ES', gender: 'male' }];
    }
  } catch (e) { console.warn('[voz] no se pudieron leer las voces del sistema:', e.message); }
  const es = list.filter(v => /^es/i.test(v.lang)), rest = list.filter(v => !/^es/i.test(v.lang));
  sysCache = [...es, ...rest];
  return sysCache;
}

async function systemTTS(text, outFile, voice) {
  const tmp = path.join(os.tmpdir(), `say_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  try {
    if (process.platform === 'darwin') {
      fs.writeFileSync(tmp + '.txt', text);
      await run('say', [...(voice ? ['-v', voice] : []), '-o', tmp + '.aiff', '-f', tmp + '.txt'], { timeoutMs: 120000 });
      await ffmpeg(['-y', '-i', tmp + '.aiff', '-ar', '44100', '-ac', '1', '-b:a', '128k', outFile]);
    } else if (process.platform === 'win32') {
      fs.writeFileSync(tmp + '.txt', text, 'utf8');
      const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ${voice ? `$s.SelectVoice('${voice.replace(/'/g, "''")}');` : ''} $s.SetOutputToWaveFile('${(tmp + '.wav').replace(/'/g, "''")}'); $s.Speak([IO.File]::ReadAllText('${(tmp + '.txt').replace(/'/g, "''")}', [Text.Encoding]::UTF8)); $s.Dispose()`;
      await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeoutMs: 120000 });
      await ffmpeg(['-y', '-i', tmp + '.wav', '-ar', '44100', '-ac', '1', '-b:a', '128k', outFile]);
    } else {
      await run('espeak-ng', ['-v', voice || 'es-419', '-s', '165', '-w', tmp + '.wav', text], { timeoutMs: 120000 });
      await ffmpeg(['-y', '-i', tmp + '.wav', '-ar', '44100', '-ac', '1', '-b:a', '128k', outFile]);
    }
  } catch (e) {
    throw new Error('No se pudo generar la voz del sistema: ' + String(e.message).slice(-200));
  } finally { for (const x of ['.txt', '.aiff', '.wav']) fs.rmSync(tmp + x, { force: true }); }
  return outFile;
}

// ---------- Gemini (voz de alta calidad; plan gratuito con tu clave de Google AI Studio) ----------
export const GEMINI_VOICES = {
  female: ['Kore', 'Aoede', 'Leda', 'Zephyr', 'Callirrhoe', 'Autonoe', 'Despina', 'Erinome', 'Laomedeia', 'Achernar', 'Gacrux', 'Pulcherrima', 'Vindemiatrix', 'Sulafat'],
  male: ['Puck', 'Charon', 'Fenrir', 'Orus', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Algenib', 'Rasalgethi', 'Alnilam', 'Schedar', 'Achird', 'Zubenelgenubi', 'Sadachbia', 'Sadaltager'],
};
let ttsModel = null;
async function geminiTTSModel(key) {
  if (ttsModel) return ttsModel;
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=' + encodeURIComponent(key), { signal: AbortSignal.timeout(15000) });
    const names = ((await r.json()).models || []).map(m => String(m.name).replace(/^models\//, '')).filter(n => /tts/i.test(n));
    ttsModel = names.find(n => /flash/.test(n)) || names[0];
  } catch {}
  return (ttsModel ||= 'gemini-2.5-flash-preview-tts');
}
async function geminiTTS(text, outFile, voice = 'Kore', style = '') {
  const key = await requireKey('gemini_key', 'usar las voces de Gemini');
  const model = await geminiTTSModel(key);
  const body = {
    contents: [{ parts: [{ text: style ? `${style}: ${text}` : text }] }],
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
  };
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
    const txt = await r.text();
    if (r.status === 429 && attempt < 3) { // plan gratuito: pocas peticiones por minuto
      const wait = Number(txt.match(/retry in ([\d.]+)s/i)?.[1]) || 30;
      console.log(`[voz] Gemini: límite por minuto, esperando ${Math.ceil(wait)} s…`);
      await new Promise(res => setTimeout(res, Math.min(65, wait + 1) * 1000));
      continue;
    }
    if (!r.ok) throw new Error(`Voz de Gemini (${r.status}): ${apiError(txt)}`);
    const part = JSON.parse(txt).candidates?.[0]?.content?.parts?.find(p => p.inlineData?.data);
    if (!part) throw new Error('Gemini no devolvió audio.');
    const pcm = outFile + '.pcm';
    fs.writeFileSync(pcm, Buffer.from(part.inlineData.data, 'base64'));
    const rate = Number(String(part.inlineData.mimeType || '').match(/rate=(\d+)/)?.[1]) || 24000;
    try { await ffmpeg(['-y', '-f', 's16le', '-ar', String(rate), '-ac', '1', '-i', pcm, '-ar', '44100', '-b:a', '128k', outFile]); }
    finally { fs.rmSync(pcm, { force: true }); }
    return outFile;
  }
}

/**
 * Voz gratis. voice: 'system:<nombre>' | 'gemini:<voz>', con tono opcional '@1.15' (más aguda) / '@0.9' (más grave).
 * style (solo Gemini): cómo debe sonar, p. ej. «dilo con mucho drama».
 */
export async function freeTTS(text, outFile, voice = 'system:', { style = '' } = {}) {
  const [spec, pitchStr] = String(voice).split('@');
  const [prov, name] = spec.split(':');
  const raw = pitchStr ? outFile + '.raw.mp3' : outFile;
  if (prov === 'gemini') await geminiTTS(text, raw, name || 'Kore', style);
  else await systemTTS(text, raw, name || '');
  const pitch = Number(pitchStr);
  if (pitchStr && pitch > 0.5 && pitch < 2 && pitch !== 1) {
    // cambia el tono sin cambiar la velocidad (voces de personajes)
    await ffmpeg(['-y', '-i', raw, '-af', `asetrate=44100*${pitch},aresample=44100,atempo=${(1 / pitch).toFixed(4)}`, '-b:a', '128k', outFile]);
    fs.rmSync(raw, { force: true });
  } else if (raw !== outFile) fs.renameSync(raw, outFile);
  return outFile;
}

/** Reparte voces a los personajes (sin repetir mientras haya) según el proveedor gratis elegido. */
export async function castVoices(characters, provider, narrator) {
  const used = new Set([narrator]);
  let pool;
  if (provider === 'gemini') pool = { female: GEMINI_VOICES.female.map(v => 'gemini:' + v), male: GEMINI_VOICES.male.map(v => 'gemini:' + v) };
  else {
    const vs = (await systemVoices()).filter(v => /^es/i.test(v.lang));
    const list = vs.length ? vs : await systemVoices();
    pool = { female: list.filter(v => v.gender === 'female').map(v => 'system:' + v.id), male: list.filter(v => v.gender === 'male').map(v => 'system:' + v.id) };
  }
  // Pocas voces (habitual en Windows): se reutilizan con distinto tono para que suenen diferentes
  const pitches = ['', '@1.12', '@0.9', '@1.22', '@0.82'];
  const n = { female: 0, male: 0 };
  return characters.map(c => {
    const g = c.gender === 'female' ? 'female' : 'male';
    const arr = pool[g].length ? pool[g] : pool[g === 'female' ? 'male' : 'female'];
    if (!arr.length) return { ...c, voice: narrator };
    let v;
    for (let k = 0; k < 40; k++) {
      const i = n[g]++;
      v = arr[i % arr.length] + (provider === 'gemini' ? '' : pitches[Math.floor(i / arr.length) % pitches.length]);
      if (!used.has(v)) break;
    }
    used.add(v);
    return { ...c, voice: v };
  });
}

/** Proveedor gratis por defecto: Gemini si hay clave, si no las voces del sistema. */
export async function defaultFreeVoiceProvider() {
  return (await getSetting('gemini_key')) ? 'gemini' : 'system';
}
