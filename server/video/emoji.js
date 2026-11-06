// Emojis como imágenes PNG (libass no dibuja emojis a color). Noto Emoji (Google) con Twemoji de respaldo.
import fs from 'node:fs';
import path from 'node:path';
import { WORK_DIR } from '../db.js';

const DIR = path.join(WORK_DIR, 'emoji');
fs.mkdirSync(DIR, { recursive: true });

const codepoints = e => Array.from(e).map(c => c.codePointAt(0).toString(16)).filter(cp => cp !== 'fe0f');

/** Devuelve la ruta local de un PNG del emoji (lo descarga y lo guarda en caché). */
export async function emojiImage(emoji) {
  const cps = codepoints(String(emoji).trim());
  if (!cps.length) return null;
  const file = path.join(DIR, cps.join('_') + '.png');
  if (fs.existsSync(file)) return file;
  const urls = [
    `https://fonts.gstatic.com/s/e/notoemoji/latest/${cps.join('_')}/512.png`,
    `https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/${cps.join('-')}.png`,
  ];
  for (const u of urls) {
    try {
      const r = await fetch(u);
      if (r.ok && (r.headers.get('content-type') || '').includes('png')) {
        fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
        return file;
      }
    } catch {}
  }
  return null;
}
