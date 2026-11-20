// Mi marca: logo como marca de agua y marco (PNG con el centro transparente) sobre los clips.
import { getSetting } from './settings.js';
import { inputPath, publicUrl } from './storage.js';

export const BRAND_POS = ['tl', 'tr', 'tc', 'bl', 'br', 'bc'];

export async function getBrand() {
  const num = (v, a, z, d) => { const x = Number(v); return Number.isFinite(x) ? Math.max(a, Math.min(z, x)) : d; };
  const logo = await getSetting('brand_logo') || null, frame = await getSetting('brand_frame') || null;
  const pos = await getSetting('brand_pos');
  return {
    logo, frame, logoUrl: logo ? publicUrl(logo) : null, frameUrl: frame ? publicUrl(frame) : null,
    pos: BRAND_POS.includes(pos) ? pos : 'tr',
    size: num(await getSetting('brand_size'), 0.05, 0.6, 0.2), opacity: num(await getSetting('brand_opacity'), 0.1, 1, 0.9),
  };
}

/**
 * Añade el marco y el logo al final de la cadena de filtros del clip.
 * Devuelve { args: entradas extra de ffmpeg, filter: texto a añadir a -filter_complex, last: etiqueta final }.
 */
export async function brandFilter({ last, firstInput, OW, OH }) {
  const b = await getBrand();
  if (!b.logo && !b.frame) return { args: [], filter: '', last };
  const args = [];
  let filter = '', i = firstInput;
  if (b.frame) {
    args.push('-loop', '1', '-i', inputPath(b.frame));
    filter += `;[${i}:v]format=rgba,scale=${OW}:${OH}[bf];[${last}][bf]overlay=0:0:shortest=1[bfo]`;
    last = 'bfo'; i++;
  }
  if (b.logo) {
    args.push('-loop', '1', '-i', inputPath(b.logo));
    const w = Math.round(OW * b.size / 2) * 2, m = Math.round(OW * 0.045);
    const x = b.pos.endsWith('l') ? `${m}` : b.pos.endsWith('r') ? `W-w-${m}` : '(W-w)/2';
    const y = b.pos.startsWith('t') ? `${Math.round(OH * 0.035)}` : `H-h-${Math.round(OH * 0.045)}`;
    filter += `;[${i}:v]format=rgba,scale=${w}:-2,colorchannelmixer=aa=${b.opacity.toFixed(2)}[bl];[${last}][bl]overlay=x=${x}:y=${y}:shortest=1[blo]`;
    last = 'blo';
  }
  return { args, filter, last };
}
