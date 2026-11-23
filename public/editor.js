// Editor de clips: Original (con la ventana de encuadre) | Resultado (vista previa en vivo) | Encuadre, Textos, Recortes, Plantillas.
// Línea de tiempo con forma de onda, inicio/fin arrastrables y fotogramas clave de encuadre.
const FORMATS = { v: ['Vertical 9:16 (TikTok, Shorts, Reels)', 1080, 1920], p45: ['Vertical 4:5 (Instagram, Facebook)', 1080, 1350], sq: ['Cuadrado 1:1', 1080, 1080] };
const fmtT = t => { t = Math.max(0, t || 0); const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = (t % 60).toFixed(3).padStart(6, '0'); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s}`; };
const norm = w => String(w).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]/gu, '');

export async function openClipEditor(clipId, { api, esc, toast, busy, main, mmss }) {
  const d = await api(`/api/clips/${clipId}/editor`);
  const P = d.project, c = d.clip, E = d.edit || {};
  if (P.sourceDeleted || !P.sourceUrl) throw new Error('El vídeo original de este proyecto se borró: no se puede editar.');
  const st0 = d.styles[E.captions?.style || c.style || P.captionStyle || 'impacto'] || d.styles.impacto;
  const S = {
    start: c.start, end: c.end, title: c.title || '', hook: c.hook || '', hookOn: E.hookOn !== false, emojis: E.emojis !== false,
    format: E.format || 'v', layout: E.layout || c.layout || 'face',
    crop: { mode: E.crop?.mode || (c.layout === 'face' ? 'face' : 'fixed'), zoom: E.crop?.zoom || 1, cx: E.crop?.cx ?? 0.5, cy: E.crop?.cy ?? 0.5, keys: E.crop?.keys || [] },
    captions: { show: E.captions?.show !== false, style: E.captions?.style || c.style || 'impacto', size: E.captions?.size || 1,
      y: E.captions?.y ?? (c.layout === 'blur' ? 1 - 560 / 1920 : 1 - 420 / 1920), color: E.captions?.color || d.highlight || '#FFD400',
      upper: E.captions?.upper ?? st0.upper, wpg: E.captions?.wpg || st0.wpg },
    words: d.words.map(w => ({ ...w })),
    // Gaming: recuadro de la cámara del jugador (normalizado); si aún no se detectó, uno provisional arriba a la izquierda
    facecam: d.facecam ? { ...d.facecam } : { x: 0.02, y: 0.04, w: 0.25, h: 0.38 }, facecamSet: !!E.facecam,
    // Pantalla dividida: segundo recuadro (el de abajo)
    split2: d.split2 ? { ...d.split2 } : { x: 0.5, y: 0, w: 0.5, h: 1 },
    font: E.font || 'DejaVu Sans',
    titleBar: { show: !!E.titleBar?.show, text: E.titleBar?.text || '', color: E.titleBar?.color || '#FFFFFF', bg: E.titleBar?.bg || '#E11D48', size: E.titleBar?.size || 1 },
    grade: E.grade || '', adjust: { b: E.adjust?.b || 0, c: E.adjust?.c || 0, s: E.adjust?.s || 0 }, mirror: !!E.mirror, motion: E.motion || 0, speed: E.speed || 1,
    overlays: (E.overlays || []).map(o => ({ ...o })),
  };
  S.captions.textColor = E.captions?.textColor || '#FFFFFF';
  // Letras: se cargan en el navegador para que la vista previa sea igual que el vídeo final
  const FONT_FILES = { 'DejaVu Sans': 'DejaVuSans-Bold.ttf', 'Anton': 'Anton-Regular.ttf', 'Bebas Neue': 'BebasNeue-Regular.ttf', 'Poppins Black': 'Poppins-Black.ttf',
    'Archivo Black': 'ArchivoBlack-Regular.ttf', 'Lilita One': 'LilitaOne-Regular.ttf', 'Bangers': 'Bangers-Regular.ttf', 'DM Serif Display': 'DMSerifDisplay-Regular.ttf' };
  const loadFont = fam => { if (!FONT_FILES[fam] || [...document.fonts].some(f => f.family.replace(/"/g, '') === 'cp-' + fam)) return;
    const ff = new FontFace('cp-' + fam, `url(/fonts/${FONT_FILES[fam]})`); ff.load().then(f => { document.fonts.add(f); render(); }).catch(() => {}); };
  const fontCss = () => `"cp-${S.font}", "DejaVu Sans", Arial, sans-serif`;
  loadFont(S.font);
  // Fotos y logos: imágenes para la vista previa
  const ovImg = {};
  const ovImage = o => { if (!o.url) return null; if (!ovImg[o.url]) { const im = new Image(); im.onload = () => render(); im.src = o.url; ovImg[o.url] = im; } return ovImg[o.url]; };
  const GRADE_CSS = { '': '', vivo: 'saturate(1.28) contrast(1.06)', calido: 'sepia(0.18) saturate(1.12)', frio: 'hue-rotate(-10deg) saturate(0.95) contrast(1.04)',
    cine: 'contrast(1.12) saturate(0.88) brightness(0.98)', brillo: 'brightness(1.08) contrast(1.04) saturate(1.12)', bn: 'grayscale(1) contrast(1.1)' };
  const lookCss = () => `${GRADE_CSS[S.grade] || ''} brightness(${1 + S.adjust.b / 100 * 0.6}) contrast(${1 + S.adjust.c / 100}) saturate(${Math.max(0, 1 + S.adjust.s / 100)})`.trim();
  // Mi marca (logo y marco): imágenes para la vista previa
  const BR = d.brand || {}; S.brand = !!BR.on;
  S.autocut = { silence: !!d.autocut?.silence, retakes: !!d.autocut?.retakes, condense: !!d.autocut?.condense };
  const brandImg = u => { if (!u) return null; const im = new Image(); im.onload = () => render(); im.src = u; return im; };
  const bLogo = brandImg(BR.logoUrl), bFrame = brandImg(BR.frameUrl);
  if (S.layout === 'face' && S.crop.mode === 'fixed') S.layout = 'crop';
  let wordsDirty = false;
  const W = P.width, H = P.height, WIN = d.window;
  const autoKeys = d.autoKeys || [{ t: S.start, cx: 0.5, cut: true }];

  main.innerHTML = `<div class="ed">
    <div class="ed-top"><div class="row"><button class="btn ed-ghost" id="back">← ${window.opener ? 'Cerrar editor' : 'Volver al vídeo completo'}</button><span class="ed-saved" id="saved">✓ Guardado</span></div>
      <div class="ed-title"><span class="ed-logo">▶</span> ${esc(c.title || 'Clip ' + c.idx)} <span class="muted">· ${esc(P.title)}</span></div>
      <div class="row"><span class="small muted mono" id="tdur2"></span></div></div>
    <div class="ed-main">
      <div class="ed-col"><div class="small muted">Original</div><div class="ed-orig" id="orig"><video id="vid" src="${esc(P.sourceUrl)}" preload="auto" playsinline></video><div class="ed-rect" id="rect"><span></span></div><div class="ed-rect ed-rect2" id="rect2" hidden><span></span></div></div></div>
      <div class="ed-col"><div class="small muted">Resultado</div><canvas id="out" class="ed-out"></canvas></div>
      <div class="ed-panel">
        <div class="ed-tabs">${[[0, 'Encuadre'], [1, 'Textos'], [4, 'Imagen'], [5, 'Fotos'], [2, 'Recortes'], [3, 'Plantillas']].map(([i, t]) => `<button data-tab="${i}" class="${i ? '' : 'on'}">${t}</button>`).join('')}</div>
        <div class="ed-pane" id="pane"></div>
        <button class="btn gold block" id="export">⬇ Exportar MP4</button>
        <div class="small muted" id="exportInfo"></div>
      </div>
    </div>
    <div class="ed-bar row">
      <button class="ed-round ed-play" id="play" title="Reproducir (espacio)">▶</button><button class="ed-round" id="stop" title="Detener">■</button><button class="ed-round" id="fprev" title="Fotograma anterior (←) · Mayús+← = 1 s">⏴|</button><button class="ed-round" id="fnext" title="Fotograma siguiente (→) · Mayús+→ = 1 s">|⏵</button>
      <input type="range" id="vol" min="0" max="1" step="0.05" value="1" style="width:90px" title="Volumen">
      <span class="small mono" id="tnow"></span><span class="small muted mono" id="trange"></span>
      <span style="flex:1"></span>
      <span class="small">Inicio</span><button class="btn sm" data-nudge="start:-0.5">-0,5 s</button><button class="btn sm" data-nudge="start:0.5">+0,5 s</button>
      <span class="small">Fin</span><button class="btn sm" data-nudge="end:-0.5">-0,5 s</button><button class="btn sm" data-nudge="end:0.5">+0,5 s</button>
      <span class="small" id="tdur"></span>
    </div>
    <div class="ed-tl"><canvas id="tl"></canvas></div>
  </div>`;
  const $e = s => main.querySelector(s);
  document.title = `${c.title || 'Clip'} · Editor · Clippers Pro`;
  const notify = () => { try { window.opener?.postMessage({ type: 'clip-saved', clipId, projectId: P.id }, location.origin); } catch {} };
  $e('#back').onclick = () => { notify(); if (window.opener) window.close(); else location.hash = '#/proyecto/' + P.id; };
  const vid = $e('#vid'), out = $e('#out'), ctx = out.getContext('2d'), tl = $e('#tl'), tctx = tl.getContext('2d');
  // Directos: el vídeo del editor es un trozo de la grabación que empieza en P.timeOffset; los tiempos se manejan absolutos
  const OFF = Number(P.timeOffset) || 0;
  if (OFF) {
    const ct = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
    Object.defineProperty(vid, 'currentTime', { get() { return ct.get.call(this) + OFF; }, set(v) { ct.set.call(this, Math.max(0, v - OFF)); } });
  }
  document.body.classList.add('editing');

  // ---------- Encuadre ----------
  const geom = () => {
    const [, ow, oh] = FORMATS[S.format];
    let ch = H / Math.max(1, S.crop.zoom), cw = ch * ow / oh;
    if (cw > W) { cw = W; ch = Math.min(H, cw * oh / ow); }
    return { cw, ch, ow, oh };
  };
  const keysNow = () => S.crop.mode === 'manual' ? [...S.crop.keys].sort((a, b) => a.t - b.t) : S.crop.mode === 'face' ? autoKeys : [{ t: 0, cx: S.crop.cx, cut: true }];
  const cxAt = t => {
    const k = keysNow();
    if (!k.length) return S.crop.cx;
    let cx = k[0].cx;
    for (let i = 1; i < k.length; i++) {
      if (t < k[i].t) break;
      const a = k[i - 1].cx, b = k[i].cx;
      cx = k[i].cut || t >= k[i].t + 0.6 ? b : a + (b - a) * (t - k[i].t) / 0.6;
    }
    return cx;
  };
  // Inicio exacto del fotograma que se ve en t (un poco antes): así el encuadre cambia justo en ese fotograma
  const frameStart = t => { const fps = Number(P.fps) || 30, raw = t - OFF; return OFF + Math.floor(raw * fps + 1e-3) / fps - 0.002; };
  const rectAt = t => {
    const { cw, ch } = geom();
    const x = Math.max(0, Math.min(W - cw, cxAt(t) * W - cw / 2)), y = Math.max(0, Math.min(H - ch, S.crop.cy * H - ch / 2));
    return { x, y, cw, ch };
  };

  // ---------- Subtítulos (misma lógica que el render) ----------
  const clipWords = () => S.words.filter(w => w.end > S.start && w.start < S.end);
  const groups = () => {
    const ws = clipWords(), out = []; let cur = [];
    ws.forEach((w, i) => { cur.push(w); const n = ws[i + 1]; if (cur.length >= S.captions.wpg || /[.!?…,;:]$/.test(w.word) || (n && n.start - w.end > 0.6) || !n) { out.push(cur); cur = []; } });
    return out;
  };
  const drawText = (txt, x, y, size, fill, opts = {}) => {
    ctx.font = `800 ${size}px ${fontCss()}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round'; ctx.lineWidth = size * 0.16; ctx.strokeStyle = '#000';
    if (opts.box) { const w = ctx.measureText(txt).width; ctx.fillStyle = opts.box; ctx.fillRect(x - size * 0.12, y - size * 0.62, w + size * 0.24, size * 1.24); }
    else ctx.strokeText(txt, x, y);
    ctx.fillStyle = fill; ctx.fillText(txt, x, y);
  };
  const render = () => {
    const t = vid.currentTime;
    const { ow, oh } = geom();
    const cwid = out.width, chei = out.height, k = cwid / ow;
    ctx.clearRect(0, 0, cwid, chei);
    // Imagen: color, ajustes, espejo y zoom suave (los textos no se ven afectados)
    const zoomNow = S.motion && Math.floor((t - S.start) / S.motion) % 2 === 1 ? 1.12 : 1;
    ctx.save();
    if (S.mirror || zoomNow !== 1) { ctx.translate(cwid / 2, chei / 2); ctx.scale((S.mirror ? -1 : 1) * zoomNow, zoomNow); ctx.translate(-cwid / 2, -chei / 2); }
    const LOOK = lookCss(), withLook = f => (f ? f + ' ' : '') + LOOK || 'none';
    ctx.filter = withLook('');
    if (vid.readyState >= 2) {
      if (S.layout === 'split') {
        const half = Math.round(chei / 2);
        [[S.facecam, 0, half], [S.split2, half, chei - half]].forEach(([r, y0, h0]) => {
          const sx = r.x * W, sy = r.y * H, sw = r.w * W, sh = r.h * H, sc = Math.max(cwid / sw, h0 / sh), dw = sw * sc, dh = sh * sc;
          ctx.save(); ctx.beginPath(); ctx.rect(0, y0, cwid, h0); ctx.clip(); ctx.drawImage(vid, sx, sy, sw, sh, (cwid - dw) / 2, y0 + (h0 - dh) / 2, dw, dh); ctx.restore();
        });
      } else if (S.layout === 'gaming') {
        // arriba: cámara del jugador sobre su propio fondo difuminado; abajo: la partida a todo el alto, recortada al centro
        const TH = Math.round(chei * 0.355), GH = chei - TH, F = S.facecam;
        const sx = F.x * W, sy = F.y * H, sw = F.w * W, sh = F.h * H;
        ctx.filter = withLook('blur(14px) brightness(0.85) saturate(1.2)'); ctx.drawImage(vid, sx, sy, sw, sh, -20, -20, cwid + 40, TH + 40); ctx.filter = withLook('');
        const pad = TH * 0.07, s2 = Math.min((cwid - 2 * pad) / sw, (TH - 2 * pad) / sh), fw = sw * s2, fh = sh * s2;
        ctx.save(); ctx.beginPath(); ctx.roundRect ? ctx.roundRect((cwid - fw) / 2, (TH - fh) / 2, fw, fh, Math.min(fw, fh) * 0.06) : ctx.rect((cwid - fw) / 2, (TH - fh) / 2, fw, fh); ctx.clip();
        ctx.drawImage(vid, sx, sy, sw, sh, (cwid - fw) / 2, (TH - fh) / 2, fw, fh); ctx.restore();
        const gs = Math.max(cwid / W, GH / H), gw = W * gs;
        ctx.save(); ctx.beginPath(); ctx.rect(0, TH, cwid, GH); ctx.clip(); ctx.drawImage(vid, (cwid - gw) / 2, TH, gw, H * gs); ctx.restore();
      } else if (S.layout === 'blur') {
        const sc = Math.max(cwid / W, chei / H);
        ctx.filter = withLook('blur(18px) brightness(0.9)'); ctx.drawImage(vid, (cwid - W * sc) / 2, (chei - H * sc) / 2, W * sc, H * sc); ctx.filter = withLook('');
        const f = Math.min(cwid / W, chei / H); ctx.drawImage(vid, (cwid - W * f) / 2, (chei - H * f) / 2, W * f, H * f);
      } else { const r = rectAt(t); ctx.drawImage(vid, r.x, r.y, r.cw, r.ch, 0, 0, cwid, chei); }
    }
    ctx.restore(); ctx.filter = 'none';
    // Título fijo arriba con caja de color (todo el clip)
    const tbText = (S.titleBar.text || S.title || '').trim();
    let hookTop = (S.layout === 'gaming' ? Math.round(1920 * 0.355) + 40 + 40 : 190 + 40);
    if (S.titleBar.show && tbText) {
      const size = 64 * S.titleBar.size * k; ctx.font = `800 ${size}px ${fontCss()}`;
      const words = tbText.toUpperCase().split(/\s+/), lines = []; let cur = '';
      for (const w of words) { const tryL = cur ? cur + ' ' + w : w; if (ctx.measureText(tryL).width > cwid * 0.82 && cur) { lines.push(cur); cur = w; } else cur = tryL; }
      if (cur) lines.push(cur);
      lines.forEach((line, i) => {
        const w = ctx.measureText(line).width, x = (cwid - w) / 2, y = 110 * k + size * 0.62 + i * size * 1.2;
        if (S.titleBar.bg !== 'none') { ctx.fillStyle = S.titleBar.bg; ctx.fillRect(x - 16 * k, y - size * 0.62 - 8 * k, w + 32 * k, size * 1.24 + 16 * k); }
        else { ctx.lineWidth = size * 0.14; ctx.strokeStyle = '#000'; ctx.lineJoin = 'round'; ctx.strokeText(line, x, y); }
        ctx.textBaseline = 'middle'; ctx.fillStyle = S.titleBar.color; ctx.fillText(line, x, y);
      });
      hookTop = Math.max(hookTop, 110 + lines.length * 64 * S.titleBar.size * 1.25 + 60);
    }
    // gancho (4 s)
    if (S.hookOn && S.hook && t >= S.start && t < S.start + 4) {
      const size = 80 * k; ctx.font = `800 ${size}px ${fontCss()}`;
      const words = S.hook.toUpperCase().split(' '); const half = Math.ceil(words.length / 2);
      [words.slice(0, half).join(' '), words.slice(half).join(' ')].filter(Boolean).forEach((line, i) => {
        const w = ctx.measureText(line).width; drawText(line, (cwid - w) / 2, hookTop * k + i * size * 1.15, size, i ? '#fff' : S.captions.color);
      });
    }
    // subtítulos
    if (S.captions.show && t >= S.start && t <= S.end) {
      const st = d.styles[S.captions.style] || d.styles.impacto;
      const g = groups().find(g => t >= g[0].start - 0.05 && t < Math.max(g[g.length - 1].end, g[0].start + 0.3) + 0.15);
      if (g) {
        const size = st.size * S.captions.size * k, y = S.captions.y * chei;
        const txt = w => S.captions.upper ? w.word.toUpperCase() : w.word;
        ctx.font = `800 ${size}px ${fontCss()}`;
        const gap = size * 0.28;
        const parts = g.map(txt), widths = parts.map(p => ctx.measureText(p).width * 1.08 + gap);
        const total = widths.reduce((a, b) => a + b, 0) - gap;
        let x = (cwid - total) / 2;
        g.forEach((w, i) => {
          const active = t >= w.start && (i === g.length - 1 || t < g[i + 1].start) && st.mode !== 'none';
          drawText(parts[i], x, y - size * 0.5, active && st.mode === 'pop' ? size * 1.08 : size, active && st.mode !== 'box' ? S.captions.color : S.captions.textColor, active && st.mode === 'box' ? { box: S.captions.color } : {});
          x += widths[i];
        });
      }
    }
    // Fotos y logos (se arrastran sobre el resultado)
    const tc = t - S.start;
    S.overlays.forEach(o => {
      const im = ovImage(o); if (!im?.complete || !im.naturalWidth) return;
      if (tc < (o.from || 0) || (o.to > (o.from || 0) && tc > o.to)) return;
      const w = cwid * o.w, h = w * im.naturalHeight / im.naturalWidth;
      ctx.drawImage(im, o.x * cwid - w / 2, o.y * chei - h / 2, w, h);
    });
    // Mi marca: marco y logo encima de todo, como en el vídeo final
    if (S.brand) {
      if (bFrame?.complete && bFrame.naturalWidth) ctx.drawImage(bFrame, 0, 0, cwid, chei);
      if (bLogo?.complete && bLogo.naturalWidth) {
        const lw = cwid * BR.size, lh = lw * bLogo.naturalHeight / bLogo.naturalWidth, m = cwid * 0.045;
        const lx = BR.pos.endsWith('l') ? m : BR.pos.endsWith('r') ? cwid - lw - m : (cwid - lw) / 2;
        const ly = BR.pos.startsWith('t') ? chei * 0.035 : chei - lh - chei * 0.045;
        ctx.globalAlpha = BR.opacity; ctx.drawImage(bLogo, lx, ly, lw, lh); ctx.globalAlpha = 1;
      }
    }
    // rectángulo del original
    const r = S.layout === 'gaming' || S.layout === 'split' ? { x: S.facecam.x * W, y: S.facecam.y * H, cw: S.facecam.w * W, ch: S.facecam.h * H } : rectAt(t), rect = $e('#rect');
    const r2 = $e('#rect2');
    if (r2) { r2.hidden = S.layout !== 'split'; if (S.layout === 'split') Object.assign(r2.style, { left: S.split2.x * 100 + '%', top: S.split2.y * 100 + '%', width: S.split2.w * 100 + '%', height: S.split2.h * 100 + '%' }); }
    if (rect) {
      rect.style.display = S.layout === 'blur' ? 'none' : 'block';
      rect.title = S.layout === 'gaming' ? 'Cámara del jugador: arrástrala para moverla y usa la esquina para cambiar su tamaño' : S.layout === 'split' ? 'Parte de ARRIBA: arrástrala y usa la esquina para cambiar su tamaño' : '';
      rect.style.left = r.x / W * 100 + '%'; rect.style.top = r.y / H * 100 + '%'; rect.style.width = r.cw / W * 100 + '%'; rect.style.height = r.ch / H * 100 + '%';
    }
    $e('#tnow').textContent = fmtT(t);
    drawTimeline();
  };
  const sizeOut = () => {
    const { ow, oh } = geom();
    const hh = Math.max(300, Math.min(600, window.innerHeight - 330));
    out.height = Math.round(hh); out.width = Math.round(hh * ow / oh);
    out.style.width = out.width + 'px'; out.style.height = out.height + 'px';
  };

  // ---------- Línea de tiempo ----------
  let peaks = [];
  const tx = t => (t - WIN.from) / (WIN.to - WIN.from) * tl.width;
  const xt = x => WIN.from + x / tl.width * (WIN.to - WIN.from);
  const drawTimeline = () => {
    const w = tl.width, h = tl.height, mid = h * 0.45;
    tctx.clearRect(0, 0, w, h);
    tctx.fillStyle = '#12141a'; tctx.fillRect(0, 0, w, h);
    const a = tx(S.start), b = tx(S.end);
    tctx.fillStyle = 'rgba(34,197,94,.12)'; tctx.fillRect(a, 0, b - a, h * 0.82);
    const bw = w / Math.max(1, peaks.length);
    peaks.forEach((p, i) => { const x = i * bw, inside = x >= a && x <= b; tctx.fillStyle = inside ? '#2ad4e0' : '#5a5f6b'; const ph = Math.max(1, p * mid * 1.9); tctx.fillRect(x, mid - ph / 2, Math.max(1, bw - 0.5), ph); });
    for (const [x, col] of [[a, '#22c55e'], [b, '#22c55e']]) { tctx.fillStyle = col; tctx.fillRect(x - 2, 0, 4, h * 0.82); tctx.fillRect(x - 6, 0, 12, 10); }
    // fotogramas clave
    const keys = S.crop.mode === 'manual' ? S.crop.keys : S.crop.mode === 'face' ? autoKeys : [];
    tctx.fillStyle = '#FFD400';
    for (const k of keys) { const x = tx(k.t); if (x < 0 || x > w) continue; tctx.beginPath(); tctx.moveTo(x, h * 0.84); tctx.lineTo(x + 5, h * 0.89); tctx.lineTo(x, h * 0.94); tctx.lineTo(x - 5, h * 0.89); tctx.fill(); }
    // marcas de tiempo
    tctx.fillStyle = '#9399a6'; tctx.font = '10px sans-serif';
    const span = WIN.to - WIN.from, step = span > 240 ? 30 : span > 90 ? 10 : 5;
    for (let s = Math.ceil(WIN.from / step) * step; s <= WIN.to; s += step) { const x = tx(s); tctx.fillRect(x, h * 0.78, 1, 5); tctx.fillText(mmss(s), x + 2, h - 3); }
    // cabezal
    const px = tx(vid.currentTime); tctx.fillStyle = '#fff'; tctx.fillRect(px - 1, 0, 2, h * 0.82);
    $e('#trange').textContent = `clip ${fmtT(S.start)} – ${fmtT(S.end)}`;
    $e('#tdur').textContent = `Duración: ${(S.end - S.start).toFixed(1)} s`;
    $e('#tdur2').textContent = `${fmtT(S.start)} → ${fmtT(S.end)}`;
  };
  const sizeTl = () => { tl.width = tl.parentElement.clientWidth; tl.height = 110; drawTimeline(); };
  let drag = null;
  tl.onpointerdown = e => {
    const x = e.offsetX, a = tx(S.start), b = tx(S.end);
    drag = Math.abs(x - a) < 9 ? 'start' : Math.abs(x - b) < 9 ? 'end' : 'seek';
    if (drag === 'seek') { vid.currentTime = Math.max(WIN.from, Math.min(WIN.to, xt(x))); }
    tl.setPointerCapture(e.pointerId);
  };
  tl.onpointermove = e => {
    const x = e.offsetX, a = tx(S.start), b = tx(S.end);
    tl.style.cursor = Math.abs(x - a) < 9 || Math.abs(x - b) < 9 ? 'ew-resize' : 'pointer';
    if (!drag) return;
    const t = Math.max(WIN.from, Math.min(WIN.to, xt(x)));
    if (drag === 'start') { S.start = Math.min(t, S.end - 2); vid.currentTime = S.start; changed(); }
    else if (drag === 'end') { S.end = Math.max(t, S.start + 2); vid.currentTime = S.end; changed(); }
    else vid.currentTime = t;
  };
  tl.onpointerup = () => { drag = null; };
  tl.ondblclick = e => { // doble clic en un fotograma clave manual: borrarlo
    if (S.crop.mode !== 'manual') return;
    const k = S.crop.keys.findIndex(k => Math.abs(tx(k.t) - e.offsetX) < 7);
    if (k >= 0) { S.crop.keys.splice(k, 1); changed(); pane(); }
  };

  // ---------- Arrastrar el encuadre en el original ----------
  const rect = $e('#rect');
  const dragBox = (e, R0) => {
      const box = $e('#orig').getBoundingClientRect(), f0 = { ...R0 }, sx = e.clientX, sy = e.clientY, resize = e.target.tagName === 'SPAN';
      const move = ev => {
        const dx = (ev.clientX - sx) / box.width, dy = (ev.clientY - sy) / box.height;
        if (resize) { R0.w = Math.max(0.05, Math.min(1 - f0.x, f0.w + dx)); R0.h = Math.max(0.05, Math.min(1 - f0.y, f0.h + dy)); }
        else { R0.x = Math.max(0, Math.min(1 - f0.w, f0.x + dx)); R0.y = Math.max(0, Math.min(1 - f0.h, f0.y + dy)); }
        S.facecamSet = true; render();
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); changed(); pane(); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  $e('#rect2').onpointerdown = e => { e.preventDefault(); dragBox(e, S.split2); };
  rect.onpointerdown = e => {
    e.preventDefault();
    if (S.layout === 'split') return dragBox(e, S.facecam);
    if (S.layout === 'gaming') {
      const box = $e('#orig').getBoundingClientRect(), f0 = { ...S.facecam }, sx = e.clientX, sy = e.clientY, resize = e.target.tagName === 'SPAN';
      const move = ev => {
        const dx = (ev.clientX - sx) / box.width, dy = (ev.clientY - sy) / box.height;
        if (resize) { S.facecam.w = Math.max(0.05, Math.min(1 - f0.x, f0.w + dx)); S.facecam.h = Math.max(0.05, Math.min(1 - f0.y, f0.h + dy)); }
        else { S.facecam.x = Math.max(0, Math.min(1 - f0.w, f0.x + dx)); S.facecam.y = Math.max(0, Math.min(1 - f0.h, f0.y + dy)); }
        S.facecamSet = true; render();
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); changed(); pane(); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
      return;
    }
    const box = $e('#orig').getBoundingClientRect(), t = vid.currentTime, r0 = rectAt(t);
    const sx = e.clientX, sy = e.clientY, cx0 = (r0.x + r0.cw / 2) / W, cy0 = (r0.y + r0.ch / 2) / H;
    if (S.crop.mode === 'face') { S.crop.mode = 'manual'; S.crop.keys = autoKeys.map(k => ({ ...k })); pane(); }
    const move = ev => {
      const cx = Math.max(0, Math.min(1, cx0 + (ev.clientX - sx) / box.width)), cy = Math.max(0, Math.min(1, cy0 + (ev.clientY - sy) / box.height));
      S.crop.cy = cy;
      if (S.crop.mode === 'manual') {
        let k = S.crop.keys.find(k => Math.abs(k.t - t) < 0.25);
        if (!k) { k = { t: frameStart(t), cx, cut: true }; S.crop.keys.push(k); }
        k.cx = cx;
      } else S.crop.cx = cx;
      render();
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); changed(); pane(); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

  // ---------- Arrastrar fotos y logos sobre el resultado ----------
  out.onpointerdown = e => {
    const b = out.getBoundingClientRect(), px = (e.clientX - b.left) / b.width, py = (e.clientY - b.top) / b.height, tc = vid.currentTime - S.start;
    const hit = [...S.overlays].reverse().find(o => { const im = ovImage(o); if (!im?.naturalWidth) return false; if (tc < (o.from || 0) || (o.to > (o.from || 0) && tc > o.to)) return false;
      const hw = o.w / 2, hh = o.w * im.naturalHeight / im.naturalWidth * (out.width / out.height) / 2; return Math.abs(px - o.x) < hw && Math.abs(py - o.y) < hh; });
    if (!hit) return;
    e.preventDefault(); const x0 = hit.x, y0 = hit.y;
    const move = ev => { hit.x = Math.max(0, Math.min(1, x0 + (ev.clientX - e.clientX) / b.width)); hit.y = Math.max(0, Math.min(1, y0 + (ev.clientY - e.clientY) / b.height)); render(); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); changed(); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

  // ---------- Paneles ----------
  let tab = 0;
  const opt = (o, v) => Object.entries(o).map(([k, l]) => `<option value="${k}" ${k === String(v) ? 'selected' : ''}>${l}</option>`).join('');
  const pane = () => {
    const P2 = $e('#pane');
    if (tab === 0) P2.innerHTML = `
      <h4>▾ Formato</h4><select data-s="format">${opt(Object.fromEntries(Object.entries(FORMATS).map(([k, v]) => [k, v[0]])), S.format)}</select>
      <div class="row"><span class="small" style="width:70px">Plantilla</span><select data-s="layout" style="flex:1">${opt({ crop: 'Normal (recorte que llena la pantalla)', split: '◫ Pantalla dividida (dos recuadros)', gaming: '🎮 Gaming (cámara arriba, juego abajo)', blur: 'Vídeo completo con fondo difuminado' }, ['blur', 'gaming', 'split'].includes(S.layout) ? S.layout : 'crop')}</select></div>
      ${S.layout === 'split' ? '<div class="small muted">En el original hay dos recuadros: el <b>verde</b> es la parte de arriba y el <b>azul</b> la de abajo. Arrástralos y usa la esquina para cambiar su tamaño.</div>' : ''}
      ${S.layout === 'gaming' ? `<div class="small muted">${d.facecam ? '✓ Cámara del jugador detectada.' : 'La cámara se detecta sola al exportar.'} En el original, el recuadro es la cámara: arrástralo para moverlo y usa la esquina para ajustar su tamaño.</div>
        ${S.facecamSet ? '<button class="btn sm" id="camAuto">↺ Volver a la detección automática</button>' : ''}` : ''}
      ${S.layout === 'gaming' || S.layout === 'split' ? '' : `<div class="row"><span class="small" style="width:70px">Zoom</span><input type="range" data-s="zoom" min="1" max="3" step="0.05" value="${S.crop.zoom}" style="flex:1"><span class="small" style="width:44px">${Math.round(S.crop.zoom * 100)} %</span></div>
      <h4>▾ Seguir cara</h4><select data-s="mode">${opt({ face: 'Sí, automático (sigue a quien habla)', fixed: 'No (encuadre fijo)', manual: 'Manual (fotogramas clave)' }, S.crop.mode)}</select>
      <div class="small ${S.crop.mode === 'fixed' ? 'warn-txt' : 'muted'}">${S.crop.mode === 'face' ? (d.autoKeys ? '✓ Encuadre automático detectado con IA local.' : 'Aún no hay seguimiento calculado: se calcula al exportar.') : S.crop.mode === 'fixed' ? '⚠ Encuadre fijo (no sigue a nadie). Arrastra el recuadro del original para moverlo.' : 'Arrastra el recuadro del original en distintos momentos: cada posición crea un fotograma clave (◆). Doble clic en un ◆ de la línea de tiempo para borrarlo.'}</div>
      ${S.crop.mode === 'manual' ? `<div class="stack" style="gap:4px">${[...S.crop.keys].sort((a, b) => a.t - b.t).map(k => `<div class="row small" style="gap:6px"><a href="#" data-goto="${k.t}">◆ ${fmtT(k.t)}</a><span class="muted">${Math.round(k.cx * 100)} %</span>
        <label class="check" style="margin:0"><input type="checkbox" data-cut="${k.t}" ${k.cut ? 'checked' : ''}> corte seco</label><button class="btn sm" data-delkey="${k.t}">✕</button></div>`).join('') || '<div class="small muted">Sin fotogramas clave.</div>'}
        <button class="btn sm" id="addkey">＋ Fotograma clave aquí</button></div>` : ''}
`}
      ${S.layout === 'blur' ? '<div class="small muted">Con fondo difuminado se ve el vídeo entero (no hay recorte).</div>' : ''}`;
    else if (tab === 1) {
      const ws = clipWords();
      P2.innerHTML = `
      <h4>▾ Letra</h4>
      <select data-s="font" style="font-family:${esc(fontCss())}">${opt(d.fonts || { 'DejaVu Sans': 'Clásica' }, S.font)}</select>
      <h4>▾ Título fijo arriba <span class="small muted">(todo el clip)</span></h4>
      <label class="check"><input type="checkbox" data-s="tbshow" ${S.titleBar.show ? 'checked' : ''}> Mostrar título encima del vídeo</label>
      ${S.titleBar.show ? `<input data-s="tbtext" value="${esc(S.titleBar.text)}" placeholder="${esc(S.title || 'Título del clip')}">
      <div class="row"><span class="small" style="width:70px">Texto</span><input type="color" data-s="tbcolor" value="${S.titleBar.color}" style="width:50px;height:34px;padding:2px">
        <span class="small">Caja</span><input type="color" data-s="tbbg" value="${S.titleBar.bg === 'none' ? '#E11D48' : S.titleBar.bg}" style="width:50px;height:34px;padding:2px" ${S.titleBar.bg === 'none' ? 'disabled' : ''}>
        <label class="check" style="margin:0"><input type="checkbox" data-s="tbnobg" ${S.titleBar.bg === 'none' ? 'checked' : ''}> Sin caja</label></div>
      <div class="row"><span class="small" style="width:70px">Tamaño</span><input type="range" data-s="tbsize" min="0.6" max="1.6" step="0.05" value="${S.titleBar.size}" style="flex:1"></div>` : ''}
      <h4>▾ Subtítulos</h4>
      <label class="check"><input type="checkbox" data-s="cshow" ${S.captions.show ? 'checked' : ''}> Mostrar subtítulos</label>
      <div class="row"><span class="small" style="width:70px">Estilo</span><select data-s="cstyle" style="flex:1">${opt(Object.fromEntries(Object.entries(d.styles).map(([k, v]) => [k, v.label])), S.captions.style)}</select></div>
      <div class="row"><span class="small" style="width:70px">Tamaño</span><input type="range" data-s="csize" min="0.5" max="1.8" step="0.05" value="${S.captions.size}" style="flex:1"></div>
      <div class="row"><span class="small" style="width:70px">Posición</span><input type="range" data-s="cy" min="0.15" max="0.95" step="0.01" value="${S.captions.y}" style="flex:1"></div>
      <div class="row"><span class="small" style="width:70px">Texto</span><input type="color" data-s="ctext" value="${S.captions.textColor}" style="width:50px;height:34px;padding:2px"><span class="small muted">color del subtítulo</span></div>
      <div class="row"><span class="small" style="width:70px">Activa</span><input type="color" data-s="ccolor" value="${S.captions.color}" style="width:50px;height:34px;padding:2px">
        <label class="check" style="margin:0"><input type="checkbox" data-s="cupper" ${S.captions.upper ? 'checked' : ''}> MAYÚSCULAS</label></div>
      <div class="row"><span class="small" style="width:70px">Palabras</span><input type="number" data-s="cwpg" min="1" max="8" value="${S.captions.wpg}" style="width:70px"><span class="small muted">por subtítulo</span></div>
      <h4>▾ Gancho (4 s arriba)</h4>
      <div class="row"><input data-s="hook" value="${esc(S.hook)}" style="flex:1"><label class="check" style="margin:0"><input type="checkbox" data-s="hookOn" ${S.hookOn ? 'checked' : ''}> Mostrar</label></div>
      <label class="check"><input type="checkbox" data-s="emojis" ${S.emojis ? 'checked' : ''}> Emojis animados</label>
      <h4>▾ Mi marca</h4>
      ${BR.logoUrl || BR.frameUrl ? `<label class="check"><input type="checkbox" data-s="brand" ${S.brand ? 'checked' : ''}> Poner mi logo y marco</label>` : '<div class="small muted">Sube tu logo o marco en Convertir a Clips, Clips de directos o Multi Edit (recuadro 🎨 Mi marca).</div>'}
      <h4>▾ Transcripción del clip <span class="small muted">(clic = ir · edita o borra palabras)</span></h4>
      <div class="ed-words">${ws.map(w => `<span class="ed-w" data-wt="${w.start}"><input value="${esc(w.word)}" data-word="${w.start}" size="${Math.max(2, w.word.length)}"><button data-delw="${w.start}" title="Borrar">×</button></span>`).join('') || '<span class="small muted">Sin voz en este tramo.</span>'}</div>`;
    } else if (tab === 2) P2.innerHTML = `
      <h4>▾ Título del clip</h4><input data-s="title" value="${esc(S.title)}">
      <h4>▾ Recorte</h4>
      <div class="row"><span class="small" style="width:50px">Inicio</span><input data-s="tstart" value="${fmtT(S.start)}" style="flex:1"><button class="btn sm" data-nudge="start:-0.5">-0,5</button><button class="btn sm" data-nudge="start:0.5">+0,5</button></div>
      <div class="row"><span class="small" style="width:50px">Fin</span><input data-s="tend" value="${fmtT(S.end)}" style="flex:1"><button class="btn sm" data-nudge="end:-0.5">-0,5</button><button class="btn sm" data-nudge="end:0.5">+0,5</button></div>
      <div class="row"><button class="btn sm" id="setin">⟦ Inicio en el cabezal</button><button class="btn sm" id="setout">Fin en el cabezal ⟧</button></div>
      <div class="small muted">También puedes arrastrar los bordes verdes de la línea de tiempo.</div>
      <h4>▾ Edición automática</h4>
      <label class="check"><input type="checkbox" data-s="acRetakes" ${S.autocut.retakes ? 'checked' : ''}> ✂️ Cortar retomas y falsos comienzos (IA)</label>
      <label class="check" style="margin-left:22px"><input type="checkbox" data-s="acCondense" ${S.autocut.condense ? 'checked' : ''} ${S.autocut.retakes ? '' : 'disabled'}> Condensar ideas redundantes</label>
      <label class="check"><input type="checkbox" data-s="acSilence" ${S.autocut.silence ? 'checked' : ''}> ✂️ Cortar silencios</label>
      <div class="small muted">${d.autocut?.cuts ? `En el último render se hicieron ${d.autocut.cuts} corte(s). ` : ''}Los cortes se aplican al exportar; la vista previa muestra el tramo completo.</div>
      <h4>▾ Audio</h4><div class="small muted">El clip conserva el audio original. El volumen de abajo solo afecta a la vista previa.</div>`;
    else if (tab === 4) P2.innerHTML = `
      <h4>▾ Color</h4>
      <select data-s="grade">${opt({ '': 'Natural', vivo: 'Vivo', calido: 'Cálido', frio: 'Frío', cine: 'Cine', brillo: 'Luminoso', bn: 'Blanco y negro' }, S.grade)}</select>
      <div class="row"><span class="small" style="width:80px">Brillo</span><input type="range" data-s="adjb" min="-50" max="50" value="${S.adjust.b}" style="flex:1"><span class="small" style="width:34px">${S.adjust.b}</span></div>
      <div class="row"><span class="small" style="width:80px">Contraste</span><input type="range" data-s="adjc" min="-50" max="50" value="${S.adjust.c}" style="flex:1"><span class="small" style="width:34px">${S.adjust.c}</span></div>
      <div class="row"><span class="small" style="width:80px">Saturación</span><input type="range" data-s="adjs" min="-50" max="50" value="${S.adjust.s}" style="flex:1"><span class="small" style="width:34px">${S.adjust.s}</span></div>
      <button class="btn sm" id="adjReset">↺ Brillo, contraste y saturación a cero</button>
      <label class="check"><input type="checkbox" data-s="mirror" ${S.mirror ? 'checked' : ''}> ⇋ Espejo (voltea la imagen; los textos se ven normal)</label>
      <h4>▾ Movimiento</h4>
      <select data-s="motion">${opt({ 0: 'Sin movimiento', 3: 'Zoom suave cada 3 s', 5: 'Zoom suave cada 5 s', 8: 'Zoom suave cada 8 s' }, S.motion)}</select>
      <div class="small muted">Acerca un poco la imagen cada pocos segundos para dar ritmo (los textos no se mueven).</div>
      <h4>▾ Velocidad de la voz y del vídeo</h4>
      <div class="ed-speed">${[1, 1.1, 1.2, 1.25, 1.5].map(v => `<button class="btn sm ${S.speed === v ? 'gold' : ''}" data-speed="${v}">${v === 1 ? 'Normal' : v + 'x'}</button>`).join('')}</div>
      <div class="small muted">Más rápido = más ritmo y retención. El clip dura ${((S.end - S.start) / S.speed).toFixed(1)} s.</div>`;
    else if (tab === 5) P2.innerHTML = `
      <h4>▾ Fotos y logos <span class="small muted">(arrástralos sobre el resultado)</span></h4>
      <button class="btn sm" id="addPhoto">🖼 Añadir foto o logo</button><input type="file" id="photoFile" accept="image/png,image/jpeg,image/webp" hidden>
      <div class="small muted">Mejor PNG con fondo transparente. Se colocan encima del vídeo, por debajo de tu marca.</div>
      ${S.overlays.map((o, i) => `<div class="ed-ov"><img src="${esc(o.url || '')}"><div class="stack" style="gap:4px;flex:1">
        <div class="row"><span class="small" style="width:56px">Tamaño</span><input type="range" data-ov="${i}" data-ok="w" min="0.05" max="1" step="0.01" value="${o.w}" style="flex:1"></div>
        <div class="row small"><span>Desde ${(o.from || 0).toFixed(1)} s</span><button class="btn sm" data-ovt="${i}:from">⏱ desde aquí</button><span>Hasta ${o.to > (o.from || 0) ? o.to.toFixed(1) + ' s' : 'el final'}</span><button class="btn sm" data-ovt="${i}:to">⏱ hasta aquí</button></div>
        <div class="row"><button class="btn sm" data-ovc="${i}">Centrar</button><button class="btn sm red" data-ovx="${i}">✕ Quitar</button></div></div></div>`).join('')}
      ${S.overlays.length ? '<button class="btn sm gold" id="ovAll">📌 Poner estas fotos en TODOS los clips</button>' : ''}`;
    else P2.innerHTML = `<h4>▾ Plantillas de subtítulos</h4><div class="ed-tpl">${Object.entries(d.styles).map(([k, v]) => `<button class="ed-tplc ${S.captions.style === k ? 'on' : ''}" data-tpl="${k}"><b>${esc(v.label.split(' (')[0])}</b><span class="small muted">${esc((v.label.match(/\((.*)\)/) || [])[1] || '')}</span></button>`).join('')}</div>
      <h4>▾ Mi plantilla</h4><div class="row"><button class="btn sm" id="saveTpl">💾 Guardar estos ajustes</button><button class="btn sm" id="applyTpl">Aplicar mi plantilla</button></div>
      <div class="small muted">Guarda formato, encuadre, estilo, tamaño, posición y color de subtítulos para aplicarlos a otros clips.</div>
      <h4>▾ Aplicar a TODOS los clips de este proyecto</h4>
      <label class="check"><input type="checkbox" id="allText" checked> Letra, título fijo y subtítulos</label>
      <label class="check"><input type="checkbox" id="allLook" checked> Imagen: color, ajustes, espejo, movimiento y velocidad</label>
      <label class="check"><input type="checkbox" id="allPhotos"> Fotos y logos</label>
      <button class="btn sm gold" id="applyAll">✨ Aplicar a todos los clips</button>
      <div class="small muted">Se guardan los cambios de este clip y los demás clips se vuelven a renderizar con ese estilo.</div>`;
    bindPane();
  };
  const bindPane = () => {
    const P2 = $e('#pane');
    P2.querySelectorAll('[data-s]').forEach(el => el.oninput = el.onchange = () => {
      const v = el.type === 'checkbox' ? el.checked : el.value, k = el.dataset.s;
      if (k === 'format') { S.format = v; sizeOut(); }
      else if (k === 'layout') { S.layout = ['blur', 'gaming', 'split'].includes(v) ? v : (S.crop.mode === 'face' ? 'face' : 'crop'); if (v === 'split' && !S.facecamSet) S.facecam = { x: 0, y: 0, w: 0.5, h: 1 }; pane(); }
      else if (k === 'zoom') { S.crop.zoom = Number(v); el.nextElementSibling.textContent = Math.round(v * 100) + ' %'; }
      else if (k === 'mode') { S.crop.mode = v; if (v === 'manual' && !S.crop.keys.length) S.crop.keys = autoKeys.map(k => ({ ...k })); if (S.layout !== 'blur') S.layout = v === 'face' ? 'face' : 'crop'; pane(); }
      else if (k === 'cshow') S.captions.show = v;
      else if (k === 'cstyle') { S.captions.style = v; const s2 = d.styles[v]; S.captions.wpg = s2.wpg; S.captions.upper = s2.upper; pane(); }
      else if (k === 'csize') S.captions.size = Number(v);
      else if (k === 'cy') S.captions.y = Number(v);
      else if (k === 'ccolor') S.captions.color = v;
      else if (k === 'cupper') S.captions.upper = v;
      else if (k === 'cwpg') S.captions.wpg = Math.max(1, Math.min(8, Number(v) || 1));
      else if (k === 'hook') S.hook = v;
      else if (k === 'hookOn') S.hookOn = v;
      else if (k === 'emojis') S.emojis = v;
      else if (k === 'brand') S.brand = v;
      else if (k === 'font') { S.font = v; loadFont(v); el.style.fontFamily = fontCss(); }
      else if (k === 'tbshow') { S.titleBar.show = v; pane(); }
      else if (k === 'tbtext') S.titleBar.text = v;
      else if (k === 'tbcolor') S.titleBar.color = v;
      else if (k === 'tbbg') S.titleBar.bg = v;
      else if (k === 'tbnobg') { S.titleBar.bg = v ? 'none' : '#E11D48'; pane(); }
      else if (k === 'tbsize') S.titleBar.size = Number(v);
      else if (k === 'ctext') S.captions.textColor = v;
      else if (k === 'grade') S.grade = v;
      else if (k === 'adjb' || k === 'adjc' || k === 'adjs') { S.adjust[k.slice(3)] = Number(v); el.nextElementSibling.textContent = v; }
      else if (k === 'mirror') S.mirror = v;
      else if (k === 'motion') S.motion = Number(v);
      else if (k === 'acRetakes') { S.autocut.retakes = v; if (!v) S.autocut.condense = false; pane(); }
      else if (k === 'acCondense') S.autocut.condense = v;
      else if (k === 'acSilence') S.autocut.silence = v;
      else if (k === 'title') S.title = v;
      else if (k === 'tstart' || k === 'tend') { if (el.type !== 'checkbox' && /^\d+:\d+:\d+(\.\d+)?$/.test(v)) { const t = v.split(':').reduce((a, n) => a * 60 + Number(n), 0); if (k === 'tstart') S.start = Math.min(t, S.end - 2); else S.end = Math.max(t, S.start + 2); } }
      changed(); render();
    });
    P2.querySelectorAll('[data-goto]').forEach(a => a.onclick = e => { e.preventDefault(); vid.currentTime = Number(a.dataset.goto); });
    P2.querySelectorAll('[data-delkey]').forEach(b => b.onclick = () => { S.crop.keys = S.crop.keys.filter(k => String(k.t) !== b.dataset.delkey); changed(); pane(); render(); });
    P2.querySelectorAll('[data-cut]').forEach(b => b.onchange = () => { const k = S.crop.keys.find(k => String(k.t) === b.dataset.cut); if (k) k.cut = b.checked; changed(); });
    const ak = P2.querySelector('#addkey'); if (ak) ak.onclick = () => { S.crop.keys.push({ t: frameStart(vid.currentTime), cx: cxAt(vid.currentTime), cut: true }); changed(); pane(); render(); };
    P2.querySelectorAll('[data-word]').forEach(inp => {
      inp.onfocus = () => { vid.currentTime = Number(inp.dataset.word); };
      inp.oninput = () => { const w = S.words.find(w => String(w.start) === inp.dataset.word); if (w) { w.word = inp.value; wordsDirty = true; changed(); render(); } inp.size = Math.max(2, inp.value.length); };
    });
    P2.querySelectorAll('[data-delw]').forEach(b => b.onclick = () => { S.words = S.words.filter(w => String(w.start) !== b.dataset.delw); wordsDirty = true; changed(); pane(); render(); });
    P2.querySelectorAll('[data-tpl]').forEach(b => b.onclick = () => { S.captions.style = b.dataset.tpl; const s2 = d.styles[b.dataset.tpl]; S.captions.wpg = s2.wpg; S.captions.upper = s2.upper; changed(); pane(); render(); });
    const si = P2.querySelector('#setin'); if (si) si.onclick = () => { S.start = Math.min(vid.currentTime, S.end - 2); changed(); pane(); };
    const so = P2.querySelector('#setout'); if (so) so.onclick = () => { S.end = Math.max(vid.currentTime, S.start + 2); changed(); pane(); };
    const ca = P2.querySelector('#camAuto'); if (ca) ca.onclick = () => { S.facecamSet = false; if (d.facecam) S.facecam = { ...d.facecam }; changed(); pane(); render(); };
    const sv = P2.querySelector('#saveTpl'); if (sv) sv.onclick = () => { try { localStorage.setItem('clipTemplate', JSON.stringify({ format: S.format, layout: S.layout, crop: { mode: S.crop.mode, zoom: S.crop.zoom, cy: S.crop.cy }, captions: S.captions })); toast('Plantilla guardada', 'good'); } catch {} };
    const ap = P2.querySelector('#applyTpl'); if (ap) ap.onclick = () => { try { const t = JSON.parse(localStorage.getItem('clipTemplate') || 'null'); if (!t) return toast('Aún no has guardado una plantilla', 'bad');
      Object.assign(S, { format: t.format, layout: t.layout }); Object.assign(S.crop, t.crop); S.captions = { ...S.captions, ...t.captions }; sizeOut(); changed(); pane(); render(); } catch {} };
    P2.querySelectorAll('[data-nudge]').forEach(nudgeBtn);
    const ar = P2.querySelector('#adjReset'); if (ar) ar.onclick = () => { S.adjust = { b: 0, c: 0, s: 0 }; changed(); pane(); render(); };
    P2.querySelectorAll('[data-speed]').forEach(b => b.onclick = () => { S.speed = Number(b.dataset.speed); vid.playbackRate = S.speed; changed(); pane(); });
    // Fotos y logos
    const ap2 = P2.querySelector('#addPhoto'), pf = P2.querySelector('#photoFile');
    if (ap2) ap2.onclick = () => { pf.value = ''; pf.click(); };
    if (pf) pf.onchange = () => busy(ap2, async () => {
      const f = pf.files[0]; if (!f) return;
      const fd = new FormData(); fd.append('file', f, f.name);
      const r = await fetch('/api/upload', { method: 'POST', body: fd }).then(x => x.json());
      if (!r.ref) throw new Error(r.error || 'No se pudo subir la imagen.');
      S.overlays.push({ ref: r.ref, url: r.url, x: 0.5, y: 0.3, w: 0.35, from: 0, to: 0 }); changed(); pane(); render();
    });
    P2.querySelectorAll('[data-ok]').forEach(inp => inp.oninput = () => { S.overlays[inp.dataset.ov][inp.dataset.ok] = Number(inp.value); changed(); render(); });
    P2.querySelectorAll('[data-ovt]').forEach(b => b.onclick = () => { const [i, k] = b.dataset.ovt.split(':'); S.overlays[i][k] = Math.max(0, +(vid.currentTime - S.start).toFixed(2)); changed(); pane(); render(); });
    P2.querySelectorAll('[data-ovc]').forEach(b => b.onclick = () => { Object.assign(S.overlays[b.dataset.ovc], { x: 0.5, y: 0.5 }); changed(); render(); });
    P2.querySelectorAll('[data-ovx]').forEach(b => b.onclick = () => { S.overlays.splice(Number(b.dataset.ovx), 1); changed(); pane(); render(); });
    const applyAll = async what => {
      clearTimeout(saveT); await api(`/api/clips/${clipId}/edit`, { method: 'PUT', body: body(false) });
      const r = await api(`/api/projects/${P.id}/apply-style`, { method: 'POST', body: { clipId, what } });
      toast(`✨ Aplicado a ${r.count} clip${r.count === 1 ? '' : 's'}: se están volviendo a renderizar`, 'good'); notify();
    };
    const oa = P2.querySelector('#ovAll'); if (oa) oa.onclick = () => busy(oa, () => applyAll(['photos']));
    const aa = P2.querySelector('#applyAll'); if (aa) aa.onclick = () => busy(aa, () => applyAll([P2.querySelector('#allText').checked && 'text', P2.querySelector('#allLook').checked && 'look', P2.querySelector('#allPhotos').checked && 'photos'].filter(Boolean)));
  };
  const nudgeBtn = b => b.onclick = () => {
    const [k, v] = b.dataset.nudge.split(':');
    if (k === 'start') S.start = Math.max(WIN.from, Math.min(S.end - 2, S.start + Number(v)));
    else S.end = Math.min(WIN.to, Math.max(S.start + 2, S.end + Number(v)));
    vid.currentTime = k === 'start' ? S.start : S.end;
    changed(); if (tab === 2) pane();
  };
  main.querySelectorAll('.ed-bar [data-nudge]').forEach(nudgeBtn);
  main.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { tab = Number(b.dataset.tab); main.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('on', x === b)); pane(); });

  // ---------- Guardado automático y exportación ----------
  let saveT = null;
  const body = render => ({ start: S.start, end: S.end, title: S.title, hook: S.hook, hookOn: S.hookOn, emojis: S.emojis, brand: S.brand, autocut: S.autocut, format: S.format,
    layout: ['blur', 'gaming', 'split'].includes(S.layout) ? S.layout : S.crop.mode === 'face' ? 'face' : 'crop', crop: S.crop, captions: S.captions,
    font: S.font, titleBar: S.titleBar, grade: S.grade, adjust: S.adjust, mirror: S.mirror, motion: S.motion, speed: S.speed, overlays: S.overlays,
    ...(S.layout === 'split' ? { facecam: S.facecam, split2: S.split2 } : {}),
    ...(S.layout === 'gaming' && S.facecamSet ? { facecam: S.facecam } : {}),
    ...(wordsDirty ? { words: S.words, wordsFrom: WIN.from, wordsTo: WIN.to } : {}), render });
  const changed = (save = true) => {
    if (save) $e('#saved').textContent = 'Guardando…';
    $e('#exportInfo').textContent = `Duración ${((S.end - S.start) / S.speed).toFixed(1)} s · ${FORMATS[S.format][0].split(' (')[0]} ${FORMATS[S.format][1]}×${FORMATS[S.format][2]}`;
    if (!save) return drawTimeline();
    clearTimeout(saveT);
    saveT = setTimeout(async () => { try { await api(`/api/clips/${clipId}/edit`, { method: 'PUT', body: body(false) }); $e('#saved').textContent = '✓ Guardado'; } catch (e) { $e('#saved').textContent = '⚠ ' + e.message; } }, 1200);
    drawTimeline();
  };
  $e('#export').onclick = () => busy($e('#export'), async () => {
    clearTimeout(saveT);
    await api(`/api/clips/${clipId}/edit`, { method: 'PUT', body: body(true) });
    toast('Exportando el clip…', 'good');
    notify();
    if (window.opener) setTimeout(() => window.close(), 600); else location.hash = '#/proyecto/' + P.id;
  });

  // ---------- Reproducción ----------
  $e('#play').onclick = () => { if (vid.paused) { if (vid.currentTime < S.start || vid.currentTime >= S.end - 0.05) vid.currentTime = S.start; vid.play(); } else vid.pause(); };
  $e('#stop').onclick = () => { vid.pause(); vid.currentTime = S.start; };
  $e('#vol').oninput = e => { vid.volume = Number(e.target.value); };
  vid.onplay = () => { $e('#play').textContent = '❚❚'; loop(); };
  vid.onpause = () => { $e('#play').textContent = '▶'; };
  vid.onseeked = vid.onloadeddata = () => render();
  const loop = () => { if (!document.body.contains(vid)) return; if (!vid.paused && vid.currentTime >= S.end) { vid.pause(); vid.currentTime = S.start; } render(); if (!vid.paused) requestAnimationFrame(loop); };
  vid.addEventListener('loadedmetadata', () => { vid.currentTime = S.start; vid.playbackRate = S.speed; sizeOut(); render(); }, { once: true });
  vid.onerror = () => { $e('#orig').insertAdjacentHTML('beforeend', '<div class="err small" style="position:absolute;inset:auto 8px 8px">Este navegador no puede reproducir el vídeo original (formato). El encuadre se puede ajustar igual y verse al exportar.</div>'); };
  window.addEventListener('resize', () => { if (document.body.contains(tl)) { sizeOut(); sizeTl(); render(); } });
  // Avanzar / retroceder un fotograma (o un segundo con Mayús)
  const stepFrame = (dir, second = false) => {
    const fps = Number(P.fps) || 30;
    if (!vid.paused) vid.pause();
    const raw = vid.currentTime - OFF;                         // tiempo dentro del archivo de vídeo
    const n = Math.floor(raw * fps + 1e-3);                    // fotograma actual
    const target = second ? raw + dir : (n + dir + 0.5) / fps; // centro del fotograma siguiente/anterior
    vid.currentTime = Math.max(WIN.from, Math.min(WIN.to, OFF + target));
  };
  $e('#fprev').onclick = e => stepFrame(-1, e.shiftKey);
  $e('#fnext').onclick = e => stepFrame(1, e.shiftKey);
  window.addEventListener('keydown', function key(e) {
    if (!document.body.contains(vid)) return window.removeEventListener('keydown', key);
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    if (e.code === 'Space') { e.preventDefault(); $e('#play').click(); }
    // ← → : un fotograma atrás / adelante (mantener pulsado = varios). Mayús + ← → : un segundo
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); stepFrame(e.key === 'ArrowRight' ? 1 : -1, e.shiftKey); }
  });
  pane(); sizeOut(); sizeTl(); changed(false);
  api(`/api/projects/${P.id}/waveform?clip=${d.clip.id}&from=${WIN.from}&to=${WIN.to}&n=${Math.max(200, tl.width)}`).then(r => { peaks = r.peaks; drawTimeline(); }).catch(() => {});
}
