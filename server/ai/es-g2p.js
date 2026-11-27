// Español → fonemas IPA (al estilo de espeak-ng, que es lo que esperan las voces Piper en español).
// El español se pronuncia casi como se escribe, así que bastan reglas: acento, diptongos, b/d/g suaves entre vocales,
// c/z (θ en España, s en Latinoamérica), ll/y, r/rr, números en palabras… Sin dependencias externas.

const VOW = 'aeiouáéíóúü';
const isV = c => !!c && VOW.includes(c);
const STRONG = 'aeoáéóíú'; // las débiles con tilde (í, ú) rompen el diptongo
const strip = c => ({ á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u', ü: 'u' })[c] || c;

// Palabras átonas dentro de la frase (artículos, preposiciones, pronombres…)
const ATONAS = new Set(('el la los las lo le les de del a al en con por para sin sobre tras hasta desde hacia entre según ' +
  'y e o u ni que se me te nos os mi mis tu tus su sus como cuando donde pero si mas aunque porque nuestro nuestra nuestros nuestras vuestro vuestra').split(' '));

// ---------- Números ----------
const U = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce', 'trece', 'catorce', 'quince',
  'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte', 'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis',
  'veintisiete', 'veintiocho', 'veintinueve'];
const D = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
const C = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];
function num(n) {
  n = Math.floor(n);
  if (n < 30) return U[n];
  if (n < 100) return D[Math.floor(n / 10)] + (n % 10 ? ' y ' + U[n % 10] : '');
  if (n === 100) return 'cien';
  if (n < 1000) return C[Math.floor(n / 100)] + (n % 100 ? ' ' + num(n % 100) : '');
  if (n < 1e6) { const k = Math.floor(n / 1000); return (k === 1 ? 'mil' : num(k).replace(/uno$/, 'un') + ' mil') + (n % 1000 ? ' ' + num(n % 1000) : ''); }
  if (n < 1e9) { const m = Math.floor(n / 1e6); return (m === 1 ? 'un millón' : num(m).replace(/uno$/, 'un') + ' millones') + (n % 1e6 ? ' ' + num(n % 1e6) : ''); }
  return String(n).split('').map(d => U[d]).join(' ');
}
const expandNumbers = t => t
  .replace(/(\d+)\s?%/g, (_, n) => num(Number(n)) + ' por ciento')
  .replace(/\$\s?(\d+)/g, (_, n) => num(Number(n)) + ' dólares')
  .replace(/(\d+)[.,](\d+)/g, (_, a, b) => num(Number(a)) + ' coma ' + num(Number(b)))
  .replace(/\d+/g, n => num(Number(n)));

// ---------- Una palabra → [fonemas] y posición del acento ----------
function wordIPA(word, { latam, prev, stressed }) {
  const w = word.toLowerCase();
  // núcleos vocálicos (sílabas) para decidir el acento
  const nuclei = []; // [inicio, fin] de cada grupo vocálico en la palabra escrita
  for (let i = 0; i < w.length; i++) {
    if (!isV(w[i]) && !(w[i] === 'y' && i === w.length - 1 && isV(w[i - 1]))) continue;
    if (w[i] === 'u' && (w[i - 1] === 'q' || (w[i - 1] === 'g' && 'eéií'.includes(w[i + 1] || '')))) continue; // qu, gue, gui: la u no suena
    let j = i;
    while (j + 1 < w.length && (isV(w[j + 1]) || (w[j + 1] === 'y' && j + 2 === w.length))) {
      const a = w[j], b = w[j + 1];
      const weak = c => 'iuüy'.includes(c);
      if (!weak(a) && !weak(b)) break; // dos fuertes: hiato
      if ('íú'.includes(a) || 'íú'.includes(b)) break; // tilde en la débil: hiato
      j++;
    }
    nuclei.push([i, j]);
    i = j;
  }
  // sílaba tónica
  let tonic = -1;
  nuclei.forEach(([a, b], k) => { for (let x = a; x <= b; x++) if ('áéíóú'.includes(w[x])) tonic = k; });
  if (tonic < 0 && nuclei.length) {
    const last = w[w.length - 1];
    tonic = nuclei.length === 1 ? 0 : (isV(last) || last === 'n' || last === 's') && last !== 'y' ? nuclei.length - 2 : nuclei.length - 1;
  }
  if (!stressed) tonic = -1;
  // vocal que recibe la marca dentro del núcleo tónico (la fuerte o la que lleva tilde)
  let mark = -1;
  if (tonic >= 0) {
    const [a, b] = nuclei[tonic];
    mark = a;
    for (let x = a; x <= b; x++) if ('áéíóú'.includes(w[x])) { mark = x; break; } else if (STRONG.includes(w[x])) mark = x;
    if (a === b) mark = a;
    else if (![...w.slice(a, b + 1)].some(c => STRONG.includes(c))) mark = b; // «ui», «iu»: acento en la segunda (cuidado → kwi)
  }
  const out = [];
  const push = (...p) => out.push(...p);
  const prevSound = () => out.length ? out[out.length - 1] : prev; // último fonema (también de la palabra anterior)
  const soft = () => { const p = prevSound(); return p && p !== 'm' && p !== 'n' && p !== 'ŋ' && p !== '#'; };
  for (let i = 0; i < w.length; i++) {
    const c = w[i], n = w[i + 1] || '', n2 = w[i + 2] || '';
    if (i === mark) push('ˈ');
    if (isV(c) || (c === 'y' && i === w.length - 1 && isV(w[i - 1]))) {
      const inNucleus = nuclei.find(([a, b]) => i >= a && i <= b);
      const base = strip(c === 'y' ? 'i' : c);
      if (c === 'u' && (w[i - 1] === 'q' || (w[i - 1] === 'g' && 'eéií'.includes(n)))) continue;
      if (inNucleus && inNucleus[0] !== inNucleus[1] && 'iuy'.includes(c)) {
        // débil dentro de un diptongo: j/w antes de la vocal fuerte; ɪ/ʊ después
        const [a, b] = inNucleus;
        const grp = [...w.slice(a, b + 1)];
        const sIdx = grp.findIndex(ch => STRONG.includes(ch));
        if (sIdx < 0) { // dos débiles (ciudad, cuidado): la primera se desliza, la segunda suena entera
          if (i === a) push(base === 'i' ? 'j' : 'w'); else push(base);
        } else if (i < a + sIdx) push(base === 'i' ? 'j' : 'w');
        else push(base === 'i' ? 'ɪ' : 'ʊ');
      } else if (c === 'ü') push('w');
      else if (base === 'e' && out[out.length - 1] === 'ˈ' && ((n === 'n' && n2 && !isV(n2)) || n === 'j' || n === 'x' || (n === 'g' && 'eiéí'.includes(n2)))) push('ɛ');
      else push(base);
      continue;
    }
    switch (c) {
      case 'b': case 'v': push(soft() ? 'β' : 'b'); break;
      case 'd':
        if (i === w.length - 1) push('d'); // final de palabra (ciudad, verdad)
        else push(soft() && (i === 0 || prevSound() !== 'l') ? 'ð' : 'd'); break;
      case 'g':
        if ('eéiíy'.includes(n)) push('x');
        else push(soft() ? 'ɣ' : 'ɡ');
        break;
      case 'c':
        if (n === 'h') { push('t', 'ʃ'); i++; }
        else if ('eéiíy'.includes(n)) { if (!(latam && out[out.length - 1] === 's')) push(latam ? 's' : 'θ'); }
        else push('k');
        break;
      case 'z': push(latam ? 's' : 'θ'); break;
      case 'q': push('k'); break;
      case 'k': push('k'); break;
      case 'h': break; // muda
      case 'j': push('x'); break;
      case 'l': if (n === 'l') { push(...(latam ? (isV(w[i - 1]) ? ['j', 'j'] : ['ʝ']) : ['ʎ'])); i++; } else push('l'); break;
      case 'ñ': push('ɲ'); break;
      case 'y': push('ʝ'); break;
      case 'r':
        if (n === 'r') { push('r'); i++; }
        else if (i === 0 || 'nls'.includes(w[i - 1])) push('r');
        else push('ɾ');
        break;
      case 'x': if (/^m[eé]xic/.test(w)) push('x'); else push('k', 's'); break;
      case 'n':
        if (n && 'bvpmf'.includes(n)) push('m');
        else if (n && 'gj'.includes(n)) push('ŋ');
        else push('n');
        break;
      case 'w': push('w'); break;
      case 's': if (out[out.length - 1] !== 's') push('s'); break;
      case 'f': case 'm': case 'p': case 't': push(c); break;
      default: if (/[a-z]/.test(c)) push(c);
    }
  }
  return out;
}

/**
 * Texto → lista de frases, cada una con sus fonemas (array de símbolos, con espacios y puntuación como Piper).
 * latam: pronunciación latinoamericana (seseo, ll = ʝ).
 */
export function phonemize(text, { latam = true } = {}) {
  const clean = expandNumbers(String(text).replace(/[«»"“”]/g, '').replace(/…/g, '.').replace(/\s+/g, ' ').trim());
  const sentences = clean.match(/[^.!?]+[.!?]*/g) || [];
  return sentences.map(s => {
    const out = [];
    let prev = '#';
    const tokens = s.match(/[a-záéíóúüñ]+|[,;:.!?]/gi) || [];
    tokens.forEach((tk, k) => {
      if (/^[,;:.!?]$/.test(tk)) { out.push(tk === ';' || tk === ':' ? ',' : tk); prev = '#'; return; }
      const low = tk.toLowerCase();
      const nextIsWord = tokens[k + 1] && !/^[,;:.!?]$/.test(tokens[k + 1]);
      // las palabras átonas solo pierden el acento si van seguidas de otra palabra
      const stressed = !(ATONAS.has(low) && nextIsWord);
      if (out.length) out.push(' ');
      const ph = low === 'y' ? ['i'] : low === 'muy' ? ['m', 'ˈ', 'u', 'j'] : wordIPA(low, { latam, prev, stressed });
      // «con fuerza», «un beso»: la n final se vuelve m ante b/p/m/f
      const first = ph.find(p => p !== 'ˈ');
      if (first && 'bpfβ'.includes(first) && out[out.length - 1] === ' ' && out[out.length - 2] === 'n') out[out.length - 2] = 'm';
      out.push(...ph);
      const last = ph.filter(p => p !== 'ˈ').pop();
      prev = last || prev;
    });
    return out;
  }).filter(x => x.length);
}
