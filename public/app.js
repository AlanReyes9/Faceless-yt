// Clippers Pro — frontend sin dependencias (SPA con rutas por hash)
const $ = (s, el = document) => el.querySelector(s);
const main = $('#main');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mmss = t => { t = Math.max(0, t || 0); const m = Math.floor(t / 60), s = Math.floor(t % 60); return `${m}:${String(s).padStart(2, '0')}`; };
const LANGS = { es: 'Español', en: 'Inglés', pt: 'Portugués', fr: 'Francés', de: 'Alemán', it: 'Italiano' };
const LAYOUTS = { face: 'Recorte centrado en quien habla (automático)', crop: 'Recorte centrado fijo', blur: 'Fondo difuminado' };
const CAP_STYLES = { clasico: 'Clásico (palabra resaltada)', marcador: 'Marcador (palabra con fondo)', impacto: 'Impacto (grande, con pop)', minimal: 'Minimalista (discreto)' };
const opts = (obj, sel) => Object.entries(obj).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${v}</option>`).join('');
const emojisToText = list => (list || []).map(e => `${e.emoji} ${e.word}`).join(', ');

async function api(url, opts = {}) {
  const o = { ...opts, headers: { ...(opts.body && !(opts.body instanceof FormData) ? { 'content-type': 'application/json' } : {}) } };
  if (o.body && !(o.body instanceof FormData) && typeof o.body !== 'string') o.body = JSON.stringify(o.body);
  const r = await fetch(url, o);
  if (r.status === 401 && !url.includes('/login')) { location.hash = '#/login'; throw new Error('Inicia sesión'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
  return j;
}
function toast(msg, kind = '') {
  const t = document.createElement('div'); t.className = 't ' + kind; t.textContent = msg;
  $('#toast').append(t); setTimeout(() => t.remove(), kind === 'bad' ? 7000 : 3500);
}
async function busy(btn, fn) {
  const old = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> ' + old;
  try { return await fn(); } catch (e) { toast(e.message, 'bad'); } finally { btn.disabled = false; btn.innerHTML = old; }
}
const statusLabel = s => ({ pending: 'En cola', processing: 'Procesando', rendering: 'Renderizando', ready: 'Listo', error: 'Error' }[s] || s);
/** Barra de progreso con porcentaje. */
const pbar = (pct, label = '') => `<div class="pbar"><div class="pbar-top"><span>${esc(label)}</span><b>${Math.round(pct || 0)}%</b></div>
  <div class="pbar-track"><div class="pbar-fill" style="width:${Math.max(2, Math.min(100, pct || 0))}%"></div></div></div>`;
const pill = s => `<span class="pill ${s}">${['processing', 'rendering', 'pending'].includes(s) ? '<span class="spinner"></span> ' : ''}${statusLabel(s)}</span>`;

// ---------- Navegación ----------
const NAV = [
  ['ESTUDIO', [['', '⌂', 'Inicio'], ['canales', '▦', 'Mis canales'], ['videos', '▤', 'Mis vídeos'], ['calendario', '▣', 'Calendario de contenido']]],
  ['HERRAMIENTAS', [['nichos', '⌕', 'Buscador de nichos'], ['completo', '▶', 'Vídeo completo'], ['shorts', '✂', 'Convertir a Clips'], ['directo', '🔴', 'Clips de directos'], ['multiedit', '🧬', 'Multi Edit'],
    ['ranking', '🏆', 'Rankings Top'], ['miniaturas', '🖼', 'Miniaturas IA'], ['analizador', '◎', 'Analizador']]],
  ['CUENTA', [['ajustes', '⚿', 'Ajustes y claves'], ['papelera', '🗑', 'Papelera'], ['ayuda', '?', 'Ayuda']]],
  ['ADMINISTRACIÓN', [['servidor', '⚙', 'Estado del servidor']]],
];
let ME = {};
// ---------- Modo de la IA: local (en tu equipo) o nube (con tus claves), siempre visible ----------
let AIMODE = null;
const PROV = { local: 'tu equipo', gemini: 'Gemini', openai: 'OpenAI', groq: 'Groq', anthropic: 'Claude', openrouter: 'OpenRouter', pollinations: 'Pollinations' };
async function drawAiMode(force) {
  const box = $('#aimode'); if (!box) return;
  if (!AIMODE || force) AIMODE = await api('/api/ai-mode').catch(() => null);
  const m = AIMODE; if (!m) { box.innerHTML = ''; return; }
  const local = m.mode === 'local';
  box.innerHTML = `<div class="aimode ${local ? 'is-local' : 'is-cloud'}">
    ${m.localAvailable ? `<div class="seg"><button data-m="local" class="${local ? 'on' : ''}">💻 IA local</button><button data-m="cloud" class="${local ? '' : 'on'}">☁ Nube</button></div>` : '<div class="seg one"><button class="on">☁ IA en la nube</button></div>'}
    <div class="aimode-sub">${local ? 'Gratis y privada · funciona en tu equipo' : `Texto: ${PROV[m.text] || m.text} · Imágenes: ${PROV[m.image] || m.image}`}</div></div>`;
  box.querySelectorAll('[data-m]').forEach(b => b.onclick = async () => {
    const want = b.dataset.m;
    if (want === m.mode) return;
    if (want === 'cloud' && !m.cloudReady) {
      if (confirm('Para usar la IA en la nube necesitas al menos una clave (Gemini, OpenAI, Groq…). ¿Abrir Ajustes para añadirla?')) location.hash = '#/ajustes?cloud=1';
      return;
    }
    AIMODE = await api('/api/ai-mode', { method: 'POST', body: { mode: want } });
    toast(want === 'local' ? '💻 Ahora la IA funciona en tu equipo' : `☁ Ahora la IA usa la nube (${PROV[AIMODE.text] || AIMODE.text})`, 'good');
    drawAiMode();
    if (location.hash.startsWith('#/ajustes')) router();
  });
}
/** Etiqueta pequeña con dónde se ejecuta la IA (para poner junto a los botones que la usan). */
const aiTag = () => AIMODE ? `<span class="aitag ${AIMODE.mode}">${AIMODE.mode === 'local' ? '💻 IA local' : '☁ IA en la nube'}</span>` : '';
function renderNav(route) {
  drawAiMode();
  const nav = NAV.map(([h, items]) => [h, h === 'ADMINISTRACIÓN' && ME.license ? [...items, ['licencias', '🔑', 'Licencias y usuarios']] : items]);
  $('#nav').innerHTML = nav.map(([h, items]) => `<div class="nav-h">${h}</div>` + items.map(([r, ic, label]) =>
    `<a class="nav-a ${route === r ? 'active' : ''}" href="#/${r}"><span class="ic">${ic}</span>${label}</a>`).join('')).join('') +
    (ME.license && ME.admin ? `<a class="nav-a" href="#" id="logout"><span class="ic">⏻</span>Salir (${esc(ME.admin)})</a>` : '') +
    (ME.account?.username ? `<div class="small muted" style="padding:14px 10px 4px">👤 ${esc(ME.account.username)}${ME.account.expiresAt ? ` · vence ${new Date(ME.account.expiresAt).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}<br><a href="#" id="dlogout">Cerrar sesión</a></div>` : '');
  const lo = $('#logout'); if (lo) lo.onclick = async e => { e.preventDefault(); await api('/api/logout', { method: 'POST' }); location.hash = '#/login'; router(); };
  const dl = $('#dlogout'); if (dl) dl.onclick = e => { e.preventDefault(); if (confirm('¿Cerrar sesión en este equipo?')) api('/api/desktop/logout', { method: 'POST' }).catch(() => {}); };
}
$('#menuBtn').onclick = () => $('#sidebar').classList.toggle('open');

let pollTimer = null;
function poll(fn, ms = 3000) { clearTimeout(pollTimer); pollTimer = setTimeout(fn, ms); }

const routes = {};
async function router() {
  clearTimeout(pollTimer);
  document.body.classList.remove('editing');
  $('#sidebar').classList.remove('open');
  const [path, query] = location.hash.replace(/^#\/?/, '').split('?');
  const [route, arg] = path.split('/');
  const params = new URLSearchParams(query || '');
  const me = ME = await api('/api/me').catch(() => ({ authed: false, setup: [] }));
  renderNav(route === 'proyecto' ? 'videos' : route);
  if (me.blocked) return renderSetup(me.setup, me);
  if (me.needsAdmin) return renderAdminSetup();
  if (route !== 'login' && !me.authed) { location.hash = '#/login'; return; }
  main.innerHTML = '<div class="muted"><span class="spinner"></span> Cargando…</div>';
  if (!AIMODE) await drawAiMode().catch(() => {});
  try { await (routes[route] || routes[''])(arg, params); }
  catch (e) { main.innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', router);

let systemInfo = null;
const getSystem = async () => (systemInfo ||= await api('/api/system'));

/** Sube un archivo y devuelve su referencia. En Vercel va directo a Blob (archivos grandes). */
async function uploadFile(file, onProgress = () => {}) {
  const sys = await getSystem();
  // App de escritorio: el archivo ya está en el equipo → se copia directamente, sin subirlo (rápido y sin cortes)
  const local = sys.desktop && window.clippersDesktop?.pathFor?.(file);
  if (local) {
    onProgress(0);
    let id;
    try { id = (await api('/api/upload-local', { method: 'POST', body: { path: local } })).id; }
    catch (e) { console.warn('copia local:', e.message); } // si no se puede, se sube como siempre
    // Si el sistema no deja leer el archivo directamente (iCloud sin descargar, permisos de carpeta, error -81…),
    // se sube por la vía del navegador, que sí puede leerlo porque lo eligió el usuario
    if (id) try {
      for (;;) {
        await new Promise(r => setTimeout(r, 600));
        const j = await api('/api/upload-local/' + id);
        if (j.error) throw new Error(j.error);
        if (j.done) { onProgress(100); return j.ref; }
        onProgress(j.pct);
        if (j.pct === 0 && j.idleSec > 45) throw new Error('sin avance');
      }
    } catch (e) { console.warn('copia directa no disponible, se sube el archivo:', e.message); onProgress(0); }
  }
  if (sys.storage === 's3' && !sys.desktop) {
    // Subida directa al bucket (Cloudflare R2 / Backblaze B2) con una URL firmada
    const { ref, url } = await api('/api/s3/presign', { method: 'POST', body: { filename: file.name } });
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.upload.onprogress = e => onProgress(Math.round(e.loaded / e.total * 100));
      xhr.onload = () => xhr.status < 300 ? resolve() : reject(new Error(`El almacenamiento rechazó la subida (${xhr.status}). Revisa la configuración CORS del bucket en Estado del servidor.`));
      xhr.onerror = () => reject(new Error('No se pudo subir al almacenamiento. Casi siempre es la configuración CORS del bucket: pulsa "Configurar CORS" en Estado del servidor.'));
      xhr.open('PUT', url);
      xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
      xhr.send(file);
    });
    return ref;
  }
  if (sys.storage === 'blob') {
    const { upload } = await import('https://esm.sh/@vercel/blob@2.8.2/client');
    const safe = file.name.replace(/[^\w.-]+/g, '_');
    const blob = await upload(`uploads/${safe}`, file, {
      access: 'public', handleUploadUrl: '/api/blob/upload', multipart: file.size > 50e6,
      onUploadProgress: e => onProgress(Math.round(e.percentage)),
    });
    return blob.url;
  }
  return new Promise((resolve, reject) => {
    const fd = new FormData(); fd.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.upload.onprogress = e => onProgress(Math.round(e.loaded / e.total * 100));
    xhr.onload = () => { const j = JSON.parse(xhr.responseText || '{}'); xhr.status >= 400 ? reject(new Error(j.error || 'Error al subir')) : resolve(j.ref); };
    xhr.onerror = () => reject(new Error('No se pudo leer o enviar el vídeo. Si está en el Escritorio o en Documentos con iCloud, en el Finder haz clic derecho sobre el vídeo → "Descargar ahora" (o cópialo a otra carpeta, p. ej. Películas) y vuelve a intentarlo.'));
    xhr.open('POST', '/api/upload'); xhr.send(fd);
  });
}
/** Sube varios archivos mostrando el progreso en un elemento. */
async function uploadMany(files, el) {
  const refs = [];
  for (const [i, f] of [...files].entries()) refs.push(await uploadFile(f, pct => { el.textContent = `Subiendo ${i + 1}/${files.length}: ${f.name} — ${pct}%`; }));
  el.textContent = '';
  return refs;
}
const TYPE_LABEL = { shorts: '✂ Clips', live: '🔴 Directo', long: '▶ Completo', ad: '✦ Anuncio', montage: '⧉ Montaje', ranking: '🏆 Ranking' };

const channelsCache = { list: null, async get() { return this.list ||= await api('/api/channels'); }, reset() { this.list = null; } };
const channelOptions = (list, sel, empty = 'Sin canal') => `<option value="">${empty}</option>` + list.map(c => `<option value="${c.id}" ${c.id == sel ? 'selected' : ''}>${esc(c.name)}</option>`).join('');

// ---------- Configuración pendiente (Vercel) ----------
function renderSetup(missing, me = {}) {
  const info = {
    APP_PASSWORD: 'La contraseña con la que entrarás al estudio (elige una larga).',
    APP_SECRET: 'Clave para cifrar tus claves API: una cadena aleatoria larga, p. ej. el resultado de <code>openssl rand -hex 32</code>.',
    DATABASE_URL: 'Se crea sola al conectar una base de datos <b>Neon</b> en la pestaña Storage del proyecto.',
    BLOB_READ_WRITE_TOKEN: 'Se crea sola al conectar un <b>Blob store</b> en la pestaña Storage.',
    ALMACENAMIENTO: 'Dónde se guardan los vídeos. Recomendado (gratis): <b>Cloudflare R2</b> con las variables <code>S3_ENDPOINT</code>, <code>S3_BUCKET</code>, <code>S3_ACCESS_KEY_ID</code> y <code>S3_SECRET_ACCESS_KEY</code> (ver Ayuda). También sirve un Blob store de Vercel.',
  };
  main.innerHTML = `<div class="card stack" style="max-width:640px;margin:60px auto">
    <h1>Casi listo 🔧</h1><p class="sub">Por seguridad, el estudio no se abre hasta completar la configuración en Vercel.</p>
    <ol class="stack">${missing.map(k => `<li><b><code>${k}</code></b><div class="muted">${info[k] || ''}</div></li>`).join('')}</ol>
    <p class="small muted">En Vercel: Project → <b>Settings → Environment Variables</b> (y <b>Storage</b> para Neon y Blob). Después pulsa <b>Redeploy</b> en el último despliegue.</p>
    <p class="small">Motor de vídeo (ffmpeg): ${me.ffmpeg ? '✅ funcionando' : '⚠ no disponible'} · Detector de caras: ${me.faces ? '✅ funcionando' : '⚠ no disponible'}</p></div>`;
}

// ---------- Login ----------
/** Primer administrador del sistema de licencias (solo si aún no hay ninguno). */
function renderAdminSetup() {
  main.innerHTML = `<div class="card stack" style="max-width:440px;margin:60px auto">
    <h1>🔑 Crear administrador</h1><p class="sub" style="margin:0">El acceso a Clippers Pro ahora es solo para usuarios autorizados. Crea tu cuenta de administrador: con ella entrarás aquí y gestionarás los usuarios y sus equipos.</p>
    <form id="f" class="stack">
      <div><label>Código de configuración <span class="muted">(ADMIN_SETUP_CODE o APP_SECRET del servidor)</span></label><input type="password" name="appSecret" autocomplete="off" required></div>
      <div><label>Usuario</label><input name="username" autocomplete="username" required></div>
      <div><label>Contraseña <span class="muted">(mín. 10 caracteres)</span></label><input type="password" name="password" autocomplete="new-password" minlength="10" required></div>
      <button class="btn gold block">Crear administrador y entrar</button></form></div>`;
  $('#f').onsubmit = e => { e.preventDefault(); busy(e.target.querySelector('button'), async () => {
    await api('/api/license/setup', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
    toast('Administrador creado', 'good'); location.hash = '#/licencias'; router();
  }); };
}

routes.login = () => {
  if (ME.license) {
    main.innerHTML = `<div class="card stack" style="max-width:380px;margin:80px auto">
      <h1>Entrar</h1><p class="sub" style="margin:0">Acceso solo para administradores. Los suscriptores usan la app de escritorio.</p>
      <form id="f" class="stack"><input name="username" placeholder="Usuario" autocomplete="username" autofocus><input type="password" name="password" placeholder="Contraseña" autocomplete="current-password"><button class="btn gold block">Entrar</button></form>
      <a href="#" id="forgot" class="small">¿Olvidaste tu contraseña?</a>
      <form id="rf" class="stack" hidden><div class="small muted">Escribe tu usuario de administrador, el código de recuperación (variable <code>ADMIN_RESET_CODE</code> en Vercel) y tu nueva contraseña. Cada código sirve una sola vez.</div>
        <input name="username" placeholder="Usuario administrador" autocomplete="username"><input name="code" placeholder="Código de recuperación" autocomplete="off">
        <input type="password" name="password" placeholder="Nueva contraseña (mín. 10)" autocomplete="new-password" minlength="10"><button class="btn gold block">Cambiar contraseña y entrar</button></form></div>`;
    $('#forgot').onclick = e => { e.preventDefault(); $('#rf').hidden = false; $('#forgot').hidden = true; };
    $('#rf').onsubmit = e => { e.preventDefault(); busy(e.target.querySelector('button'), async () => {
      await api('/api/license/reset', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      toast('Contraseña cambiada', 'good'); location.hash = '#/'; router();
    }); };
    $('#f').onsubmit = e => { e.preventDefault(); busy(e.target.querySelector('button'), async () => {
      await api('/api/license/admin-login', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      location.hash = '#/'; router();
    }); };
    return;
  }
  main.innerHTML = `<div class="card" style="max-width:360px;margin:80px auto">
    <h1>Entrar</h1><p class="sub">Introduce la contraseña de tu estudio.</p>
    <form id="f" class="stack"><input type="password" name="password" placeholder="Contraseña" autofocus><button class="btn gold block">Entrar</button></form></div>`;
  $('#f').onsubmit = async e => {
    e.preventDefault();
    try { await api('/api/login', { method: 'POST', body: { password: e.target.password.value } }); location.hash = '#/'; }
    catch (err) { toast(err.message, 'bad'); }
  };
};

// ---------- Inicio ----------
routes[''] = async () => {
  const [s, sys, settings] = await Promise.all([api('/api/stats'), getSystem(), api('/api/settings')]);
  const v = settings.values;
  const local = v.llm_provider === 'local';
  const hasLLM = local || v[v.llm_provider + '_key'];
  const steps = [
    ...(local ? [[!!sys.localReady, 'Descarga los modelos de IA locales (una sola vez)', 'ajustes']] : [[!!hasLLM, `Añade tu clave de IA de texto (${v.llm_provider})`, 'ajustes'],
      [v.transcribe_provider === 'local' || !!(v.transcribe_provider === 'groq' ? v.groq_key : v.openai_key), 'Elige cómo transcribir (OpenAI o Groq)', 'ajustes']]),
    [s.channels > 0, 'Crea tu primer canal', 'canales'],
    [s.shorts > 0, 'Convierte un vídeo largo en clips', 'shorts'],
  ];
  main.innerHTML = `
    <h1>Hola 👋</h1><p class="sub">${local ? 'Tu fábrica de clips con IA que funciona en tu propio equipo: sin claves, sin pagar por uso.' : 'Tu fábrica de contenido faceless con tus propias claves de IA.'}</p>
    ${!sys.ffmpeg ? '<div class="card err" style="margin-bottom:16px">ffmpeg no está instalado en el servidor. Sin él no se pueden renderizar vídeos.</div>' : ''}
    ${sys.vercel && sys.db !== 'postgres' ? '<div class="card err" style="margin-bottom:16px">⚠ No hay base de datos conectada: los datos se perderán. En Vercel abre el proyecto → <b>Storage</b> → conecta una base de datos <b>Neon</b> y vuelve a desplegar.</div>' : ''}
    ${sys.vercel && sys.storage === 'local' ? '<div class="card err" style="margin-bottom:16px">⚠ No hay almacenamiento de archivos: configura <b>Cloudflare R2</b> (ver Ayuda) o conecta un Blob store en Vercel → Storage.</div>' : ''}
    <div class="grid g4" style="margin-bottom:16px">
      <div class="card"><div class="muted small">Canales</div><div class="stat">${s.channels}</div></div>
      <div class="card"><div class="muted small">Proyectos</div><div class="stat">${s.projects}</div></div>
      <div class="card"><div class="muted small">Clips listos</div><div class="stat">${s.shorts}</div></div>
      <div class="card"><div class="muted small">Publicados</div><div class="stat">${s.published}</div></div>
    </div>
    <div class="grid g2">
      <div class="card"><h2>Primeros pasos</h2>${steps.map(([ok, t, r]) => `<div style="display:flex;gap:10px;padding:6px 0"><span>${ok ? '✅' : '⬜'}</span><a href="#/${r}" style="color:${ok ? 'var(--muted)' : 'var(--text)'}">${t}</a></div>`).join('')}
        <div class="row" style="margin-top:14px"><a class="btn gold" href="#/shorts">✂ Convertir a Clips</a><a class="btn" href="#/completo">▶ Vídeo completo</a></div></div>
      <div class="card"><h2>Próximas publicaciones</h2>${s.upcoming.length ? s.upcoming.map(i => `<div class="row between" style="padding:5px 0"><span>${esc(i.title)}</span><span class="muted small">${i.date}</span></div>`).join('') : '<p class="muted">Nada programado. <a href="#/calendario">Planifica tu calendario</a>.</p>'}</div>
      <div class="card" style="grid-column:1/-1"><h2>Proyectos recientes</h2>${projectTable(s.recent)}</div>
    </div>`;
};
function projectTable(rows, trash = false) {
  if (!rows.length) return '<p class="muted">Aún no hay proyectos.</p>';
  return `<table><tr><th>Proyecto</th><th>Tipo</th><th>Estado</th><th>Fecha</th><th></th></tr>${rows.map(p => `<tr>
    <td><a href="#/proyecto/${p.id}">${esc(p.title || 'Sin título')}</a>${['pending', 'processing'].includes(p.status) ? (p.type === 'live' ? `<div class="small muted" style="margin-top:4px">${esc(p.progress || '')}</div>` : `<div style="max-width:320px;margin-top:4px">${pbar(p.percent, p.progress || 'En cola…')}</div>`) : p.status === 'error' && p.error ? `<div class="err small">${esc(p.error.slice(0, 120))}</div>` : ''}</td>
    <td>${TYPE_LABEL[p.type] || p.type}${['shorts', 'live'].includes(p.type) && p.ready_clips != null ? ` (${p.ready_clips})` : ''}</td>
    <td>${pill(p.status)}</td><td class="muted small">${(p.created_at || '').slice(0, 16)}</td>
    <td style="text-align:right">${trash ? `<button class="btn sm" data-restore="${p.id}">Restaurar</button> <button class="btn sm red" data-purge="${p.id}">Borrar definitivamente</button>` : ''}</td></tr>`).join('')}</table>`;
}

// ---------- Redes sociales (Facebook, Instagram, TikTok) ----------
const NET = { facebook: { icon: '📘', name: 'Facebook' }, instagram: { icon: '📸', name: 'Instagram' }, tiktok: { icon: '🎵', name: 'TikTok' } };
const POST_ST = { scheduled: '⏰ Programado', queued: '⏳ En cola', publishing: '⬆ Publicando…', published: '✅ Publicado', scheduled_native: '⏰ Programado en Facebook', inbox: '📥 En borradores de TikTok', error: '⚠️ Error' };
async function socialSection(sys) {
  const box = $('#socialBox'); if (!box) return;
  const [st, accs, posts] = await Promise.all([api('/api/social/status'), api('/api/social/accounts'), api('/api/social/posts')]);
  box.innerHTML = `<h2>📱 Redes sociales</h2><p class="sub" style="margin-bottom:14px">Conecta tus cuentas para publicar o programar Reels de tus clips en Instagram, Facebook y TikTok.</p>
    <div class="grid g3">
      <div class="card stack"><div class="row between"><h3>📘 Facebook + 📸 Instagram</h3></div>
        <div class="small muted">Páginas de Facebook y cuentas profesionales de Instagram vinculadas a ellas.</div>
        ${st.meta ? `<a class="btn gold sm" data-conn href="/api/social/meta/auth">Conectar Facebook / Instagram</a>` : `<div class="small">Añade tu <b>Meta App ID y Secret</b> en <a href="#/ajustes">Ajustes</a> (pasos en <a href="#/ayuda">Ayuda</a>).</div>`}</div>
      <div class="card stack"><div class="row between"><h3>🎵 TikTok</h3></div>
        <div class="small muted">Sin la auditoría de TikTok los vídeos van a tus borradores (los publicas desde la app de TikTok).</div>
        ${st.tiktok ? `<a class="btn gold sm" data-conn href="/api/social/tiktok/auth">Conectar TikTok</a>` : `<div class="small">Añade tu <b>TikTok Client Key y Secret</b> en <a href="#/ajustes">Ajustes</a> (pasos en <a href="#/ayuda">Ayuda</a>).</div>`}</div>
      <div class="card stack"><h3>Cuentas conectadas</h3>${accs.length ? accs.map(a => `<div class="row between"><span>${NET[a.platform]?.icon || ''} <b>${esc(a.name)}</b> <span class="muted small">${NET[a.platform]?.name || a.platform}${a.data?.pageName ? ' · ' + esc(a.data.pageName) : ''}</span></span>
        <button class="btn sm red" data-unlink="${a.id}">✕</button></div>`).join('') : '<div class="muted small">Ninguna todavía.</div>'}</div>
    </div>
    <h3 style="margin-top:22px">Publicaciones</h3>
    <div class="card">${posts.length ? `<table><tr><th>Cuenta</th><th>Texto</th><th>Cuándo</th><th>Estado</th><th></th></tr>${posts.map(p => `<tr>
      <td>${NET[p.platform]?.icon || ''} ${esc(p.account || '—')}</td><td class="small">${esc((p.caption || '').slice(0, 70))}</td>
      <td class="small muted">${p.scheduled_at ? new Date(p.scheduled_at).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' }) : 'Ahora'}</td>
      <td class="small">${POST_ST[p.status] || p.status}${p.result_url ? ` · <a target="_blank" href="${esc(p.result_url)}">ver</a>` : ''}${p.error ? `<div class="err small">${esc(p.error.slice(0, 200))}</div>` : ''}</td>
      <td style="text-align:right">${p.status === 'error' ? `<button class="btn sm" data-pretry="${p.id}">↻</button> ` : ''}${['scheduled', 'error'].includes(p.status) ? `<button class="btn sm red" data-pdel="${p.id}">✕</button>` : ''}</td></tr>`).join('')}</table>`
      : '<div class="muted small">Aún no hay publicaciones. Usa el botón "📱 Instagram · Facebook · TikTok" de cada clip.</div>'}
      ${posts.some(p => p.status === 'scheduled' && p.platform !== 'facebook') ? '<div class="small muted" style="margin-top:8px">⏰ Instagram y TikTok se publican a la hora indicada solo si Clippers Pro está abierto en ese momento.</div>' : ''}</div>`;
  box.querySelectorAll('[data-unlink]').forEach(b => b.onclick = () => { if (confirm('¿Desconectar esta cuenta?')) busy(b, async () => { await api('/api/social/accounts/' + b.dataset.unlink, { method: 'DELETE' }); socialSection(sys); }); });
  box.querySelectorAll('[data-pdel]').forEach(b => b.onclick = () => busy(b, async () => { await api('/api/social/posts/' + b.dataset.pdel, { method: 'DELETE' }); socialSection(sys); }));
  box.querySelectorAll('[data-pretry]').forEach(b => b.onclick = () => busy(b, async () => { await api(`/api/social/posts/${b.dataset.pretry}/retry`, { method: 'POST' }); socialSection(sys); }));
  // Escritorio: el inicio de sesión se abre en el navegador; aquí se espera a que aparezcan las cuentas
  if (sys.desktop) box.querySelectorAll('[data-conn]').forEach(a => a.onclick = () => {
    a.textContent = 'Esperando…'; a.style.pointerEvents = 'none';
    toast('Se abrió tu navegador para iniciar sesión. Al terminar, vuelve aquí.', 'good');
    const n0 = accs.length; let k = 0;
    const check = async () => { if (!location.hash.startsWith('#/canales') || ++k > 100) return; const a2 = await api('/api/social/accounts').catch(() => accs); if (a2.length !== n0) { toast('Cuenta conectada', 'good'); return socialSection(sys); } setTimeout(check, 3000); };
    setTimeout(check, 3000);
  });
  if (posts.some(p => ['queued', 'publishing'].includes(p.status))) setTimeout(() => { if (location.hash.startsWith('#/canales')) socialSection(sys); }, 5000);
}
// ---------- Edición automática: retomas, silencios, volumen parejo y música de fondo ----------
/** Recuadro reutilizable (Convertir a Clips, Directos, Multi Edit). Devuelve () => opciones para la API. */
function autoEditBox(el, { retakes = true, silence = true, normalize = true, note = '' } = {}) {
  const st = { music: null, musicName: '', musicVolume: 0.18 };
  const item = (name, on, icon, title, desc, extra = '') => `<label class="ae-item"><input type="checkbox" name="${name}" ${on ? 'checked' : ''}>
    <span><b>${icon} ${title}</b><span class="small muted">${desc}</span>${extra}</span></label>`;
  el.innerHTML = `<div class="autoedit stack">
    <b>✂ Edición automática</b>
    ${item('cutRetakes', retakes, '✂️', 'Cortar retomas y falsos comienzos', 'Cuando te trabas y repites, deja solo la última toma limpia (IA).',
      `<label class="check ae-sub"><input type="checkbox" name="condense"> Condensar además ideas redundantes (más agresivo)</label>`)}
    ${item('cutSilence', silence, '✂️', 'Cortar silencios', 'Elimina los vacíos y pausas muertas para un ritmo ágil.')}
    ${item('normalize', normalize, '🔊', 'Volumen parejo', 'Iguala el volumen de todo el clip. Se respetan los colores originales.')}
    ${note ? `<div class="small muted">${note}</div>` : ''}
    <div class="ae-music"><button type="button" class="btn sm" data-mup>🎵 Agregar música de fondo (opcional)</button><span data-mname class="small"></span>
      <div class="row" data-mvol hidden><span class="small" style="width:72px">Volumen</span><input type="range" min="0.05" max="0.6" step="0.01" value="0.18" style="flex:1"><button type="button" class="btn sm" data-mdel title="Quitar música">✕</button></div>
      <div class="small muted" data-mhint hidden>La música baja sola cuando alguien habla.</div></div>
    <input type="file" accept="audio/*" hidden data-mfile></div>`;
  const $a = q => el.querySelector(q);
  const sub = $a('[name=condense]'); const syncSub = () => { sub.disabled = !$a('[name=cutRetakes]').checked; if (sub.disabled) sub.checked = false; };
  $a('[name=cutRetakes]').onchange = syncSub; syncSub();
  $a('[data-mup]').onclick = () => { $a('[data-mfile]').value = ''; $a('[data-mfile]').click(); };
  $a('[data-mfile]').onchange = async () => {
    const f = $a('[data-mfile]').files[0]; if (!f) return;
    try {
      $a('[data-mname]').textContent = 'Subiendo…';
      st.music = await uploadFile(f, pct => { $a('[data-mname]').textContent = `Subiendo… ${pct}%`; });
      st.musicName = f.name;
      $a('[data-mname]').textContent = '🎵 ' + f.name; $a('[data-mvol]').hidden = false; $a('[data-mhint]').hidden = false;
      $a('[data-mup]').textContent = '🎵 Cambiar música';
    } catch (e) { toast(e.message, 'bad'); $a('[data-mname]').textContent = ''; }
  };
  $a('[data-mvol] input').oninput = e => { st.musicVolume = Number(e.target.value); };
  $a('[data-mdel]').onclick = () => { st.music = null; $a('[data-mname]').textContent = ''; $a('[data-mvol]').hidden = true; $a('[data-mhint]').hidden = true; $a('[data-mup]').textContent = '🎵 Agregar música de fondo (opcional)'; };
  return () => ({ cutRetakes: $a('[name=cutRetakes]').checked, condense: $a('[name=condense]').checked, cutSilence: $a('[name=cutSilence]').checked,
    normalize: $a('[name=normalize]').checked, music: st.music, musicVolume: st.musicVolume });
}

// ---------- Mi marca: logo (marca de agua) y marco sobre los clips ----------
const BRAND_POS = { tl: '↖ Arriba izquierda', tc: '⬆ Arriba centro', tr: '↗ Arriba derecha', bl: '↙ Abajo izquierda', bc: '⬇ Abajo centro', br: '↘ Abajo derecha' };
/**
 * Recuadro reutilizable (Convertir a Clips, Directos, Multi Edit): sube/cambia logo y marco, con vista previa.
 * La marca se guarda para todos los proyectos; la casilla decide si se aplica a estos clips. Devuelve () => boolean.
 */
async function brandBox(el, { title = 'Poner mi logo y marco en estos clips' } = {}) {
  let B = await api('/api/brand').catch(() => ({}));
  let applyOn = null;
  const draw = () => {
    const has = B.hasLogo || B.hasFrame;
    if (applyOn == null) applyOn = has;
    el.innerHTML = `<div class="brandbox stack">
      <div class="row between"><b>🎨 Mi marca</b><label class="check" style="margin:0"><input type="checkbox" data-bapply ${applyOn ? 'checked' : ''} ${has ? '' : 'disabled'}> ${esc(title)}</label></div>
      <div class="brand-grid">
        <div class="brand-prev">${B.frameUrl ? `<img class="bp-frame" src="${esc(B.frameUrl)}">` : ''}${B.logoUrl ? `<img class="bp-logo bp-${B.pos}" src="${esc(B.logoUrl)}" style="width:${(B.size * 100).toFixed(0)}%;opacity:${B.opacity}">` : ''}<span class="bp-sub">SUBTÍTULOS</span></div>
        <div class="stack" style="gap:8px">
          <div class="row" style="gap:6px;flex-wrap:wrap">
            <button type="button" class="btn sm" data-bup="logo">🖼 ${B.hasLogo ? 'Cambiar logo' : 'Subir logo'}</button>${B.hasLogo ? '<button type="button" class="btn sm" data-bdel="logo" title="Quitar logo">✕</button>' : ''}
            <button type="button" class="btn sm" data-bup="frame">🖼 ${B.hasFrame ? 'Cambiar marco' : 'Subir marco'}</button>${B.hasFrame ? '<button type="button" class="btn sm" data-bdel="frame" title="Quitar marco">✕</button>' : ''}
          </div>
          ${B.hasLogo ? `<div class="row"><span class="small" style="width:72px">Posición</span><select data-bset="pos" style="flex:1">${Object.entries(BRAND_POS).map(([k, v]) => `<option value="${k}" ${B.pos === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
            <div class="row"><span class="small" style="width:72px">Tamaño</span><input type="range" data-bset="size" min="0.08" max="0.5" step="0.01" value="${B.size}" style="flex:1"></div>
            <div class="row"><span class="small" style="width:72px">Opacidad</span><input type="range" data-bset="opacity" min="0.2" max="1" step="0.05" value="${B.opacity}" style="flex:1"></div>` : ''}
          <div class="small muted">Logo: PNG con fondo transparente. Marco: PNG vertical (1080×1920) con el centro transparente. Se guardan para todos tus clips.</div>
        </div>
      </div>
      <input type="file" accept="image/png,image/webp,image/jpeg" hidden data-bfile></div>`;
    const file = el.querySelector('[data-bfile]');
    let which = null;
    el.querySelector('[data-bapply]').onchange = e => { applyOn = e.target.checked; };
    el.querySelectorAll('[data-bup]').forEach(b => b.onclick = () => { which = b.dataset.bup; file.value = ''; file.click(); });
    file.onchange = async () => {
      const f = file.files[0]; if (!f) return;
      try {
        toast('Subiendo ' + (which === 'logo' ? 'logo' : 'marco') + '…');
        const ref = await uploadFile(f, () => {});
        B = await api('/api/brand', { method: 'PUT', body: { [which]: ref } });
        applyOn = true; draw(); toast(which === 'logo' ? 'Logo guardado' : 'Marco guardado', 'good');
      } catch (e) { toast(e.message, 'bad'); }
    };
    el.querySelectorAll('[data-bdel]').forEach(b => b.onclick = async () => { B = await api('/api/brand', { method: 'PUT', body: { [b.dataset.bdel]: '' } }); if (!B.hasLogo && !B.hasFrame) applyOn = false; draw(); });
    let t = null;
    el.querySelectorAll('[data-bset]').forEach(inp => inp.oninput = () => {
      B[inp.dataset.bset] = inp.dataset.bset === 'pos' ? inp.value : Number(inp.value);
      const lg = el.querySelector('.bp-logo');
      if (lg) { lg.className = `bp-logo bp-${B.pos}`; lg.style.width = (B.size * 100).toFixed(0) + '%'; lg.style.opacity = B.opacity; }
      clearTimeout(t); t = setTimeout(() => api('/api/brand', { method: 'PUT', body: { [inp.dataset.bset]: inp.value } }).catch(e => toast(e.message, 'bad')), 400);
    });
  };
  draw();
  return () => !!applyOn && !!(B.hasLogo || B.hasFrame);
}

// ---------- Multi Edit: N versiones de un clip con textos, subtítulos, colores y encuadre distintos ----------
const MULTI_OPTS = [
    ['hook', '✍️ Gancho y título distintos (IA)', true],
    ['style', '🔤 Estilo de subtítulos', true],
    ['color', '🎨 Color de los subtítulos', true],
    ['position', '↕️ Posición y tamaño del texto', true],
    ['zoom', '🔍 Zoom de la imagen', true],
    ['grade', '🌈 Filtro de color', true],
    ['trim', '✂️ Empezar y acabar algo distinto (±1 s)', false],
];
function multiEditDialog(c) {
  const OPTS = MULTI_OPTS;
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal stack" style="max-width:520px"><div class="row between"><b>🧬 Multi Edit · clip #${c.idx}</b><button class="btn sm" data-close>✕</button></div>
    <div class="small muted">Crea varias versiones del clip, cada una con una combinación distinta. Ideal para subir el mismo momento a varias cuentas o probar qué versión funciona mejor.</div>
    <div><label>¿Cuántas versiones?</label><div class="row"><input type="range" id="mn" min="2" max="20" value="5" style="flex:1"><b id="mnv" style="min-width:28px;text-align:right">5</b></div></div>
    <div class="stack" style="gap:6px"><label>¿Qué cambia en cada versión?</label>
      ${OPTS.map(([k, l, on]) => `<label class="check" style="font-size:14px"><input type="checkbox" data-v="${k}" ${on ? 'checked' : ''}> ${l}</label>`).join('')}</div>
    ${c.src ? '<div class="small muted">Clip de directo: el inicio y el final se mantienen.</div>' : ''}
    <div id="mbrand"></div>
    <div class="small muted" id="mnote">Cada versión se renderiza como un clip nuevo en este proyecto (🧬 V1, V2…).</div>
    <div class="row between"><span></span><div class="row"><button class="btn gold" id="mgo">🧬 Crear 5 versiones</button><button class="btn" data-close>Cancelar</button></div></div></div>`;
  document.body.appendChild(bg);
  const $m = s => bg.querySelector(s), close = () => bg.remove();
  bg.querySelectorAll('[data-close]').forEach(b => b.onclick = close);
  let brandOn = () => false; brandBox($m('#mbrand'), { title: 'Poner mi logo y marco' }).then(f => { brandOn = f; });
  $m('#mn').oninput = () => { $m('#mnv').textContent = $m('#mn').value; $m('#mgo').textContent = `🧬 Crear ${$m('#mn').value} versiones`; };
  $m('#mgo').onclick = () => busy($m('#mgo'), async () => {
    const vary = Object.fromEntries([...bg.querySelectorAll('[data-v]')].map(i => [i.dataset.v, i.checked]));
    if (!Object.values(vary).some(Boolean)) throw new Error('Elige al menos una cosa que cambiar.');
    $m('#mnote').textContent = vary.hook ? 'La IA está escribiendo los ganchos…' : 'Creando versiones…';
    const r = await api(`/api/clips/${c.id}/multiedit`, { method: 'POST', body: { count: Number($m('#mn').value), vary, brand: brandOn() } });
    toast(`🧬 ${r.count} versiones en cola: aparecen abajo mientras se renderizan.`, 'good');
    close(); router();
  });
}

// ---------- Publicar un clip: YouTube por su API; Instagram, Facebook y TikTok en su web con el texto copiado ----------
const PUB_NETS = {
  instagram: { name: 'Instagram', icon: '📸', url: 'https://business.facebook.com/latest/reels_composer', where: 'Meta Business Suite (marca Instagram como destino)' },
  facebook: { name: 'Facebook', icon: '📘', url: 'https://business.facebook.com/latest/reels_composer', where: 'Meta Business Suite (marca tu página de Facebook)' },
  tiktok: { name: 'TikTok', icon: '🎵', url: 'https://www.tiktok.com/tiktokstudio/upload', where: 'TikTok Studio' },
};
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch {}
  const ta = document.createElement('textarea'); ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch {} ta.remove(); return ok;
}
async function publishDialog(c, p) {
  const desk = window.clippersDesktop?.dragFile ? window.clippersDesktop : null;
  const mac = /Mac/i.test(navigator.platform || navigator.userAgent), paste = mac ? '⌘V' : 'Ctrl+V';
  const langs = Object.entries(c.variants || {}).filter(([, v]) => v.url);
  const chs = (await channelsCache.get()).filter(x => x.connected);
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal stack pubm"><div class="row between"><b>📤 Publicar clip</b><button class="btn sm" data-close>✕</button></div>
    <div class="pub-grid">
      <div class="stack" style="gap:8px"><video id="pv" src="${esc(c.url)}" controls playsinline class="pub-video"></video>
        ${desk ? `<div class="pub-drag" id="pdrag" draggable="true" title="Arrástralo a la página de la red social">🎬 <b>Arrastra el vídeo</b><span class="small muted">a la página de Instagram, Facebook o TikTok</span></div>` : `<a class="btn sm" id="pdl" href="${esc(c.url)}" download>⬇ Descargar vídeo</a>`}
        ${langs.length ? `<select id="plang"><option value="">Versión original</option>${langs.map(([l]) => `<option value="${l}">${LANGS[l] || l}</option>`).join('')}</select>` : ''}
      </div>
      <div class="stack" style="gap:10px">
        <div><label>Título</label><input id="pt" maxlength="100" placeholder="Generando…"></div>
        <div><label>Descripción</label><textarea id="pd" rows="4" placeholder="Generando…"></textarea></div>
        <div><label>Hashtags</label><input id="ph" placeholder="#viral #fyp"></div>
        <div class="row between"><button class="btn sm" id="pregen">✨ Generar otro texto</button><span class="small muted" id="pcount"></span></div>
        <div class="pub-nets">
          ${Object.entries(PUB_NETS).map(([k, n]) => `<button class="btn pub-net" data-net="${k}">${n.icon} ${n.name}</button>`).join('')}
          <button class="btn pub-net" data-net="youtube">▶️ YouTube</button>
        </div>
        <div id="pinfo"></div>
      </div>
    </div></div>`;
  document.body.appendChild(bg);
  const $m = s => bg.querySelector(s), close = () => bg.remove();
  bg.querySelectorAll('[data-close]').forEach(b => b.onclick = close);
  bg.onclick = e => { if (e.target === bg) close(); };
  const lang = () => $m('#plang')?.value || '';
  const fill = x => { $m('#pt').value = x.title || ''; $m('#pd').value = x.description || ''; $m('#ph').value = x.hashtags || ''; count(); };
  const text = () => [$m('#pt').value.trim(), $m('#pd').value.trim(), $m('#ph').value.trim()].filter(Boolean).join('\n\n');
  const count = () => { const n = text().length; $m('#pcount').textContent = `${n} caracteres${n > 2200 ? ' · ⚠ Instagram admite 2200' : ''}`; };
  ['#pt', '#pd', '#ph'].forEach(s => $m(s).oninput = count);
  const save = () => api(`/api/clips/${c.id}/caption`, { method: 'PUT', body: { title: $m('#pt').value, description: $m('#pd').value, hashtags: $m('#ph').value } }).catch(() => {});
  const gen = regen => api(`/api/clips/${c.id}/caption`, { method: 'POST', body: { regen } }).then(fill);
  if (c.social?.description) fill(c.social); else gen(false).catch(e => { fill({ title: c.title, description: c.hook, hashtags: '#viral #fyp #reels' }); toast(e.message, 'bad'); });
  $m('#pregen').onclick = e => busy(e.target, () => gen(true));
  if ($m('#plang')) $m('#plang').onchange = () => { const v = c.variants[lang()]; $m('#pv').src = v?.url || c.url; if ($m('#pdl')) $m('#pdl').href = v?.url || c.url; if (v?.title && lang()) $m('#pt').value = v.title; count(); };
  // Escritorio: ruta del vídeo en el equipo (para arrastrarlo y guardarlo en Descargas)
  const localPath = async () => (await api(`/api/clips/${c.id}/localfile${lang() ? '?lang=' + lang() : ''}`).catch(() => ({}))).path;
  let dragPath = null;
  if (desk) {
    localPath().then(f => { dragPath = f; if (!f) $m('#pdrag').outerHTML = `<a class="btn sm" href="${esc(c.url)}" download>⬇ Descargar vídeo</a>`; });
    if ($m('#plang')) $m('#plang').addEventListener('change', async () => { dragPath = await localPath(); });
    $m('#pdrag').ondragstart = e => { e.preventDefault(); if (dragPath) desk.dragFile(dragPath); };
  }
  bg.querySelectorAll('[data-net]').forEach(btn => btn.onclick = () => busy(btn, async () => {
    const net = btn.dataset.net;
    bg.querySelectorAll('[data-net]').forEach(b => b.classList.toggle('gold', b === btn));
    save();
    if (net === 'youtube') return youtubePane();
    const n = PUB_NETS[net];
    const copied = await copyText(text());
    let saved = null;
    if (desk && dragPath) saved = await desk.saveToDownloads(await localPath() || dragPath, $m('#pt').value || c.title).catch(() => null);
    else { const a = document.createElement('a'); a.href = c.variants?.[lang()]?.url || c.url; a.download = ($m('#pt').value || 'clip').replace(/[\\/:*?"<>|#%]+/g, ' ').trim().slice(0, 80) + '.mp4'; document.body.appendChild(a); a.click(); a.remove(); }
    window.open(n.url, '_blank');
    $m('#pinfo').innerHTML = `<div class="card stack pub-steps"><b>${n.icon} Se abrió ${esc(n.where)}</b><ol>
      <li><b>Sube el vídeo:</b> ${desk && dragPath ? 'arrastra <b>🎬 el vídeo</b> de esta ventana a la página' : 'arrástralo desde Descargas'}${saved ? ` (también está en <b>Descargas</b>, ya se abrió la carpeta)` : ''}.</li>
      <li><b>Pega el texto</b> con <kbd>${paste}</kbd> en la descripción ${copied ? '— ya está copiado ✓' : `— <button class="btn sm" id="pcopy">📋 Copiar texto</button>`}.</li>
      <li>${net === 'tiktok' ? 'Elige portada y pulsa <b>Publicar</b> o <b>Programar</b>.' : 'Pulsa <b>Compartir ahora</b> o <b>Programar</b> y elige la fecha.'}</li></ol>
      <div class="row"><button class="btn sm" id="precopy">📋 Copiar texto otra vez</button><button class="btn sm" id="preopen">↗ Abrir la página otra vez</button></div></div>`;
    $m('#precopy').onclick = async () => { toast(await copyText(text()) ? 'Texto copiado' : 'No se pudo copiar', 'good'); };
    if ($m('#pcopy')) $m('#pcopy').onclick = $m('#precopy').onclick;
    $m('#preopen').onclick = () => window.open(n.url, '_blank');
    toast(copied ? `Texto copiado. Pégalo en ${n.name} con ${paste}.` : 'Pulsa "Copiar texto".', 'good');
  }));
  function youtubePane() {
    $m('#pinfo').innerHTML = `<div class="card stack pub-steps"><b>▶️ Publicar en YouTube (Shorts)</b>
      ${c.yt_video_id ? `<a class="small" target="_blank" href="https://youtube.com/shorts/${c.yt_video_id}">✓ Ya publicado: ver en YouTube</a>` : ''}
      ${chs.length ? `<select id="ych">${channelOptions(chs, p.channel_id, 'Elige canal')}</select>
        <select id="ypriv"><option value="public">Público</option><option value="unlisted">Oculto</option><option value="private">Privado</option></select>
        <div><label>Programar (opcional)</label><input type="datetime-local" id="yat"></div>
        <button class="btn gold" id="ygo">Publicar en YouTube</button>`
      : '<div class="small">Conecta un canal en <a href="#/canales">Mis canales</a> para publicar en YouTube desde aquí.</div>'}</div>`;
    const go = $m('#ygo'); if (!go) return;
    go.onclick = () => busy(go, async () => {
      const channel_id = $m('#ych').value; if (!channel_id) throw new Error('Elige un canal conectado a YouTube.');
      const at = $m('#yat').value;
      const r = await api(`/api/clips/${c.id}/publish`, { method: 'POST', body: { channel_id, lang: lang(), privacy: $m('#ypriv').value,
        title: $m('#pt').value || c.title, description: [$m('#pd').value.trim(), $m('#ph').value.trim()].filter(Boolean).join('\n\n'),
        publishAt: at ? new Date(at).toISOString() : undefined } });
      c.yt_video_id = r.videoId;
      toast(at ? '⏰ Programado en YouTube' : '¡Publicado en YouTube!', 'good');
      youtubePane();
    });
  }
}
/** Publicar o programar un clip/vídeo en varias redes a la vez. */
async function socialDialog({ clip_id, project_id, caption = '', langs = [] }) {
  const accs = await api('/api/social/accounts');
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal stack"><div class="row between"><b>📱 Publicar en redes</b><button class="btn sm" data-close>✕</button></div>
    ${accs.length ? `<div class="stack" style="gap:6px">${accs.map(a => `<label class="check" style="font-size:14px"><input type="checkbox" value="${a.id}" data-acc="${a.platform}" checked> ${NET[a.platform]?.icon || ''} ${esc(a.name)} <span class="muted small">· ${NET[a.platform]?.name}</span></label>`).join('')}</div>
      <div><label>Texto de la publicación (descripción y hashtags)</label><textarea id="sc" rows="4">${esc(caption)}${caption ? '\n\n' : ''}#reels #viral</textarea></div>
      ${langs.length ? `<div><label>Versión</label><select id="sl"><option value="">Original</option>${langs.map(l => `<option value="${l}">${LANGS[l] || l}</option>`).join('')}</select></div>` : ''}
      ${accs.some(a => a.platform === 'tiktok') ? `<div><label>TikTok</label><select id="stt"><option value="draft">Enviar a borradores de TikTok (funciona sin auditoría)</option><option value="direct">Publicar directamente (requiere app auditada; si no, privado)</option></select></div>` : ''}
      <div><label>¿Cuándo?</label><div class="row"><select id="swhen" style="flex:1"><option value="now">Publicar ahora</option><option value="at">Programar…</option></select><input type="datetime-local" id="sat" style="flex:1" hidden></div></div>
      <div class="small muted" id="snote"></div>
      <div class="row between"><span></span><div class="row"><button class="btn gold" id="sgo">📤 Publicar</button><button class="btn" data-close>Cerrar</button></div></div>`
    : '<div class="muted">Aún no has conectado ninguna cuenta. Ve a <a href="#/canales">Mis canales → Redes sociales</a>.</div>'}</div>`;
  document.body.appendChild(bg);
  const $m = s => bg.querySelector(s), close = () => bg.remove();
  bg.querySelectorAll('[data-close]').forEach(b => b.onclick = close);
  if (!accs.length) return;
  const note = () => { const at = $m('#swhen').value === 'at'; $m('#sat').hidden = !at; $m('#sgo').textContent = at ? '⏰ Programar' : '📤 Publicar';
    $m('#snote').textContent = at ? 'Facebook programa por su cuenta. Instagram y TikTok se publican a esa hora si Clippers Pro está abierto.' : ''; };
  $m('#swhen').onchange = note;
  $m('#sgo').onclick = () => busy($m('#sgo'), async () => {
    const ids = [...bg.querySelectorAll('[data-acc]:checked')].map(i => i.value);
    if (!ids.length) throw new Error('Elige al menos una cuenta.');
    const at = $m('#swhen').value === 'at' ? $m('#sat').value : '';
    if ($m('#swhen').value === 'at' && !at) throw new Error('Elige la fecha y hora.');
    await api('/api/social/posts', { method: 'POST', body: { clip_id, project_id, accounts: ids, caption: $m('#sc').value, lang: $m('#sl')?.value || '', tiktokMode: $m('#stt')?.value, at: at ? new Date(at).toISOString() : undefined } });
    toast(at ? '⏰ Programado. Lo verás en Mis canales → Publicaciones.' : '📤 Publicando… El estado aparece en Mis canales → Publicaciones.', 'good');
    close();
  });
}

// ---------- Canales ----------
routes.canales = async (_, params) => {
  if (params.get('ok')) toast(params.get('ok') === '1' ? 'Canal conectado con YouTube' : params.get('ok'), 'good');
  if (params.get('error')) toast(params.get('error'), 'bad');
  channelsCache.reset();
  const [list, sys] = await Promise.all([channelsCache.get(), getSystem()]);
  main.innerHTML = `<h1>Mis canales</h1><p class="sub">Cada canal tiene su nicho e idioma. Conéctalo a YouTube para publicar desde aquí.</p>
    ${!sys.youtube ? '<div class="card small" style="margin-bottom:16px">Para publicar en YouTube añade tu <b>Google OAuth Client ID y Secret</b> en <a href="#/ajustes">Ajustes y claves</a> (ver <a href="#/ayuda">Ayuda</a>).</div>' : ''}
    <div class="grid g3">
      ${list.map(c => `<div class="card stack" data-id="${c.id}">
        <div class="row between"><h3>${esc(c.name)}</h3>${c.connected ? '<span class="pill ready">YouTube ✓</span>' : '<span class="pill">Sin conectar</span>'}</div>
        <div class="muted small">${esc(c.niche || 'Sin nicho')} · ${LANGS[c.language] || c.language}${c.yt_title ? ' · ' + esc(c.yt_title) : ''}</div>
        <div class="row">${c.connected ? `<button class="btn sm" data-disc>Desconectar</button>` : `<a class="btn sm gold" href="/api/youtube/auth?channel=${c.id}">Conectar YouTube</a>`}
          <button class="btn sm" data-edit>Editar</button><button class="btn sm red" data-del>Eliminar</button></div></div>`).join('')}
      <form class="card stack" id="newch"><h3 id="fh">Nuevo canal</h3><input type="hidden" name="id">
        <div><label>Nombre</label><input name="name" required placeholder="Ej: Historias GTA"></div>
        <div><label>Nicho</label><input name="niche" placeholder="Ej: gameplay GTA con narración"></div>
        <div><label>Idioma</label><select name="language">${Object.entries(LANGS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
        <div><label>Notas de estilo (opcional)</label><textarea name="notes" placeholder="Tono, público, formato…"></textarea></div>
        <button class="btn gold">Guardar canal</button></form></div>
    <div id="socialBox" style="margin-top:28px"></div>`;
  socialSection(sys);
  // App de escritorio: el inicio de sesión de Google se abre en el navegador; aquí se espera a que termine
  if (sys.desktop) main.querySelectorAll('a[href^="/api/youtube/auth"]').forEach(a => a.onclick = e => {
    const id = a.closest('[data-id]').dataset.id;
    a.textContent = 'Esperando a Google…'; a.style.pointerEvents = 'none';
    toast('Se abrió tu navegador para iniciar sesión con Google. Al terminar, vuelve aquí.', 'good');
    let n = 0;
    const check = async () => {
      if (!location.hash.startsWith('#/canales') || ++n > 100) return;
      channelsCache.reset();
      const c = (await channelsCache.get().catch(() => [])).find(x => String(x.id) === id);
      if (c?.connected) { toast('Canal conectado con YouTube', 'good'); return router(); }
      setTimeout(check, 3000);
    };
    setTimeout(check, 3000);
  });
  const f = $('#newch');
  f.onsubmit = async e => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(f));
    try { await api('/api/channels' + (d.id ? '/' + d.id : ''), { method: d.id ? 'PUT' : 'POST', body: d }); toast('Canal guardado', 'good'); router(); }
    catch (err) { toast(err.message, 'bad'); }
  };
  main.querySelectorAll('[data-id]').forEach(el => {
    const id = el.dataset.id, c = list.find(x => x.id == id);
    $('[data-del]', el).onclick = async () => { if (confirm('¿Eliminar el canal?')) { await api('/api/channels/' + id, { method: 'DELETE' }); router(); } };
    $('[data-edit]', el).onclick = () => { for (const k of ['id', 'name', 'niche', 'language', 'notes']) f[k].value = c[k] || ''; $('#fh').textContent = 'Editar canal'; f.scrollIntoView({ behavior: 'smooth' }); };
    const d = $('[data-disc]', el); if (d) d.onclick = async () => { await api(`/api/channels/${id}/disconnect`, { method: 'POST' }); router(); };
  });
};

// ---------- Mis vídeos / Papelera ----------
routes.videos = async () => {
  const rows = await api('/api/projects');
  main.innerHTML = `<div class="row between"><div><h1>Mis vídeos</h1><p class="sub">Todos tus proyectos de clips y vídeos completos.</p></div>
    <div class="row"><a class="btn gold" href="#/shorts">✂ Nuevos clips</a><a class="btn" href="#/completo">▶ Nuevo vídeo</a></div></div>
    <div class="card">${projectTable(rows)}</div>`;
  if (rows.some(p => ['pending', 'processing'].includes(p.status))) poll(router, 4000);
};
routes.papelera = async () => {
  const rows = await api('/api/projects?trash=1');
  main.innerHTML = `<h1>Papelera</h1><p class="sub">Los proyectos eliminados quedan aquí hasta que los borres definitivamente.</p><div class="card">${projectTable(rows, true)}</div>`;
  main.querySelectorAll('[data-restore]').forEach(b => b.onclick = async () => { await api(`/api/projects/${b.dataset.restore}/restore`, { method: 'POST' }); router(); });
  main.querySelectorAll('[data-purge]').forEach(b => b.onclick = async () => {
    if (confirm('Se borrarán los archivos del servidor. ¿Seguro?')) { await api(`/api/projects/${b.dataset.purge}?permanent=1`, { method: 'DELETE' }); router(); }
  });
};

// ---------- Plantillas de encuadre (se preguntan antes de crear los clips) ----------
const TEMPLATES = {
  face: { name: 'Quien habla', desc: 'Recorte vertical que sigue a la persona que habla. Podcasts, entrevistas, vlogs.', art: '<div class="tp-face"><i></i></div>' },
  gaming: { name: '🎮 Gaming', desc: 'La cámara del jugador arriba (se detecta sola) y la partida abajo, recortada al centro con todo el alto. Directos de Kick, Twitch o YouTube.', art: '<div class="tp-gaming"><div class="tp-cam"><i></i></div><div class="tp-game"></div></div>' },
  crop: { name: 'Recorte centrado', desc: 'Recorte vertical fijo del centro de la imagen.', art: '<div class="tp-crop"></div>' },
  blur: { name: 'Fondo difuminado', desc: 'El vídeo entero en el centro con el fondo difuminado.', art: '<div class="tp-blur"><div></div></div>' },
};
/** Pregunta qué plantilla usar. Devuelve la clave elegida o null si se cancela. */
function pickTemplate() {
  let last = 'face'; try { last = localStorage.getItem('clipLayout') || 'face'; } catch {}
  return new Promise(resolve => {
    const bg = document.createElement('div'); bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal stack" style="width:min(860px,96vw)"><div class="row between"><b>¿Qué plantilla usamos para los clips?</b><button class="btn sm" data-x>✕</button></div>
      <div class="tp-grid">${Object.entries(TEMPLATES).map(([k, t]) => `<button class="tp-card ${k === last ? 'on' : ''}" data-k="${k}"><div class="tp-art">${t.art}</div><b>${t.name}</b><span class="small muted">${t.desc}</span></button>`).join('')}</div>
      <div class="row between"><span class="small muted">Puedes cambiarla después en el editor de cada clip.</span><div class="row"><button class="btn" data-x>Cancelar</button><button class="btn gold" id="tpGo">✂ Crear clips</button></div></div></div>`;
    document.body.appendChild(bg);
    let sel = last;
    const done = v => { bg.remove(); if (v) { try { localStorage.setItem('clipLayout', v); } catch {} } resolve(v); };
    bg.querySelectorAll('[data-x]').forEach(b => b.onclick = () => done(null));
    bg.querySelectorAll('[data-k]').forEach(b => { b.onclick = () => { sel = b.dataset.k; bg.querySelectorAll('[data-k]').forEach(x => x.classList.toggle('on', x === b)); }; b.ondblclick = () => done(b.dataset.k); });
    bg.querySelector('#tpGo').onclick = () => done(sel);
  });
}

// ---------- Convertir a Clips ----------
routes.shorts = async () => {
  const [chs, sys] = await Promise.all([channelsCache.get(), getSystem()]);
  main.innerHTML = `<h1>Convertir a Clips</h1><p class="sub">Sube un vídeo largo. La IA lo transcribe, encuentra los mejores momentos y crea clips verticales con gancho y subtítulos.</p>
  <form id="f" class="grid g2">
    <div class="card stack">
      <h2>1. Vídeo de origen</h2>
      <div class="drop" id="drop"><div style="font-size:30px">⬆</div><b>Arrastra tu vídeo aquí</b><div class="muted small">o haz clic para elegirlo (mp4, mov, mkv…)</div><div id="fname" class="small" style="margin-top:8px;color:var(--gold)"></div></div>
      <input type="file" name="video" accept="video/*" hidden>
      ${sys.ytdlp ? `<button type="button" class="btn block" id="linkBtn">🔗 Descargar desde un link (YouTube, Twitch, Kick, TikTok…)</button>`
        : `<div class="small muted">Descargar desde enlaces: ${sys.vercel ? 'disponible en la app de escritorio' : 'yt-dlp no está instalado en el servidor'}.</div>`}
      <input type="hidden" name="url"><input type="hidden" name="source"><input type="hidden" name="filename">
      <div id="dlready" hidden></div>
      <div><label>Título del proyecto (opcional)</label><input name="title"></div>
      <div><label>Canal</label><select name="channel_id">${channelOptions(chs)}</select></div>
    </div>
    <div class="card stack">
      <h2>2. Opciones</h2>
      <div class="row"><div style="flex:1"><label>Nº de clips</label><input type="number" name="count" value="10" min="1" max="30"></div>
        <div style="flex:1"><label>Duración mín. (s)</label><input type="number" name="minSec" value="20" min="5"></div>
        <div style="flex:1"><label>Duración máx. (s)</label><input type="number" name="maxSec" value="60" min="10" max="180"></div></div>
      <div class="row"><input type="hidden" name="layout" value="face">
        <div style="flex:1"><label>Estilo de subtítulos</label><select name="captionStyle">${opts(CAP_STYLES, 'impacto')}</select></div></div>
      <div class="row"><div style="flex:1"><label>Idioma del audio</label><select name="language"><option value="">Detectar automáticamente</option>${Object.entries(LANGS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
        <div style="flex:1"><label>Idioma de títulos y ganchos</label><select name="titleLanguage"><option value="">Igual que el vídeo</option>${Object.entries(LANGS).map(([k, v]) => `<option value="${v}">${v}</option>`).join('')}</select></div></div>
      <label class="check"><input type="checkbox" name="captions" checked> Subtítulos palabra a palabra</label>
      <label class="check"><input type="checkbox" name="emojis" checked> Emojis animados y palabras clave resaltadas</label>
      <div id="autoedit"></div>
      <div id="brand"></div>
      <div id="up" class="small muted"></div>
      <div class="row between"><span class="small muted">Se analiza con</span>${aiTag()}</div>
      <button class="btn gold block" id="go">✂ Crear clips</button>
    </div>
  </form>
  <h2 style="margin-top:28px">Proyectos de clips</h2><div id="list" class="card"></div>`;
  const f = $('#f'), file = f.video, drop = $('#drop');
  drop.onclick = () => file.click();
  const clearLink = () => { f.source.value = ''; f.filename.value = ''; $('#dlready').hidden = true; $('#dlready').innerHTML = ''; };
  file.onchange = () => { $('#fname').textContent = file.files[0]?.name || ''; if (file.files[0]) clearLink(); };
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); file.files = e.dataTransfer.files; file.onchange(); };
  f.onsubmit = async e => {
    e.preventDefault();
    if (!file.files[0] && !f.url.value && !f.source.value) return toast('Sube un vídeo o descárgalo desde un link', 'bad');
    const layout = await pickTemplate(); if (!layout) return;
    f.layout.value = layout;
    const go = $('#go'); go.disabled = true;
    try {
      const d = Object.fromEntries(new FormData(f)); delete d.video;
      if (!d.source) { delete d.source; delete d.filename; }
      d.captions = f.captions.checked; d.emojis = f.emojis.checked; d.brand = brandOn(); Object.assign(d, autoOpts());
      if (file.files[0]) { d.source = await uploadFile(file.files[0], pct => { $('#up').textContent = `Subiendo… ${pct}%`; }); d.filename = file.files[0].name; }
      const r = await api('/api/shorts', { method: 'POST', body: d });
      location.hash = '#/proyecto/' + r.id;
    } catch (err) { toast(err.message, 'bad'); go.disabled = false; $('#up').textContent = ''; }
  };
  const autoOpts = autoEditBox($('#autoedit'));
  const brandOn = await brandBox($('#brand'));
  const lb = $('#linkBtn');
  // Descargar desde un link: la ventana solo descarga; al terminar el vídeo queda cargado aquí
  if (lb) lb.onclick = () => linkDialog(dl => {
    file.value = ''; $('#fname').textContent = '';
    f.source.value = dl.ref; f.filename.value = (dl.title || 'video') + '.mp4';
    if (!f.title.value) f.title.value = dl.title || '';
    const box = $('#dlready');
    box.innerHTML = `<div class="card" style="padding:10px;border-color:var(--gold)"><div class="row between"><b class="small">✅ Vídeo descargado y listo</b><button type="button" class="btn sm" id="dlx">Quitar</button></div>
      ${dl.url ? `<video src="${esc(dl.url)}" controls preload="metadata" style="width:100%;max-height:220px;border-radius:6px;margin-top:8px;background:#000"></video>` : ''}
      <div class="small" style="margin-top:6px">${esc(dl.title || '')}</div><div class="small muted">Elige las opciones y pulsa <b>✂ Crear clips</b>.</div></div>`;
    box.hidden = false;
    $('#dlx').onclick = clearLink;
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    toast('Vídeo descargado. Pulsa "Crear clips" cuando quieras.', 'good');
  });
  const list = await api('/api/projects?type=shorts');
  $('#list').innerHTML = projectTable(list);
};

// ---------- Multi Edit: subir un vídeo y sacar varias versiones distintas ----------
routes.multiedit = async () => {
  const [chs, sys] = await Promise.all([channelsCache.get(), getSystem()]);
  main.innerHTML = `<h1>🧬 Multi Edit</h1><p class="sub">Sube un vídeo (por ejemplo un clip o un Reel ya hecho) y crea varias versiones distintas: otro gancho, otros subtítulos, colores, zoom y filtro en cada una. Ideal para publicar el mismo vídeo en varias cuentas o probar qué versión funciona mejor.</p>
  <form id="f" class="grid g2">
    <div class="card stack">
      <h2>1. Vídeo</h2>
      <div class="drop" id="drop"><div style="font-size:30px">⬆</div><b>Arrastra tu vídeo aquí</b><div class="muted small">o haz clic para elegirlo (mp4, mov…). Mejor vídeos cortos: hasta 3 minutos.</div><div id="fname" class="small" style="margin-top:8px;color:var(--gold)"></div></div>
      <input type="file" name="video" accept="video/*" hidden>
      ${sys.ytdlp ? `<button type="button" class="btn block" id="linkBtn">🔗 Descargar desde un link</button>` : ''}
      <input type="hidden" name="source"><input type="hidden" name="filename">
      <div id="dlready" hidden></div>
      <div><label>Nombre (opcional)</label><input name="title"></div>
      <div><label>Canal</label><select name="channel_id">${channelOptions(chs)}</select></div>
    </div>
    <div class="card stack">
      <h2>2. Versiones</h2>
      <div><label>¿Cuántas versiones?</label><div class="row"><input type="range" name="count" min="2" max="20" value="5" style="flex:1"><b id="cnt" style="min-width:28px;text-align:right">5</b></div></div>
      <div class="stack" style="gap:6px"><label>¿Qué cambia en cada versión?</label>
        ${MULTI_OPTS.map(([k, l, on]) => `<label class="check" style="font-size:14px"><input type="checkbox" data-v="${k}" ${on ? 'checked' : ''}> ${l}</label>`).join('')}</div>
      <div><label>Encuadre</label><select name="layout">
        <option value="crop">Recorte al centro (o el vídeo ya es vertical)</option><option value="face">Seguir a quien habla</option>
        <option value="blur">Vídeo entero con fondo difuminado</option><option value="gaming">🎮 Gaming (cámara arriba, partida abajo)</option></select></div>
      <div class="row"><div style="flex:1"><label>Subtítulos (estilo base)</label><select name="captionStyle">${opts(CAP_STYLES, 'impacto')}</select></div>
        <div style="flex:1"><label>Idioma del audio</label><select name="language"><option value="">Detectar</option>${Object.entries(LANGS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div></div>
      <label class="check"><input type="checkbox" name="captions" checked> Añadir subtítulos palabra a palabra (si el vídeo ya los tiene, desmárcalo)</label>
      <div id="autoedit"></div>
      <div id="brand"></div>
      <div id="up" class="small muted"></div>
      <div class="row between"><span class="small muted">Ganchos y subtítulos con</span>${aiTag()}</div>
      <button class="btn gold block" id="go">🧬 Crear 5 versiones</button>
    </div>
  </form>
  <h2 style="margin-top:28px">Proyectos de Multi Edit</h2><div id="list" class="card"></div>`;
  const f = $('#f'), file = f.video, drop = $('#drop');
  f.count.oninput = () => { $('#cnt').textContent = f.count.value; $('#go').textContent = `🧬 Crear ${f.count.value} versiones`; };
  const autoOpts = autoEditBox($('#autoedit'), { retakes: false, silence: false });
  const brandOn = await brandBox($('#brand'), { title: 'Poner mi logo y marco en las versiones' });
  drop.onclick = () => file.click();
  const clearLink = () => { f.source.value = ''; f.filename.value = ''; $('#dlready').hidden = true; $('#dlready').innerHTML = ''; };
  file.onchange = () => { $('#fname').textContent = file.files[0]?.name || ''; if (file.files[0]) clearLink(); };
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); file.files = e.dataTransfer.files; file.onchange(); };
  f.onsubmit = async e => {
    e.preventDefault();
    if (!file.files[0] && !f.source.value) return toast('Sube un vídeo', 'bad');
    const vary = Object.fromEntries([...f.querySelectorAll('[data-v]')].map(i => [i.dataset.v, i.checked]));
    if (!Object.values(vary).some(Boolean)) return toast('Elige al menos una cosa que cambiar', 'bad');
    const go = $('#go'); go.disabled = true;
    try {
      const d = { title: f.title.value, channel_id: f.channel_id.value, count: Number(f.count.value), vary, layout: f.layout.value,
        captionStyle: f.captionStyle.value, language: f.language.value, captions: f.captions.checked, brand: brandOn(), ...autoOpts(), source: f.source.value, filename: f.filename.value };
      if (file.files[0]) { d.source = await uploadFile(file.files[0], pct => { $('#up').textContent = `Subiendo… ${pct}%`; }); d.filename = file.files[0].name; }
      const r = await api('/api/multiedit', { method: 'POST', body: d });
      location.hash = '#/proyecto/' + r.id;
    } catch (err) { toast(err.message, 'bad'); go.disabled = false; $('#up').textContent = ''; }
  };
  const lb = $('#linkBtn');
  if (lb) lb.onclick = () => linkDialog(dl => {
    file.value = ''; $('#fname').textContent = '';
    f.source.value = dl.ref; f.filename.value = (dl.title || 'video') + '.mp4';
    if (!f.title.value) f.title.value = dl.title || '';
    const box = $('#dlready');
    box.innerHTML = `<div class="card" style="padding:10px;border-color:var(--gold)"><div class="row between"><b class="small">✅ Vídeo descargado y listo</b><button type="button" class="btn sm" id="dlx">Quitar</button></div>
      ${dl.url ? `<video src="${esc(dl.url)}" controls preload="metadata" style="width:100%;max-height:220px;border-radius:6px;margin-top:8px;background:#000"></video>` : ''}</div>`;
    box.hidden = false; $('#dlx').onclick = clearLink;
  });
  $('#list').innerHTML = projectTable(await api('/api/projects?type=shorts&multi=1'));
};

// ---------- Clips de un directo ----------
routes.directo = async () => {
  const [chs, sys] = await Promise.all([channelsCache.get(), getSystem()]);
  main.innerHTML = `<h1>🔴 Clips de directos</h1><p class="sub">Pega el enlace de un directo. La app lo va grabando por segmentos, la IA analiza cada uno y crea clips verticales de los momentos más virales mientras el directo sigue en marcha.</p>
  ${sys.vercel ? `<div class="card warn" style="margin-bottom:16px">En la versión de Vercel solo funcionan enlaces directos <b>.m3u8</b> (HLS). Para directos de YouTube, Twitch o Kick instala la app en tu PC con Linux (ver Ayuda): allí yt-dlp obtiene el vídeo del directo.</div>`
    : sys.ytdlp ? '' : '<div class="card warn" style="margin-bottom:16px">yt-dlp no está instalado: solo funcionarán enlaces .m3u8, rtmp, srt o rtsp.</div>'}
  <form id="f" class="grid g2">
    <div class="card stack">
      <h2>1. Directo</h2>
      <div><label>Enlace del directo <span class="muted">— YouTube, Twitch, Kick o .m3u8</span></label><input name="url" required placeholder="${sys.vercel ? 'https://…/playlist.m3u8' : 'https://www.youtube.com/watch?v=… · twitch.tv/… · kick.com/… · .m3u8'}"></div>
      <div><label>Título del proyecto (opcional)</label><input name="title"></div>
      <div><label>Canal</label><select name="channel_id">${channelOptions(chs)}</select></div>
      <div class="row"><div style="flex:1"><label>Grabar como máximo (min)</label><input type="number" name="maxMinutes" value="120" min="5" max="600"></div>
        <div style="flex:1" data-auto hidden><label>Analizar cada (s)</label><select name="segmentSec"><option value="60">1 min (clips antes)</option><option value="120" selected>2 min (recomendado)</option><option value="180">3 min (más contexto)</option></select></div></div>
      <div><label>¿Cuándo se hacen los clips?</label><select name="clipMode">
        <option value="manual" selected>Cuando yo pulse «✂ Hacer clips» (graba seguido; recomendado)</option>
        <option value="auto">Automáticamente cada pocos minutos</option></select>
        <div class="small muted" data-mhelp>Se graba sin parar. Cada vez que pulses <b>✂ Hacer clips</b>, la IA saca los mejores momentos de lo grabado desde la vez anterior y sigue grabando.</div></div>
    </div>
    <div class="card stack">
      <h2>2. Opciones de los clips</h2>
      <div class="row"><div style="flex:1"><label>Nota viral mínima</label><select name="minScore">${[9, 8, 7, 6, 5].map(n => `<option value="${n}" ${n === 7 ? 'selected' : ''}>${n}/10${n >= 8 ? ' (solo lo mejor)' : n <= 5 ? ' (más clips)' : ''}</option>`).join('')}</select></div>
        <div style="flex:1"><label data-plabel>Clips máx. por tanda</label><input type="number" name="perSegment" value="4" min="1" max="10"></div></div>
      <div class="row"><div style="flex:1"><label>Duración mín. (s)</label><input type="number" name="minSec" value="15" min="5"></div>
        <div style="flex:1"><label>Duración máx. (s)</label><input type="number" name="maxSec" value="60" min="10" max="120"></div></div>
      <div class="row"><input type="hidden" name="layout" value="face">
        <div style="flex:1"><label>Estilo de subtítulos</label><select name="captionStyle">${opts(CAP_STYLES, 'impacto')}</select></div></div>
      <div class="row"><div style="flex:1"><label>Idioma del audio</label><select name="language"><option value="">Detectar automáticamente</option>${Object.entries(LANGS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
        <div style="flex:1"><label>Idioma de títulos y ganchos</label><select name="titleLanguage"><option value="">Igual que el vídeo</option>${Object.entries(LANGS).map(([k, v]) => `<option value="${v}">${v}</option>`).join('')}</select></div></div>
      <label class="check"><input type="checkbox" name="captions" checked> Subtítulos palabra a palabra</label>
      <label class="check"><input type="checkbox" name="emojis" checked> Emojis animados y palabras clave resaltadas</label>
      <div id="autoedit"></div>
      <div id="brand"></div>
      <div class="row between"><span class="small muted">Se analiza con</span>${aiTag()}</div>
      <button class="btn gold block" id="go">🔴 Empezar a grabar y clipear</button>
    </div>
  </form>
  <h2 style="margin-top:28px">Directos</h2><div id="list" class="card"></div>`;
  const f = $('#f');
  const autoOpts = autoEditBox($('#autoedit'), { retakes: false, silence: false, note: 'En directos de gaming, mejor sin cortar silencios: la partida sigue aunque nadie hable.' });
  const modeSync = () => { const auto = f.clipMode.value === 'auto'; f.querySelector('[data-auto]').hidden = !auto; f.querySelector('[data-mhelp]').hidden = auto; f.querySelector('[data-plabel]').textContent = auto ? 'Clips máx. por segmento' : 'Clips máx. por tanda'; };
  f.clipMode.onchange = modeSync; modeSync();
  const brandOn = await brandBox($('#brand'));
  f.onsubmit = async e => {
    e.preventDefault();
    const layout = await pickTemplate(); if (!layout) return;
    f.layout.value = layout;
    const go = $('#go'); go.disabled = true;
    try {
      const d = Object.fromEntries(new FormData(f));
      d.captions = f.captions.checked; d.emojis = f.emojis.checked; d.brand = brandOn(); Object.assign(d, autoOpts());
      const r = await api('/api/live', { method: 'POST', body: d });
      location.hash = '#/proyecto/' + r.id;
    } catch (err) { toast(err.message, 'bad'); go.disabled = false; }
  };
  $('#list').innerHTML = projectTable(await api('/api/projects?type=live'));
};

// ---------- Ventana "Descargar desde un link": info, calidad, tramo y progreso real ----------
const hhmmss = t => { t = Math.max(0, Math.round(t || 0)); return [Math.floor(t / 3600), Math.floor(t % 3600 / 60), t % 60].map(n => String(n).padStart(2, '0')).join(':'); };
const parseHms = v => String(v || '').split(':').map(Number).reduce((a, n) => a * 60 + (n || 0), 0);
function linkDialog(onDownloaded) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal stack">
    <div class="row between"><b>🔗 Descargar desde un link</b><button class="btn sm" data-close>✕</button></div>
    <div class="row" style="flex-wrap:nowrap"><input id="lu" placeholder="https://www.youtube.com/watch?v=…" style="flex:1"><button class="btn" id="lsearch">Buscar</button></div>
    <div class="small muted">Descarga solo contenido tuyo o que tengas permiso para usar: vídeos públicos de YouTube, Twitch, Kick, TikTok… (directos ya terminados incluidos); nada de contenido de pago, de miembros o privado.</div>
    <label class="check"><input type="checkbox" id="lperm"> Tengo permiso del creador para clipear este contenido</label>
    <div id="linfo" class="stack" style="gap:10px"></div>
    <div id="lprog"></div>
    <div class="row between"><button class="btn red" id="lcancel" hidden>Cancelar descarga</button><span></span>
      <div class="row"><button class="btn gold" id="lgo" disabled>⬇ Descargar</button><button class="btn" data-close>Cerrar</button></div></div>
  </div>`;
  document.body.appendChild(bg);
  const $m = s => bg.querySelector(s);
  let info = null, pid = null, timer = null; // pid = id de la descarga en curso
  const close = () => { clearTimeout(timer); if (pid) api(`/api/link/download/${pid}/cancel`, { method: 'POST' }).catch(() => {}); bg.remove(); }; // cerrar = cancelar la descarga
  bg.querySelectorAll('[data-close]').forEach(b => b.onclick = close);
  const ready = () => { $m('#lgo').disabled = !(info && $m('#lperm').checked) || !!pid; };
  $m('#lperm').onchange = ready;
  const est = () => {
    const q = info.qualities.find(x => String(x.height) === $m('#lq').value);
    if (!q?.mb) return null;
    if (!$m('#lpart').checked || !info.duration) return q.mb;
    const len = Math.max(0, parseHms($m('#lto').value) - parseHms($m('#lfrom').value));
    return Math.round(q.mb * len / info.duration);
  };
  const updEst = () => { const mb = est(); $m('#lsize').textContent = mb ? `≈ ${mb} MB` : ''; };
  $m('#lsearch').onclick = () => busy($m('#lsearch'), async () => {
    $m('#linfo').innerHTML = '<div class="muted small"><span class="spinner"></span> Buscando el vídeo…</div>';
    try {
      info = await api('/api/link/info', { method: 'POST', body: { url: $m('#lu').value.trim() } });
    } catch (e) { $m('#linfo').innerHTML = `<div class="err small">${esc(e.message)}</div>`; info = null; ready(); return; }
    const def = info.qualities.find(x => x.height === 720) || info.qualities[info.qualities.length - 1];
    $m('#linfo').innerHTML = `<div class="row" style="gap:12px;flex-wrap:nowrap">${info.thumbnail ? `<img src="${esc(info.thumbnail)}" style="width:120px;border-radius:6px">` : ''}
        <div><b style="font-size:16px">${esc(info.title)}</b><div class="small muted">${esc(info.platform)} · ${esc(info.channel)} · ⏱ ${hhmmss(info.duration)}${info.live ? ' · 🔴 en directo (usa "Clips de directos")' : ''}</div></div></div>
      <div class="row" style="flex-wrap:nowrap"><label style="margin:0;min-width:64px">Calidad</label><select id="lq" style="flex:1">${info.qualities.map(q => `<option value="${q.height}" ${q === def ? 'selected' : ''}>${q.label}</option>`).join('')}</select><span id="lsize" class="small muted" style="min-width:80px;text-align:right"></span></div>
      <label class="check"><input type="checkbox" id="lpart"> Descargar solo un tramo (si no, todo el vídeo)</label>
      <div class="row" id="lrange" style="flex-wrap:nowrap;opacity:.5"><label style="margin:0;min-width:64px">Tramo</label> de <input id="lfrom" value="00:00:00" style="width:110px"> a <input id="lto" value="${hhmmss(info.duration)}" style="width:110px"></div>`;
    $m('#lq').onchange = updEst;
    $m('#lpart').onchange = () => { $m('#lrange').style.opacity = $m('#lpart').checked ? 1 : .5; updEst(); };
    $m('#lfrom').oninput = $m('#lto').oninput = updEst;
    updEst(); ready();
  });
  $m('#lu').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); $m('#lsearch').click(); } };
  const watch = async () => {
    let d; try { d = await api('/api/link/download/' + pid); } catch { timer = setTimeout(watch, 1500); return; }
    if (d.error) { $m('#lprog').innerHTML = `<div class="err small">${esc(d.error)}</div>`; $m('#lcancel').hidden = true; pid = null; ready(); return; }
    if (d.done && d.ref) { pid = null; close(); onDownloaded({ ref: d.ref, url: d.url, title: d.title || info.title }); return; }
    $m('#lprog').innerHTML = pbar(d.pct || 0, d.text || 'Preparando la descarga…') +
      `<div class="small muted" style="margin-top:4px">${d.gotMB != null ? `${d.gotMB.toFixed(0)} MB de ~${(d.totalMB || 0).toFixed(0)} MB` : ''}${d.speed ? ' · ' + esc(String(d.speed).replace('iB', 'B')) : ''}</div>`;
    timer = setTimeout(watch, 1000);
  };
  $m('#lgo').onclick = () => busy($m('#lgo'), async () => {
    const part = $m('#lpart').checked;
    const r = await api('/api/link/download', { method: 'POST', body: { url: info.webpage || $m('#lu').value.trim(), title: info.title,
      height: Number($m('#lq').value), from: part ? parseHms($m('#lfrom').value) : 0, to: part ? parseHms($m('#lto').value) : 0, estMB: est() || 0 } });
    pid = r.id; ready();
    $m('#lcancel').hidden = false;
    $m('#lcancel').onclick = () => busy($m('#lcancel'), async () => { await api(`/api/link/download/${pid}/cancel`, { method: 'POST' }); clearTimeout(timer); $m('#lprog').innerHTML = '<div class="small muted">Descarga cancelada.</div>'; $m('#lcancel').hidden = true; pid = null; ready(); });
    watch();
  });
  setTimeout(() => $m('#lu').focus(), 50);
}

// ---------- Informe del vídeo (pestañas después del análisis) ----------
const PTABS = { clips: '✂ Clips', resumen: 'Resumen', titulos: 'Títulos', descripcion: 'Descripción', seo: 'Hashtags y SEO', capitulos: 'Capítulos', miniaturas: 'Miniaturas', mejoras: 'Mejoras', transcripcion: 'Transcripción', preguntar: 'Preguntar' };
const projTab = {};
const askHistory = {};
const copyBtn = (text, label = '📋 Copiar') => `<button class="btn sm" data-copy="${esc(text)}">${label}</button>`;
function bindCopy(root) { root.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => { navigator.clipboard?.writeText(b.dataset.copy).then(() => toast('Copiado', 'good'), () => toast('No se pudo copiar', 'bad')); }); }
async function reportTab(p, tab) {
  const pane = $('#tabpane'); if (!pane) return;
  if (tab === 'clips') { pane.innerHTML = ''; return; }
  const R = p.data.report;
  const needReport = ['resumen', 'titulos', 'descripcion', 'seo', 'capitulos', 'mejoras'].includes(tab);
  if (needReport && !R) {
    pane.innerHTML = `<div class="card stack" style="align-items:flex-start"><div>${p.status === 'processing' ? '<span class="spinner"></span> La IA está preparando el informe (títulos, descripción, SEO, capítulos y mejoras)…' : 'Aún no hay informe de este vídeo.'}</div>
      <button class="btn gold" id="mkrep">✨ Generar informe con IA</button></div>`;
    $('#mkrep').onclick = e => busy(e.target, async () => { p.data.report = await api(`/api/projects/${p.id}/report`, { method: 'POST' }); reportTab(p, tab); });
    return;
  }
  const fmtT = t => mmss(t);
  if (tab === 'resumen') {
    const vertical = (p.data.height || 0) > (p.data.width || 0);
    const full = [`${p.title}`, R.summary, '', 'TÍTULOS:', ...(R.titles || []), '', 'DESCRIPCIÓN:', R.description, '', 'HASHTAGS: ' + (R.hashtags || []).join(' '), 'ETIQUETAS: ' + (R.tags || []).join(', '), '', 'CAPÍTULOS:', ...(R.chapters || []).map(c => `${fmtT(c.t)} ${c.title}`), '', 'MEJORAS:', ...(R.improvements || []).map(m => `- ${m.area}: ${m.tip}`)].join('\n');
    pane.innerHTML = `<div class="stack">
      <div class="row">${copyBtn(full, '📋 Copiar informe completo')}</div>
      <div class="row" style="gap:8px;flex-wrap:wrap">${[`🕑 Análisis del ${new Date(p.ready_at || p.created_at).toLocaleString('es')}`, `⏱ ${mmss(p.duration || 0)}`, p.data.width ? `${p.data.width}×${p.data.height}` : '', vertical ? 'vertical' : 'horizontal', R.mood ? `🎭 ${R.mood}` : '', `${p.clips?.length || 0} clips`].filter(Boolean).map(x => `<span class="chip">${esc(x)}</span>`).join('')}</div>
      ${R.summary ? `<div class="card"><b>Resumen</b><p style="margin:6px 0 0">${esc(R.summary)}</p></div>` : ''}
      <div class="card"><b>Línea de tiempo</b>
        <div class="row small" style="gap:14px;margin:8px 0"><span><i class="lg" style="background:#2ad4e0"></i>Volumen</span><span><i class="lg" style="background:#b57bff"></i>Cambios de plano</span><span><i class="lg" style="background:#22c55e"></i>Capítulos</span><span><i class="lg" style="background:#FFD400"></i>Picos</span><span><i class="lg" style="background:rgba(42,212,224,.35)"></i>Clips</span></div>
        <div style="position:relative"><canvas id="rtl" style="width:100%;height:190px;display:block"></canvas><div id="rtip" class="rtip" hidden></div></div>
        <div class="small muted" style="margin-top:6px">Las franjas son los clips sugeridos (clic para abrir el editor); las líneas verdes, los capítulos.</div></div></div>`;
    drawReportTimeline(p);
  } else if (tab === 'titulos') {
    pane.innerHTML = `<div class="card stack">${(R.titles || []).map(t => `<div class="row between" style="border-bottom:1px solid var(--line);padding:6px 0"><span>${esc(t)} <span class="small muted">(${t.length})</span></span>${copyBtn(t)}</div>`).join('')}</div>`;
  } else if (tab === 'descripcion') {
    const chap = (R.chapters || []).map(c => `${fmtT(c.t)} ${c.title}`).join('\n');
    const desc = `${R.description || ''}\n\n${chap}\n\n${(R.hashtags || []).slice(0, 5).join(' ')}`;
    pane.innerHTML = `<div class="card stack"><textarea id="rdesc" style="min-height:300px">${esc(desc)}</textarea><div class="row">${copyBtn(desc)}<span class="small muted">Incluye capítulos y hashtags. Puedes editarla antes de copiar.</span></div></div>`;
    $('#rdesc').oninput = e => { pane.querySelector('[data-copy]').dataset.copy = e.target.value; };
  } else if (tab === 'seo') {
    pane.innerHTML = `<div class="grid g2"><div class="card stack"><b>Hashtags</b><div class="row" style="gap:6px;flex-wrap:wrap">${(R.hashtags || []).map(h => `<span class="chip">${esc(h)}</span>`).join('')}</div>${copyBtn((R.hashtags || []).join(' '), '📋 Copiar hashtags')}</div>
      <div class="card stack"><b>Etiquetas (tags de YouTube)</b><div class="row" style="gap:6px;flex-wrap:wrap">${(R.tags || []).map(h => `<span class="chip">${esc(h)}</span>`).join('')}</div>${copyBtn((R.tags || []).join(', '), '📋 Copiar etiquetas')}</div></div>`;
  } else if (tab === 'capitulos') {
    const chap = (R.chapters || []).map(c => `${fmtT(c.t)} ${c.title}`).join('\n');
    pane.innerHTML = `<div class="grid g2"><div class="card stack"><b>Capítulos de YouTube</b>${(R.chapters || []).map(c => `<div class="row"><code>${fmtT(c.t)}</code> ${esc(c.title)}</div>`).join('')}${copyBtn(chap, '📋 Copiar capítulos')}</div>
      <div class="card stack"><b>Clips</b>${(p.clips || []).map(c => `<div class="row between"><span><code>${fmtT(c.start)}–${fmtT(c.end)}</code> ${esc(c.title || '')} <span class="pill">${c.score}/10</span></span><a class="btn sm" href="#/editor/${c.id}">✏️ Editor</a></div>`).join('') || '<div class="muted small">Sin clips.</div>'}</div></div>`;
  } else if (tab === 'mejoras') {
    pane.innerHTML = `<div class="card stack">${(R.improvements || []).map(m => `<div class="row" style="align-items:flex-start;gap:10px;border-bottom:1px solid var(--line);padding:8px 0"><span class="pill">${esc(m.area)}</span><span>${esc(m.tip)}</span></div>`).join('') || '<div class="muted">Sin sugerencias.</div>'}</div>`;
  } else if (tab === 'miniaturas') {
    const draw = frames => {
      pane.innerHTML = `<div class="stack"><div class="row"><button class="btn gold" id="genth">✨ Crear miniaturas con IA</button><button class="btn" id="refr">🔎 ${frames.length ? 'Buscar otros fotogramas' : 'Buscar los mejores fotogramas'}</button></div>
        ${frames.length ? `<div class="card"><b>Mejores fotogramas para miniatura</b><div class="fr-grid">${frames.map((f, i) => `<div class="stack" style="gap:4px"><img src="${f.url}" class="fr-img"><div class="small muted"><b>${i + 1}.</b> ${mmss(f.t)} · ${f.faces} cara(s)</div><button class="btn sm" data-fthumb="${esc(f.ref)}">✎ Editar miniatura</button></div>`).join('')}</div></div>` : '<div class="muted small">Analiza el vídeo y elige los fotogramas más nítidos, con caras grandes y buena luz.</div>'}</div>`;
      $('#refr').onclick = e => busy(e.target, async () => { pane.querySelector('#refr').textContent = 'Analizando fotogramas…'; const fr = await api(`/api/projects/${p.id}/frames`, { method: 'POST' }); p.framesOut = fr; draw(fr); });
      $('#genth').onclick = e => busy(e.target, async () => { const t = await api('/api/thumbs', { method: 'POST', body: { title: (R?.titles?.[0]) || p.title, format: 'youtube', style: 'impacto' } }); location.hash = '#/miniaturas/' + t.id; });
      pane.querySelectorAll('[data-fthumb]').forEach(b => b.onclick = () => busy(b, async () => {
        const r = await api(`/api/projects/${p.id}/frame-thumb`, { method: 'POST', body: { ref: b.dataset.fthumb } });
        const words = String(R?.titles?.[0] || p.title || '').toUpperCase().split(/\s+/).slice(0, 3).join(' ');
        await api(`/api/thumbs/${r.thumbId}/generate`, { method: 'POST', body: { base: r.base, mode: 'overlay', text: words, highlight: words.split(' ').pop(), position: 'left' } });
        location.hash = '#/miniaturas/' + r.thumbId;
      }));
    };
    draw(p.framesOut || []);
  } else if (tab === 'transcripcion') {
    pane.innerHTML = '<div class="muted"><span class="spinner"></span> Cargando…</div>';
    const tr = await api(`/api/projects/${p.id}/transcript.json`);
    pane.innerHTML = `<div class="card stack"><div class="row"><a class="btn sm" href="/api/projects/${p.id}/transcript.srt" download>⬇ SRT (subtítulos)</a><a class="btn sm" href="/api/projects/${p.id}/transcript.txt" download>⬇ TXT</a>
      ${copyBtn(tr.segments.map(s => s.text).join(' '), '📋 Copiar texto')}<span class="small muted">${tr.language ? 'Idioma: ' + esc(tr.language) : ''} · ${tr.segments.length} frases</span></div>
      <div class="tr-list">${tr.segments.map(s => `<div><code>${mmss(s.start)}</code> ${esc(s.text)}</div>`).join('')}</div></div>`;
  } else if (tab === 'preguntar') {
    const hist = askHistory[p.id] ||= [];
    const drawChat = () => {
      pane.innerHTML = `<div class="card stack"><div class="small muted">Pregunta lo que quieras sobre el vídeo: "¿de qué habla en el minuto 10?", "dame 5 ideas de clips", "¿qué frase es la más polémica?"…</div>
        <div class="chat">${hist.map(m => `<div class="msg ${m.role}">${esc(m.text).replace(/\n/g, '<br>')}</div>`).join('')}</div>
        <form id="askf" class="row" style="flex-wrap:nowrap"><input id="askq" placeholder="Escribe tu pregunta…" style="flex:1"><button class="btn gold">Preguntar</button></form></div>`;
      $('#askf').onsubmit = e => { e.preventDefault(); const qv = $('#askq').value.trim(); if (!qv) return;
        busy(e.target.querySelector('button'), async () => { hist.push({ role: 'user', text: qv }); drawChat();
          try { const r = await api(`/api/projects/${p.id}/ask`, { method: 'POST', body: { question: qv, history: hist.slice(0, -1) } }); hist.push({ role: 'ai', text: r.answer }); } catch (err) { hist.push({ role: 'ai', text: '⚠ ' + err.message }); }
          drawChat(); $('#askq').focus(); }); };
      const ch = pane.querySelector('.chat'); ch.scrollTop = ch.scrollHeight;
    };
    drawChat();
  }
  bindCopy(pane);
}

function drawReportTimeline(p) {
  const cv = $('#rtl'); if (!cv) return;
  const W = cv.width = cv.clientWidth * (window.devicePixelRatio || 1), Hh = cv.height = 190 * (window.devicePixelRatio || 1), dpr = window.devicePixelRatio || 1;
  const ctx = cv.getContext('2d'), dur = p.duration || 1;
  const X = t => 10 * dpr + (t / dur) * (W - 20 * dpr), top = 20 * dpr, bottom = Hh - 30 * dpr;
  ctx.fillStyle = '#12141a'; ctx.fillRect(0, 0, W, Hh);
  // clips
  const clips = p.clips || [];
  ctx.fillStyle = 'rgba(42,212,224,.18)';
  for (const c of clips) ctx.fillRect(X(c.start), top, X(c.end) - X(c.start), bottom - top);
  // capítulos
  ctx.fillStyle = '#22c55e';
  for (const c of p.data.report?.chapters || []) ctx.fillRect(X(c.t), top, 1.5 * dpr, bottom - top);
  // cambios de plano
  ctx.fillStyle = '#b57bff';
  for (const t of p.timeline?.cuts || []) ctx.fillRect(X(t), bottom - 14 * dpr, 1.5 * dpr, 14 * dpr);
  // volumen
  const en = p.timeline?.energy || [];
  ctx.strokeStyle = '#2ad4e0'; ctx.lineWidth = 1.5 * dpr; ctx.beginPath();
  en.forEach(([t, v], i) => { const x = X(t), y = bottom - v * (bottom - top); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke();
  // picos: máximos locales más altos
  const peaks = en.map((e, i) => ({ t: e[0], v: e[1], i })).filter(e => e.v > 0.15 && e.v >= Math.max(...en.slice(Math.max(0, e.i - 8), e.i + 9).map(x => x[1]))).sort((a, b) => b.v - a.v).slice(0, 8);
  ctx.fillStyle = '#FFD400';
  for (const k of peaks) { ctx.beginPath(); ctx.arc(X(k.t), top - 8 * dpr, 4 * dpr, 0, 7); ctx.fill(); }
  // eje
  ctx.fillStyle = '#9399a6'; ctx.font = `${10 * dpr}px sans-serif`;
  for (let i = 0; i <= 6; i++) { const t = dur * i / 6; ctx.fillText(mmss(t), X(t) - (i === 6 ? 24 * dpr : 0), Hh - 10 * dpr); }
  const tip = $('#rtip');
  cv.onmousemove = e => { const t = (e.offsetX * dpr - 10 * dpr) / (W - 20 * dpr) * dur; if (t < 0 || t > dur) return (tip.hidden = true);
    const c = clips.find(c => t >= c.start && t <= c.end);
    tip.hidden = false; tip.style.left = e.offsetX + 'px'; tip.textContent = mmss(t) + (c ? ` · Clip #${c.idx}: ${c.title || ''}` : ''); cv.style.cursor = c ? 'pointer' : 'default'; };
  cv.onmouseleave = () => { tip.hidden = true; };
  cv.onclick = e => { const t = (e.offsetX * dpr - 10 * dpr) / (W - 20 * dpr) * dur; const c = clips.find(c => t >= c.start && t <= c.end); if (c) openEditorWindow(c.id); };
}

// ---------- Editor de clips (public/editor.js) ----------
routes.editor = async id => (await import('./editor.js')).openClipEditor(id, { api, esc, toast, busy, main, mmss });
// El editor se abre en una ventana aparte (como en los editores de vídeo); si el navegador la bloquea, en esta misma
function openEditorWindow(id) {
  const w = window.open(`${location.origin}${location.pathname}#/editor/${id}`, 'clip_editor_' + id, 'popup=yes,width=1440,height=900');
  if (!w) location.hash = '#/editor/' + id; else w.focus();
}
document.addEventListener('click', e => {
  const a = e.target.closest?.('a[href^="#/editor/"]');
  if (!a || document.body.classList.contains('editing')) return;
  e.preventDefault(); openEditorWindow(a.getAttribute('href').split('/').pop());
});
window.addEventListener('message', e => { if (e.origin === location.origin && e.data?.type === 'clip-saved' && location.hash.startsWith('#/proyecto/')) router(); });

// ---------- Proyecto (Shorts o completo) ----------
routes.proyecto = async id => {
  const [p, chs] = await Promise.all([api('/api/projects/' + id), channelsCache.get()]);
  const isClips = ['shorts', 'live'].includes(p.type);
  const working = ['pending', 'processing'].includes(p.status) || p.clips?.some(c => c.status === 'rendering') || (p.live && !p.live.ended);
  const head = `<div class="row between" style="margin-bottom:16px"><div><a href="#/videos" class="small">← Mis vídeos</a><h1>${esc(p.title || 'Proyecto')}</h1>
      <div class="row small muted">${pill(p.status)} ${p.duration ? '· ' + mmss(p.duration) : ''} <span class="hprog">${p.progress ? '· ' + esc(p.progress) : ''}</span></div></div>
    <div class="row">${p.live && !p.live.ended ? `<button class="btn red" id="stop" ${p.live.stopRequested ? 'disabled' : ''}>⏹ Detener directo</button>` : ''}${isClips && p.clips?.length ? `<a class="btn gold" href="/api/projects/${p.id}/zip">⬇ Descargar .zip</a>` : ''}
      ${p.status === 'error' ? '<button class="btn" id="retry">↻ Reintentar</button>' : ''}<button class="btn red" id="del">Eliminar</button></div></div>
    ${p.error ? `<div class="card err" style="margin-bottom:16px">${esc(p.error)}</div>` : ''}
    ${cleanupBanner(p)}${p.live && !p.live.ended ? `<div class="livewrap">${liveEmbed(p)}${liveBanner(p)}</div>` : liveBanner(p)}
    ${['pending', 'processing'].includes(p.status) && !p.live ? `<div class="progress stack" style="margin-bottom:16px">${pbar(p.percent, p.progress || 'Procesando…')}
      <div class="muted small">Puedes cerrar esta página: el servidor sigue trabajando. ${p.type === 'shorts' ? 'Los clips se renderizan de uno en uno.' : ''}</div></div>` : ''}`;
  const withReport = p.type === 'shorts' && p.hasTranscript;
  const tab = withReport ? (projTab[p.id] || 'clips') : 'clips';
  main.innerHTML = head + (withReport ? `<div class="ptabs">${Object.entries(PTABS).map(([k, l]) => `<button data-ptab="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}</div>` : '') +
    (isClips ? `<div id="gridwrap" ${tab !== 'clips' ? 'hidden' : ''}>${shortsGrid(p, chs)}</div><div id="tabpane"></div>` : longView(p, chs));
  if (withReport) {
    main.querySelectorAll('[data-ptab]').forEach(b => b.onclick = () => { projTab[p.id] = b.dataset.ptab; main.querySelectorAll('[data-ptab]').forEach(x => x.classList.toggle('on', x === b)); $('#gridwrap').hidden = b.dataset.ptab !== 'clips'; reportTab(p, b.dataset.ptab); });
    reportTab(p, tab);
  }
  const st = $('#stop'); if (st) st.onclick = () => { if (confirm('¿Dejar de grabar el directo? Se analizan los últimos minutos y se terminan los clips pendientes.')) busy(st, async () => { await api(`/api/projects/${p.id}/stop`, { method: 'POST' }); router(); }); };
  const r = $('#retry'); if (r) r.onclick = () => busy(r, async () => { await api(`/api/projects/${p.id}/retry`, { method: 'POST' }); router(); });
  $('#del').onclick = async () => { if (confirm('¿Mover a la papelera?')) { await api('/api/projects/' + p.id, { method: 'DELETE' }); location.hash = '#/videos'; } };
  main.querySelectorAll('[data-keep]').forEach(b => b.onclick = () => busy(b, async () => {
    await api('/api/projects/' + p.id, { method: 'PATCH', body: { keepSource: b.dataset.keep === '1' } });
    toast(b.dataset.keep === '1' ? 'El original se conservará' : 'Se borrará automáticamente', 'good'); router();
  }));
  if (isClips) bindClips(p); else bindLong(p);
  if (p.live) bindLive(p);
  if (p.cleanup?.deletedAt) main.querySelectorAll('[data-apply],[data-tr],[data-retry],#retry').forEach(b => { b.disabled = true; b.title = 'El original se borró: no se puede volver a renderizar'; });
  if (working) livePoll(p);
};

// Firma de lo que cambia la estructura de la página (si no cambia, solo se actualizan las barras)
const projSig = p => [p.status, p.error, p.output, p.data?.report?.at, p.live?.ended, p.live?.stopRequested, ...(p.clips || []).map(c => `${c.id}:${c.status}:${c.file}:${Object.keys(c.variants || {}).join(',')}`)].join('|');
function livePoll(prev) {
  const sig = projSig(prev);
  poll(async () => {
    if (!location.hash.startsWith('#/proyecto/' + prev.id)) return;
    let p;
    try { p = await api('/api/projects/' + prev.id); } catch { return livePoll(prev); }
    const editing = document.activeElement && main.contains(document.activeElement) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
    // Directo en curso: solo cambian los clips → se redibuja la cuadrícula sin recargar el reproductor del directo
    if (projSig(p) !== sig && !editing && p.live && !p.live.ended && prev.live && !prev.live.stopRequested === !p.live.stopRequested && p.status === prev.status) {
      const gw = main.querySelector('#gridwrap');
      if (gw) {
        gw.innerHTML = shortsGrid(p, await channelsCache.get()); bindClips(p);
        const lb = main.querySelector('.livebox'); if (lb && !lb.contains(document.activeElement)) { lb.outerHTML = liveBanner(p); bindLive(p); }
        return livePoll(p);
      }
    }
    if (projSig(p) !== sig && !editing) return router(); // algo terminó o cambió: redibujar
    // Solo actualizar las barras de progreso, sin tocar los vídeos que se estén viendo
    const top = main.querySelector('.progress .pbar');
    if (top) top.outerHTML = pbar(p.percent, p.progress || 'Procesando…');
    const hp = main.querySelector('.hprog');
    if (hp) hp.textContent = p.progress ? '· ' + p.progress : '';
    const lb = main.querySelector('.livebox');
    if (lb && p.live && !lb.contains(document.activeElement)) { lb.outerHTML = liveBanner(p); bindLive(p); }
    for (const c of p.clips || []) {
      const box = main.querySelector(`[data-clip="${c.id}"] .vid .pbar`);
      if (box && c.status === 'rendering') box.outerHTML = pbar(c.progress, c.stage || 'En cola…');
    }
    livePoll(projSig(p) === sig ? p : prev);
  }, 3000);
}

/** Reproductor del directo mientras se graba: el oficial de Kick, Twitch o YouTube, o HLS para enlaces .m3u8. */
function liveEmbed(p) {
  const u = p.source_url || '';
  let src = null, m;
  if ((m = u.match(/kick\.com\/([\w-]+)/i)) && !/^(video|clip)s?$/i.test(m[1])) src = `https://player.kick.com/${m[1]}?autoplay=true&muted=true`;
  else if ((m = u.match(/twitch\.tv\/([\w]+)/i)) && !/^videos?$/i.test(m[1])) src = `https://player.twitch.tv/?channel=${m[1]}&parent=${location.hostname}&muted=true&autoplay=true`;
  else if ((m = u.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|live\/|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/i))) src = `https://www.youtube.com/embed/${m[1]}?autoplay=1&mute=1`;
  const box = inner => `<div class="card liveplayer"><div class="lp-frame">${inner}</div><div class="row between small muted" style="margin-top:6px"><span>📺 El directo, en vivo</span><a href="${esc(u)}" target="_blank">Abrir en su web ↗</a></div></div>`;
  if (src) return box(`<iframe src="${esc(src)}" allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowfullscreen></iframe>`);
  if (/\.m3u8(\?|$)/i.test(u)) { setTimeout(() => playHls(`/api/projects/${p.id}/hls`), 0); return box(`<video id="lphls" muted autoplay playsinline controls></video>`); }
  return box(`<div class="lp-none">Este enlace no se puede mostrar aquí. <a href="${esc(u)}" target="_blank">Ábrelo en su web ↗</a></div>`);
}
async function playHls(url) {
  const v = document.getElementById('lphls'); if (!v) return;
  if (v.canPlayType('application/vnd.apple.mpegurl')) { v.src = url; return; }
  try {
    if (!window.Hls) await new Promise((ok, ko) => { const sc = document.createElement('script'); sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.20/hls.min.js'; sc.onload = ok; sc.onerror = ko; document.head.appendChild(sc); });
    const h = new window.Hls(); h.loadSource(url); h.attachMedia(v);
  } catch { v.outerHTML = '<div class="lp-none">No se pudo cargar el reproductor.</div>'; }
}

/** Estado de un directo: tiempo grabado, segmentos y clips. */
function liveBanner(p) {
  const l = p.live; if (!l) return '';
  const ok = (p.clips || []).filter(c => c.status === 'ready').length;
  const state = l.ended ? `⏹ Directo terminado${l.reason ? ' · ' + esc(l.reason) : ''}` : l.stopRequested ? '⏹ Deteniendo…' : '<span class="livedot"></span> Grabando en directo';
  return `<div class="card livebox" style="margin-bottom:16px"><div class="row between"><b>${state}</b><span class="muted small">${esc(p.progress || '')}</span></div>
    <div class="row" style="gap:22px;margin-top:10px"><div><div class="muted small">Grabado</div><b>${mmss(l.secs || 0)}</b></div>
      ${p.data?.options?.clipMode === 'manual' ? `<div><div class="muted small">Tandas</div><b>${l.batches || 0}</b></div>` : `<div><div class="muted small">Segmentos</div><b>${l.segs || 0}</b>${l.pending ? ` <span class="muted small">(${l.pending} analizando)</span>` : ''}</div>`}
      <div><div class="muted small">Clips listos</div><b>${ok}</b> <span class="muted small">de ${(p.clips || []).length}</span></div></div>
    ${l.stage && !l.ended ? `<div class="small" style="margin-top:10px;color:var(--gold)"><span class="spinner"></span> ${esc(l.stage)}</div>` : ''}
    ${l.warning ? `<div class="small err" style="margin-top:10px">⚠️ ${esc(l.warning)}</div>` : ''}
    ${l.ended || l.stopRequested ? '' : liveControls(p)}
    ${l.ended ? '' : `<div class="muted small" style="margin-top:8px">${p.data?.options?.clipMode === 'manual' ? 'La grabación sigue sin parar: pulsa «✂ Hacer clips» cuando quieras sacar los clips de lo grabado. Al detener el directo se hacen los del último tramo.' : 'Cada pocos minutos se analiza lo grabado y los mejores momentos aparecen abajo. Puedes cerrar esta página.'}</div>`}</div>`;
}
/** Controles del directo en curso: clip manual y ajustes que se aplican al siguiente análisis. */
function liveControls(p) {
  const o = p.data?.options || {}, l = p.live || {};
  const waiting = (l.marks || []).filter(m => !m.done).length;
  const manual = o.clipMode === 'manual';
  // tramo actual: desde la última tanda hasta ahora (lo guardado + lo que se está grabando)
  const now = l.recWall ? (l.recPos || 0) + (Date.now() - l.recWall) / 1000 : (l.secs || 0);
  const tramo = Math.max(0, now - (l.batchFromT || 0));
  const batchBox = manual ? `<div class="batch-box">
      <button class="btn gold batch-btn" data-batch ${l.batchAt ? 'disabled' : ''}>${l.batchAt ? '<span class="spinner"></span> Cortando el tramo…' : '✂ Hacer clips'}</button>
      <div class="stack" style="gap:2px"><div class="small">Tramo actual: <b data-tramo data-from="${l.batchFromT || 0}" data-pos="${l.recPos || 0}" data-wall="${l.recWall || 0}">${mmss(tramo)}</b> grabados desde ${l.batches ? 'la última tanda' : 'el inicio'}</div>
        <div class="small muted">Al pulsar, la IA saca los mejores momentos de este tramo y la grabación sigue con uno nuevo.</div>
        ${(l.batchLog || []).length ? `<div class="small muted">${l.batchLog.slice(-4).map(b => `Tanda ${b.n}: ${mmss(b.to - b.from)} → ${b.clips} clip${b.clips === 1 ? '' : 's'}`).join(' · ')}</div>` : ''}</div></div>` : '';
  return `${batchBox}<div class="live-ctl">
    <div class="stack" style="gap:6px"><div class="small muted">¿Ha pasado algo bueno?</div>
      <div class="row"><button class="btn gold" data-mark="30">✂ Clip ahora · 30 s</button><button class="btn" data-mark="60">✂ 60 s</button>
      ${waiting ? `<span class="pill">${waiting} marcado${waiting > 1 ? 's' : ''}: sale en el próximo análisis</span>` : ''}</div></div>
    <div class="row" style="gap:12px;align-items:flex-end"><div><label>Nota mínima</label><select data-lo="minScore">${[9, 8, 7, 6, 5].map(n => `<option value="${n}" ${Number(o.minScore || 7) === n ? 'selected' : ''}>${n}/10</option>`).join('')}</select></div>
      <div><label>${manual ? 'Clips máx. por tanda' : 'Clips por segmento'}</label><select data-lo="perSegment">${(manual ? [1, 2, 3, 4, 5, 6, 8, 10] : [1, 2, 3, 4, 5]).map(n => `<option ${Number(o.perSegment || 3) === n ? 'selected' : ''}>${n}</option>`).join('')}</select></div></div></div>`;
}
function bindLive(p) {
  const bb = main.querySelector('[data-batch]');
  if (bb) bb.onclick = () => busy(bb, async () => {
    await api(`/api/projects/${p.id}/make-clips`, { method: 'POST' });
    toast('✂ Cortando el tramo: los clips aparecerán abajo en cuanto la IA los elija. La grabación sigue.', 'good');
    p.live.batchAt = Date.now();
    const lb = main.querySelector('.livebox'); if (lb) { lb.outerHTML = liveBanner(p); bindLive(p); }
  });
  // contador del tramo actual en vivo
  const tr = main.querySelector('[data-tramo]');
  if (tr && !tr._t) tr._t = setInterval(() => {
    if (!document.body.contains(tr)) return clearInterval(tr._t);
    const pos = Number(tr.dataset.pos), wall = Number(tr.dataset.wall), from = Number(tr.dataset.from);
    if (wall) tr.textContent = mmss(Math.max(0, pos + (Date.now() - wall) / 1000 - from));
  }, 1000);
  main.querySelectorAll('[data-mark]').forEach(b => b.onclick = () => busy(b, async () => {
    await api(`/api/projects/${p.id}/mark`, { method: 'POST', body: { len: Number(b.dataset.mark) } });
    toast(`✂ Marcado: los últimos ${b.dataset.mark} s serán un clip`, 'good');
    p.live.marks = [...(p.live.marks || []), { done: false }];
    const lb = main.querySelector('.livebox'); if (lb) { lb.outerHTML = liveBanner(p); bindLive(p); }
  }));
  main.querySelectorAll('[data-lo]').forEach(s => s.onchange = async () => {
    await api(`/api/projects/${p.id}/live-options`, { method: 'PATCH', body: { [s.dataset.lo]: Number(s.value) } });
    (p.data.options ||= {})[s.dataset.lo] = Number(s.value);
    toast('Se aplicará en el próximo análisis', 'good');
  });
}

function shortsGrid(p, chs) {
  if (!p.clips?.length) return p.live && !p.live.ended ? '<div class="empty">Aún no hay clips: el primero aparece tras analizar el primer segmento.</div>' : p.status === 'ready' ? '<div class="empty">No se generaron clips.</div>' : '';
  return `<div class="shorts">${p.clips.map(c => {
    const dur = c.end - c.start;
    const langs = Object.entries(c.variants || {}).filter(([, v]) => v.url);
    return `<div class="clip" data-clip="${c.id}">
      <div class="vid"><button class="btn sm xbtn" data-x title="Eliminar clip">✕</button>${c.url && c.status !== 'rendering' ? `<video src="${c.url}" controls preload="metadata" playsinline></video>`
        : c.status === 'error' ? `<div class="stack" style="padding:14px;text-align:center"><div style="font-size:26px">⚠️</div><div class="err small">${esc(friendlyError(c.error))}</div>${friendlyError(c.error) !== c.error ? `<details class="small muted" style="max-height:120px;overflow:auto;text-align:left"><summary>Ver detalle técnico</summary><code style="white-space:pre-wrap;word-break:break-all">${esc(c.error)}</code></details>` : ''}<button class="btn sm gold" data-retry>↻ Reintentar</button></div>`
        : `<div style="width:80%">${pbar(c.progress, c.stage || 'En cola…')}</div>`}</div>
      <div class="body">
        <div class="row" style="gap:5px"><b>#${c.idx}</b>${c.variant_label ? `<span class="pill" title="Versión de otro clip (Multi Edit)">🧬 ${esc(c.variant_label)}</span>` : ''}<span class="pill">${c.score}/10</span><span class="pill">${c.layout === 'face' ? 'quien habla' : c.layout === 'crop' ? 'recorte fijo' : c.layout === 'gaming' ? '🎮 gaming' : 'fondo difuminado'}</span>
          ${!p.cleanup?.deletedAt ? `<a class="btn sm gold" href="#/editor/${c.id}" style="margin-left:auto">✏️ Editor</a>` : ''}</div>
        ${c.status === 'rendering' ? pill('rendering') : ''}
        <div><label>Título</label><input data-f="title" value="${esc(c.title)}"></div>
        <div><label>Frase de gancho (sale 4 s arriba)</label><input data-f="hook" value="${esc(c.hook)}"></div>
        <div class="muted" data-time>${mmss(c.start)} → ${mmss(c.end)} · ${Math.round(dur)} s</div>
        <div class="nudge"><span class="muted">Inicio</span><button class="btn" data-n="start:-1">−1 s</button><button class="btn" data-n="start:1">+1 s</button>
          <span class="muted">Fin</span><button class="btn" data-n="end:-1">−1 s</button><button class="btn" data-n="end:1">+1 s</button></div>
        <select data-f="layout" title="Encuadre">${opts(LAYOUTS, c.layout)}</select>
        <select data-f="style" title="Estilo de subtítulos">${opts(CAP_STYLES, c.style || 'clasico')}</select>
        <details><summary>✨ Palabras clave y emojis</summary><div class="stack" style="margin-top:6px">
          <div><label>Palabras resaltadas (separadas por comas)</label><input data-f="keywords" value="${esc((c.keywords || []).join(', '))}"></div>
          <div><label>Emojis: "emoji palabra", separados por comas</label><input data-f="emojis" value="${esc(emojisToText(c.emojis))}" placeholder="💰 dinero, 🚨 policía"></div>
          <div class="small muted">Se aplican al pulsar "Aplicar cambios".</div></div></details>
        <button class="btn gold" data-apply>Aplicar cambios</button>
        ${c.reason || c.signals ? `<details><summary>¿Por qué este momento?</summary><div class="muted">${esc(c.reason || '')}</div>${viralBreakdown(c.signals)}</details>` : ''}
        <details><summary>🌐 Sacarlo en otro idioma</summary><div class="stack" style="margin-top:6px">
          <select data-lang>${Object.entries(LANGS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
          <button class="btn sm" data-tr>Traducir subtítulos y gancho</button>
          ${langs.map(([l, v]) => `<a href="${v.url}" target="_blank" class="small">▶ Versión ${LANGS[l] || l}</a>`).join('<br>')}</div></details>
        <button class="btn" data-multi>🧬 Multi Edit: crear versiones</button>
        <button class="btn gold" data-publish>📤 Publicar${c.yt_video_id ? ' <span class="small">· YouTube ✓</span>' : ''}</button>
        <label class="check"><input type="checkbox" data-zip ${c.include_zip ? 'checked' : ''}> Incluir en el .zip</label>
      </div></div>`;
  }).join('')}</div>`;
}

const fmtDate = d => new Date(d).toLocaleDateString('es', { day: 'numeric', month: 'long' });
/** Aviso de borrado automático del vídeo original. */
function cleanupBanner(p) {
  const c = p.cleanup || {};
  if (c.deletedAt) return `<div class="card small" style="margin-bottom:16px">🧹 El original se borró el ${fmtDate(c.deletedAt)} para ahorrar espacio. Los vídeos terminados siguen disponibles, pero este proyecto ya no se puede volver a renderizar.</div>`;
  if (c.keep) return `<div class="card small row between" style="margin-bottom:16px"><span>📌 El original se conserva (no se borrará automáticamente).</span><button class="btn sm" data-keep="0">Permitir borrado automático</button></div>`;
  const failed = (p.clips || []).some(x => x.status === 'error');
  if (c.at && failed) return `<div class="card small" style="margin-bottom:16px">🧹 El original no se borrará mientras haya clips con error (para que puedas reintentarlos).</div>`;
  if (c.at) return `<div class="card small row between" style="margin-bottom:16px"><span>🧹 Para ahorrar espacio, el vídeo original se borrará ${new Date(c.at) <= new Date() ? '<b>en la próxima limpieza</b> (hoy)' : `el <b>${fmtDate(c.at)}</b>`}. Después no se podrán ajustar ni traducir los clips (los ya hechos se quedan).</span><button class="btn sm" data-keep="1">📌 Conservar original</button></div>`;
  return '';
}

/** Desglose de la nota viral: criterios de la IA + señales medidas. */
function viralBreakdown(sg) {
  if (!sg) return '';
  const names = { hook: 'Gancho', story: 'Historia', emotion: 'Emoción', value: 'Valor', ending: 'Final' };
  const bar = (label, v) => `<div class="row" style="gap:6px;flex-wrap:nowrap"><span style="width:70px">${label}</span><div style="flex:1;height:6px;background:var(--line);border-radius:3px"><div style="width:${v * 10}%;height:100%;background:var(--gold);border-radius:3px"></div></div><b>${v}</b></div>`;
  const tags = [sg.peaks ? `🔊 ${sg.peaks} picos de energía` : '', sg.laugh ? '😂 risas' : '', sg.cuts ? `🎬 ${sg.cuts} cambios de plano` : '', sg.rate ? `⚡ ${sg.rate} palabras/s` : ''].filter(Boolean);
  return `<div class="stack small" style="margin-top:8px">${Object.entries(sg.scores || {}).map(([k, v]) => bar(names[k] || k, v)).join('')}
    ${bar('Señales', sg.measured)}<div class="muted">IA ${sg.llm}/10 · señales medidas ${sg.measured}/10${tags.length ? ' · ' + tags.join(' · ') : ''}</div></div>`;
}

/** Mensaje de error legible para el usuario (los detalles técnicos quedan en Estado del servidor). */
function friendlyError(e = '') {
  if (/tiempo máximo|tiempo límite|agotó el tiempo/i.test(e)) return 'Tardó demasiado en renderizar. Pulsa Reintentar: se usará un modo más rápido.';
  if (/Falta la clave/i.test(e)) return e;
  if (/Stream specifier ':v'|matches no streams/i.test(e)) return 'El vídeo descargado no tiene imagen (solo audio). Pulsa "↻ Reintentar" arriba, en el proyecto: se volverá a descargar.';
  if (/ffmpeg/i.test(e)) return 'No se pudo procesar el vídeo. Pulsa Reintentar; si vuelve a fallar, prueba con otro encuadre.';
  return e.length > 160 ? e.slice(0, 160) + '…' : e || 'Error';
}

function bindClips(p) {
  main.querySelectorAll('[data-clip]').forEach(el => {
    const c = p.clips.find(x => x.id == el.dataset.clip);
    const st = { start: c.start, end: c.end };
    const upd = () => { $('[data-time]', el).textContent = `${mmss(st.start)} → ${mmss(st.end)} · ${Math.round(st.end - st.start)} s`; };
    el.querySelectorAll('[data-n]').forEach(b => b.onclick = () => {
      const [k, d] = b.dataset.n.split(':'); st[k] = Math.max(0, st[k] + Number(d));
      if (p.duration) st.end = Math.min(st.end, p.duration);
      upd();
    });
    $('[data-apply]', el).onclick = e => busy(e.target, async () => {
      await api('/api/clips/' + c.id, { method: 'PATCH', body: { ...st, title: $('[data-f=title]', el).value, hook: $('[data-f=hook]', el).value,
        layout: $('[data-f=layout]', el).value, style: $('[data-f=style]', el).value, keywords: $('[data-f=keywords]', el).value, emojis: $('[data-f=emojis]', el).value } });
      await api(`/api/clips/${c.id}/render`, { method: 'POST' });
      toast('Renderizando de nuevo…'); router();
    });
    $('[data-f=title]', el).onchange = e => api('/api/clips/' + c.id, { method: 'PATCH', body: { title: e.target.value } }).catch(err => toast(err.message, 'bad'));
    $('[data-zip]', el).onchange = e => api('/api/clips/' + c.id, { method: 'PATCH', body: { include_zip: e.target.checked } });
    const rb = $('[data-retry]', el);
    if (rb) rb.onclick = e => busy(e.target, async () => { await api(`/api/clips/${c.id}/render`, { method: 'POST' }); toast('Reintentando…'); router(); });
    $('[data-x]', el).onclick = async () => { if (confirm('¿Eliminar este clip?')) { await api('/api/clips/' + c.id, { method: 'DELETE' }); router(); } };
    $('[data-tr]', el).onclick = e => busy(e.target, async () => { await api(`/api/clips/${c.id}/translate`, { method: 'POST', body: { lang: $('[data-lang]', el).value } }); toast('Traduciendo y renderizando…'); router(); });
    $('[data-publish]', el).onclick = () => publishDialog(c, p);
    $('[data-multi]', el).onclick = () => multiEditDialog(c);
  });
}

// ---------- Vídeo completo ----------
routes.completo = async (_, params) => {
  const [chs, settings] = await Promise.all([channelsCache.get(), api('/api/settings')]);
  main.innerHTML = `<h1>Vídeo completo</h1><p class="sub">De una idea a un vídeo terminado: guion con IA → voz en off → vídeos de stock → subtítulos.</p>
  <div class="grid g2">
    <form class="card stack" id="f">
      <div><label>Tema o idea del vídeo</label><textarea name="topic" required placeholder="Ej: La historia del robo de banco más increíble de la historia"></textarea></div>
      <div class="row"><div style="flex:1"><label>Canal</label><select name="channel_id">${channelOptions(chs)}</select></div>
        <div style="flex:1"><label>Idioma</label><select name="language">${Object.entries(LANGS).map(([k, v]) => `<option value="${v}">${v}</option>`).join('')}</select></div></div>
      <div class="row"><div style="flex:1"><label>Duración (min)</label><input type="number" name="minutes" value="3" min="0.5" max="20" step="0.5"></div>
        <div style="flex:1"><label>Formato</label><select name="format"><option value="horizontal">Horizontal 16:9</option><option value="vertical">Vertical 9:16 (Short)</option></select></div></div>
      <div><label>Estilo de narración</label><input name="style" value="documental, narrativo, con intriga"></div>
      <div><label>Imágenes del vídeo</label><select name="visual"><option value="stock">Vídeos de stock (Pixabay / Pexels)</option><option value="none">Fondo liso</option></select></div>
      <label class="check"><input type="checkbox" name="captions" checked> Subtítulos</label>
      <div class="muted small">Voz: ${settings.values.tts_provider} · Stock: ${settings.values.pixabay_key || settings.values.pexels_key ? [settings.values.pixabay_key && 'Pixabay ✓', settings.values.pexels_key && 'Pexels ✓'].filter(Boolean).join(' · ') : '<span class="err">sin clave de vídeos de stock (fondo liso): añade Pixabay en Ajustes</span>'}</div>
      <div class="row"><button type="button" class="btn" id="draft">✎ Generar guion para revisar</button><button class="btn gold" id="go">▶ Crear vídeo directamente</button></div>
    </form>
    <div class="card" id="script"><h2>Guion</h2><p class="muted">Genera un borrador para revisarlo y editarlo antes de producir el vídeo.</p></div>
  </div>
  <h2 style="margin-top:28px">Vídeos completos</h2><div class="card" id="list"></div>`;
  const f = $('#f');
  const opts = () => { const d = Object.fromEntries(new FormData(f)); d.type = 'long'; d.captions = f.captions.checked; d.minutes = Number(d.minutes); return d; };
  let script = null;
  const showScript = () => {
    $('#script').innerHTML = `<h2>Guion</h2><div class="stack">
      <div><label>Título</label><input id="st" value="${esc(script.title)}"></div>
      <div><label>Descripción</label><textarea id="sd">${esc(script.description)}</textarea></div>
      ${script.scenes.map((s, i) => `<div class="scene stack"><div class="small muted">Escena ${i + 1}</div><textarea data-nar="${i}">${esc(s.narration)}</textarea><input data-q="${i}" value="${esc(s.search)}" title="Búsqueda de stock (inglés)"><input data-ip="${i}" value="${esc(s.image_prompt || '')}" title="Descripción de imagen IA (inglés)"></div>`).join('')}
      <button class="btn gold block" id="prod">▶ Producir vídeo con este guion</button></div>`;
    $('#prod').onclick = e => busy(e.target, async () => {
      script.title = $('#st').value; script.description = $('#sd').value;
      script.scenes.forEach((s, i) => { s.narration = $(`[data-nar="${i}"]`).value; s.search = $(`[data-q="${i}"]`).value; s.image_prompt = $(`[data-ip="${i}"]`).value; });
      const r = await api('/api/compose', { method: 'POST', body: { ...opts(), script } });
      location.hash = '#/proyecto/' + r.id;
    });
  };
  $('#draft').onclick = e => { if (!f.topic.value) return toast('Escribe un tema', 'bad'); busy(e.target, async () => { script = await api('/api/compose/script', { method: 'POST', body: opts() }); showScript(); }); };
  f.onsubmit = e => { e.preventDefault(); busy($('#go'), async () => { const r = await api('/api/compose', { method: 'POST', body: opts() }); location.hash = '#/proyecto/' + r.id; }); };
  $('#list').innerHTML = projectTable(await api('/api/projects?type=long'));
};

function longView(p, chs) {
  const s = p.data.script;
  return `<div class="grid g2">
    <div class="card">${p.outputUrl ? `<video src="${p.outputUrl}" controls style="width:100%;max-height:70vh;border-radius:8px;background:#000"></video>
      <div class="row" style="margin-top:10px"><a class="btn" href="${p.outputUrl}" download="video_${p.id}.mp4" target="_blank">⬇ Descargar MP4</a>
        <button class="btn gold" id="psocial">📱 Instagram · Facebook · TikTok</button></div>` : '<div class="empty">El vídeo aparecerá aquí cuando termine.</div>'}</div>
    <div class="card stack"><h2>Publicar en YouTube</h2>
      ${p.data.yt_video_id ? `<a target="_blank" href="https://youtube.com/watch?v=${p.data.yt_video_id}">✓ Publicado en YouTube</a>` : ''}
      <div><label>Título</label><input id="pt" value="${esc(s?.title || p.title)}"></div>
      <div><label>Descripción</label><textarea id="pd">${esc(s?.description || '')}</textarea></div>
      <div><label>Etiquetas (separadas por comas)</label><input id="ptags" value="${esc((s?.tags || []).join(', '))}"></div>
      <div class="row"><select id="pch" style="flex:1">${channelOptions(chs.filter(x => x.connected), p.channel_id, 'Elige canal conectado')}</select>
        <select id="ppriv" style="flex:1"><option value="public">Público</option><option value="unlisted">Oculto</option><option value="private">Privado</option></select></div>
      <div><label>Programar (opcional)</label><input type="datetime-local" id="pat"></div>
      <button class="btn gold" id="pub" ${p.output ? '' : 'disabled'}>Publicar ahora</button></div>
    ${s?.hooks?.length ? `<div class="card" style="grid-column:1/-1"><h2>Ganchos alternativos</h2><ul>${s.hooks.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
    ${s?.scenes ? `<div class="card" style="grid-column:1/-1"><h2>Escenas</h2>${s.scenes.map((x, i) => `<div class="row" style="align-items:flex-start;flex-wrap:nowrap;padding:6px 0">
      ${x.mediaUrl ? (/\.(png|jpe?g|webp|gif|avif)(\?|$)/i.test(x.mediaUrl) ? `<img src="${x.mediaUrl}" style="width:64px;border-radius:6px" onerror="this.remove()">` : '<span class="pill">vídeo</span>') : ''}
      <div><b class="muted">${i + 1}.</b> ${esc(x.narration || '(sin voz)')}${x.overlay ? ` <span class="pill">${esc(x.overlay)}</span>` : ''}</div></div>`).join('')}</div>` : ''}
  </div>`;
}
function bindLong(p) {
  const ps = $('#psocial'); if (ps) ps.onclick = () => socialDialog({ project_id: p.id, caption: p.data.script?.title || p.title || '' });
  const b = $('#pub'); if (!b) return;
  b.onclick = () => busy(b, async () => {
    if (!$('#pch').value) throw new Error('Elige un canal conectado a YouTube.');
    const at = $('#pat').value;
    const r = await api(`/api/projects/${p.id}/publish`, { method: 'POST', body: {
      channel_id: $('#pch').value, title: $('#pt').value, description: $('#pd').value, privacy: $('#ppriv').value,
      tags: $('#ptags').value.split(',').map(t => t.trim()).filter(Boolean), publishAt: at ? new Date(at).toISOString() : undefined } });
    toast('¡Publicado! ' + r.url, 'good'); router();
  });
}

// ---------- Buscador de nichos ----------
routes.nichos = async () => {
  main.innerHTML = `<h1>Buscador de nichos</h1><p class="sub">La IA te propone nichos faceless rentables con ideas de vídeos concretas.</p>
    <form class="card row" id="f"><input name="interest" placeholder="Temas que te interesan (opcional): videojuegos, misterio, finanzas…" style="flex:3">
      <select name="market" style="flex:1"><option value="hispanohablante">Mercado hispano</option><option value="anglosajón (EE. UU.)">Mercado EE. UU.</option><option value="brasileño">Mercado Brasil</option></select>
      <button class="btn gold">⌕ Buscar nichos</button></form><div id="res" class="grid g2" style="margin-top:16px"></div>`;
  $('#f').onsubmit = e => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    d.language = d.market.startsWith('anglo') ? 'inglés' : d.market.startsWith('bras') ? 'portugués' : 'español';
    busy(e.target.querySelector('button'), async () => {
      const r = await api('/api/niches', { method: 'POST', body: d });
      $('#res').innerHTML = (r.niches || []).map(n => `<div class="card stack">
        <div class="row between"><h3>${esc(n.name)}</h3><span class="pill">RPM ${esc(n.rpm)}</span></div>
        <div class="muted">${esc(n.description)}</div>
        <div class="row small"><span class="pill">Competencia: ${esc(n.competition)}</span><span class="pill">Dificultad ${esc(n.difficulty)}/10</span>${(n.formats || []).map(x => `<span class="pill">${esc(x)}</span>`).join('')}</div>
        <div class="small">${esc(n.why)}</div>
        <details><summary>Ideas de vídeos</summary><ul>${(n.video_ideas || []).map(i => `<li>${esc(i)}</li>`).join('')}</ul></details>
        <button class="btn sm" data-n='${esc(JSON.stringify({ name: n.name, niche: n.description }))}'>+ Crear canal con este nicho</button></div>`).join('');
      $('#res').querySelectorAll('[data-n]').forEach(b => b.onclick = async () => {
        const n = JSON.parse(b.dataset.n);
        await api('/api/channels', { method: 'POST', body: { name: n.name, niche: n.niche, language: d.language === 'inglés' ? 'en' : d.language === 'portugués' ? 'pt' : 'es' } });
        channelsCache.reset(); toast('Canal creado', 'good');
      });
    });
  };
};

// ---------- Calendario ----------
routes.calendario = async (_, params) => {
  const now = new Date();
  const ym = params.get('m') || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const [y, m] = ym.split('-').map(Number);
  const first = new Date(y, m - 1, 1), startDow = (first.getDay() + 6) % 7;
  const gridStart = new Date(y, m - 1, 1 - startDow);
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const days = Array.from({ length: 42 }, (_, i) => new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i));
  const [items, chs] = await Promise.all([api(`/api/calendar?from=${iso(days[0])}&to=${iso(days[41])}`), channelsCache.get()]);
  const prev = new Date(y, m - 2, 1), next = new Date(y, m, 1);
  const key = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  main.innerHTML = `<div class="row between"><div><h1>Calendario de contenido</h1><p class="sub">Planifica qué publicar cada día. Deja que la IA lo rellene por ti.</p></div></div>
    <div class="card row" style="margin-bottom:16px"><select id="gch" style="flex:1">${channelOptions(chs, '', 'Elige canal…')}</select>
      <input type="number" id="gdays" value="14" min="1" max="60" style="width:90px" title="Días"><button class="btn gold" id="gen">✨ Generar plan con IA</button></div>
    <div class="row between" style="margin-bottom:10px"><a class="btn sm" href="#/calendario?m=${key(prev)}">←</a>
      <h2 style="margin:0">${first.toLocaleDateString('es', { month: 'long', year: 'numeric' })}</h2><a class="btn sm" href="#/calendario?m=${key(next)}">→</a></div>
    <div class="cal">${['L', 'M', 'X', 'J', 'V', 'S', 'D'].map(d => `<div class="wd">${d}</div>`).join('')}
      ${days.map(d => `<div class="d ${d.getMonth() !== m - 1 ? 'out' : ''} ${iso(d) === iso(now) ? 'today' : ''}" data-date="${iso(d)}">
        <div class="row between"><b>${d.getDate()}</b><button class="btn sm" data-add style="padding:0 6px">+</button></div>
        ${items.filter(i => i.date === iso(d)).map(i => `<div class="it ${i.kind} ${i.done ? 'done' : ''}" data-it="${i.id}" title="${esc(i.title + (i.notes ? '\n' + i.notes : ''))}">${i.kind === 'long' ? '▶' : '✂'} ${esc(i.title)}</div>`).join('')}</div>`).join('')}</div>`;
  $('#gen').onclick = e => busy(e.target, async () => {
    if (!$('#gch').value) throw new Error('Elige un canal');
    const r = await api('/api/calendar/generate', { method: 'POST', body: { channel_id: $('#gch').value, days: Number($('#gdays').value), start: iso(now) } });
    toast(`${r.added} publicaciones añadidas`, 'good'); router();
  });
  main.querySelectorAll('[data-add]').forEach(b => b.onclick = async () => {
    const title = prompt('Título de la publicación'); if (!title) return;
    const kind = confirm('¿Es un vídeo largo? (Cancelar = Short)') ? 'long' : 'short';
    await api('/api/calendar', { method: 'POST', body: { date: b.closest('[data-date]').dataset.date, title, kind } }); router();
  });
  main.querySelectorAll('[data-it]').forEach(el => el.onclick = async () => {
    const it = items.find(i => i.id == el.dataset.it);
    const a = prompt(`${it.title}\n${it.notes || ''}\n\nEscribe: "hecho" para marcar/desmarcar, "borrar" para eliminar, o una fecha AAAA-MM-DD para moverlo.`);
    if (!a) return;
    if (a === 'borrar') await api('/api/calendar/' + it.id, { method: 'DELETE' });
    else if (a === 'hecho') await api('/api/calendar/' + it.id, { method: 'PATCH', body: { done: !it.done } });
    else if (/^\d{4}-\d{2}-\d{2}$/.test(a)) await api('/api/calendar/' + it.id, { method: 'PATCH', body: { date: a } });
    router();
  });
};

// ---------- Rankings Top ("Top 5 momentos…") ----------
const RANK_COLORS = ['#FFE600', '#FFFFFF', '#FF2D2D', '#2EE62E', '#FF7AD9', '#3FB6FF', '#FF9F1A', '#B57BFF', '#00F0D0', '#FFC2E0'];
/** Elegir uno de tus clips ya creados (Convertir a Clips / Directos). */
async function clipLibrary(onPick) {
  const list = await api('/api/clips/library');
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal stack" style="width:min(920px,96vw)"><div class="row between"><b>📂 Mis clips</b><button class="btn sm" data-close>✕</button></div>
    ${list.length ? `<div class="lib-grid">${list.map((c, k) => `<div class="lib-card"><video src="${esc(c.url)}" preload="metadata" muted playsinline onmouseenter="this.play()" onmouseleave="this.pause()"></video>
      <div class="small" style="height:34px;overflow:hidden">${esc(c.title || 'Clip')}</div><div class="row between small muted"><span>${esc((c.project || '').slice(0, 22))} · ${c.dur}s</span><button class="btn sm gold" data-k="${k}">Usar</button></div></div>`).join('')}</div>`
      : '<div class="muted">Aún no tienes clips listos. Créalos en Convertir a Clips o Clips de directos.</div>'}</div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.querySelectorAll('[data-close]').forEach(b => b.onclick = close);
  bg.onclick = e => { if (e.target === bg) close(); };
  bg.querySelectorAll('[data-k]').forEach(b => b.onclick = () => { onPick(list[+b.dataset.k]); close(); });
}
routes.ranking = async () => {
  const [chs, sys] = await Promise.all([channelsCache.get(), getSystem()]);
  const links = !sys.vercel;
  main.innerHTML = `<h1>🏆 Rankings Top</h1><p class="sub">Vídeos tipo "Top 5 momentos": los clips se reproducen en cuenta atrás, los números quedan a la izquierda y la etiqueta de cada puesto aparece cuando empieza su clip.</p>
  ${links ? `<div class="card stack" style="margin-bottom:20px"><h2>🔎 Buscar vídeos en YouTube Shorts</h2>
    <form id="sf" class="row"><input id="sq" placeholder="Ej: gatos graciosos, funny dogs, fails…" style="flex:1"><button class="btn gold" id="sgo">Buscar</button></form>
    <div class="small muted">Pulsa "＋ Añadir" y el vídeo va al primer puesto libre. Para TikTok o Instagram, copia el enlace del vídeo y pégalo en un puesto.</div>
    <div id="sres" class="rk-res"></div></div>` : `<div class="card small muted" style="margin-bottom:20px">🔎 Buscar en YouTube Shorts y descargar enlaces de YouTube, TikTok o Instagram está disponible en la app de escritorio (YouTube y TikTok bloquean los servidores en la nube). Aquí sube los vídeos como archivo.</div>`}
  <form id="f" class="grid g2">
    <div class="card stack"><h2>1. Puestos del ranking <span class="muted small">(el 1 es el mejor)</span></h2>
      <div id="items" class="stack"></div>
      <div class="row"><button type="button" class="btn sm" id="add">＋ Añadir puesto</button><span class="muted small">De 2 a 10 puestos. Arrastra un vídeo sobre un puesto${links ? ', búscalo arriba o pega un enlace de YouTube, TikTok o Instagram' : ''}.</span></div>
      <input type="file" id="pick" accept="video/*" hidden>
    </div>
    <div class="stack">
      <div class="card stack"><h2>2. Textos</h2>
        <div><label>Título <span class="muted">(*palabra* = en color; si no, se resalta la última)</span></label><input name="title" value="Ranking funny cat *moment*" required></div>
        <div><label>Texto inferior <span class="muted">(opcional: @tucanal…)</span></label><input name="bottom" placeholder="@tucanal"></div>
        <div class="row"><input id="topic" placeholder="Tema para la IA (p. ej. gatos graciosos)" style="flex:1"><button type="button" class="btn sm" id="ai">✨ Sugerir título y etiquetas</button></div>
      </div>
      <div class="card stack"><h2>3. Estilo</h2>
        <div class="row"><div style="flex:1"><label>Orden</label><select name="order"><option value="countdown">Cuenta atrás (5 → 1)</option><option value="asc">Del 1 al último</option></select></div>
          <div style="flex:1"><label>Encuadre</label><select name="fit"><option value="auto">Automático</option><option value="fill">Llenar (recorta)</option><option value="blur">Vídeo entero con fondo difuminado</option></select></div></div>
        <div class="row"><div style="flex:1"><label>Segundos máx. por clip</label><input type="number" name="maxClipSec" value="12" min="2" max="60"></div>
          <div style="flex:1"><label>Color del resaltado</label><input type="color" name="highlight" value="#FFD400" style="height:40px"></div>
          <div style="flex:1"><label>Fondo</label><input type="color" name="background" value="#000000" style="height:40px"></div></div>
        <label class="check"><input type="checkbox" name="keepAudio" checked> Conservar el audio de los clips</label>
        <label class="check"><input type="checkbox" name="flash" checked> Número grande al empezar cada puesto</label>
        <div><label>Texto final <span class="muted">(últimos 3 s; vacío = sin texto)</span></label><input name="cta" value="¿Cuál es tu favorito?"></div>
        <div><label>Canal</label><select name="channel_id">${channelOptions(chs)}</select></div>
        <div class="small muted" id="up"></div>
        <button class="btn gold block" id="go">🏆 Crear ranking</button>
      </div>
      <div class="card"><h2>Vista previa</h2><div id="prev" class="rkprev"></div></div>
    </div>
  </form>
  <h2 style="margin-top:28px">Rankings</h2><div class="card" id="list"></div>`;
  const items = [...Array(5)].map(() => ({ file: null, url: '', label: '', start: '', end: '' }));
  const f = $('#f');
  let pickFor = 0;
  const preview = () => {
    const t = esc(f.title.value || '').toUpperCase();
    const title = t.includes('*') ? t.replace(/\*([^*]+)\*/g, `<span style="color:${f.highlight.value}">$1</span>`).replace(/\*/g, '') : t.replace(/(\S+)$/, `<span style="color:${f.highlight.value}">$1</span>`);
    $('#prev').innerHTML = `<div class="rk-top">${title}</div><div class="rk-vid" style="background:${f.background.value === '#000000' ? '#2b2f38' : f.background.value}">${items.map((it, i) =>
      `<div class="rk-row"><b style="color:${RANK_COLORS[i % 10]}">${i + 1}.</b> <span>${esc(it.label)}</span></div>`).join('')}</div><div class="rk-bot">${esc(f.bottom.value)}</div>`;
  };
  const draw = () => {
    $('#items').innerHTML = items.map((it, i) => `<div class="scene stack rk-item" data-i="${i}" style="gap:6px">
      <div class="row" style="flex-wrap:nowrap"><b style="color:${RANK_COLORS[i % 10]};font-size:20px;min-width:30px">${i + 1}.</b>
        <input data-k="label" placeholder="Etiqueta (p. ej. White Cat)" value="${esc(it.label)}" style="flex:1">
        <button type="button" class="btn sm" data-up title="Subir">↑</button><button type="button" class="btn sm" data-down title="Bajar">↓</button><button type="button" class="btn sm" data-rm title="Quitar">✕</button></div>
      <div class="row" style="flex-wrap:nowrap"><button type="button" class="btn sm" data-pick>${it.file ? '🎬 ' + esc(it.file.name.slice(0, 26)) : it.source ? '✂ ' + esc((it.srcName || 'Clip').slice(0, 26)) : '⬆ Elegir vídeo'}</button><button type="button" class="btn sm" data-lib title="Usar un clip que ya creaste">📂 Mis clips</button>
        ${links ? `<input data-k="url" placeholder="…o enlace (YouTube, TikTok, Instagram)" value="${esc(it.url)}" style="flex:1">` : '<span style="flex:1"></span>'}
        <input data-k="start" type="number" step="0.1" min="0" placeholder="Inicio s" value="${esc(it.start)}" style="width:86px">
        <input data-k="end" type="number" step="0.1" min="0" placeholder="Fin s" value="${esc(it.end)}" style="width:76px"></div></div>`).join('');
    $('#items').querySelectorAll('.rk-item').forEach(el => {
      const i = +el.dataset.i;
      el.querySelectorAll('[data-k]').forEach(inp => inp.oninput = () => { items[i][inp.dataset.k] = inp.value; preview(); });
      el.querySelector('[data-pick]').onclick = () => { pickFor = i; $('#pick').click(); };
      el.querySelector('[data-lib]').onclick = () => clipLibrary(c => { Object.assign(items[i], { file: null, url: '', source: c.file, srcName: c.title, start: '', end: '' }); if (!items[i].label) items[i].label = (c.hook || c.title || '').split(' ').slice(0, 3).join(' '); draw(); });
      el.querySelector('[data-rm]').onclick = () => { if (items.length > 2) { items.splice(i, 1); draw(); } };
      el.querySelector('[data-up]').onclick = () => { if (i) { [items[i - 1], items[i]] = [items[i], items[i - 1]]; draw(); } };
      el.querySelector('[data-down]').onclick = () => { if (i < items.length - 1) { [items[i + 1], items[i]] = [items[i], items[i + 1]]; draw(); } };
      el.ondragover = e => { e.preventDefault(); el.classList.add('over'); };
      el.ondragleave = () => el.classList.remove('over');
      el.ondrop = e => { e.preventDefault(); el.classList.remove('over'); const file = e.dataTransfer.files[0]; if (file) { items[i].file = file; items[i].source = null; draw(); } };
    });
    preview();
  };
  const sf = $('#sf');
  if (sf) sf.onsubmit = e => {
    e.preventDefault();
    const q = $('#sq').value.trim(); if (!q) return;
    busy($('#sgo'), async () => {
      $('#sres').innerHTML = '<div class="muted small"><span class="spinner"></span> Buscando en YouTube… (unos segundos)</div>';
      try {
        const r = await api('/api/ranking/search?q=' + encodeURIComponent(q));
        const fmtV = v => v >= 1e6 ? (v / 1e6).toFixed(1).replace('.0', '') + ' M' : v >= 1e3 ? Math.round(v / 1e3) + ' K' : v || '';
        $('#sres').innerHTML = r.length ? r.map((v, k) => `<div class="rk-card"><a href="${esc(v.url)}" target="_blank" title="Ver en YouTube"><img src="${esc(v.thumb)}" loading="lazy" alt=""></a>
          <div class="small" style="height:34px;overflow:hidden">${esc(v.title || 'Short')}</div>
          <div class="row between small muted"><span>${v.views ? fmtV(v.views) + ' vistas' : ''}${v.duration ? ' · ' + mmss(v.duration) : ''}</span>
            <button type="button" class="btn sm gold" data-addv="${k}">＋ Añadir</button></div></div>`).join('') : '<div class="muted">Sin resultados.</div>';
        $('#sres').querySelectorAll('[data-addv]').forEach(b => b.onclick = () => {
          const v = r[+b.dataset.addv];
          let i = items.findIndex(x => !x.file && !x.source && !x.url.trim());
          if (i < 0) { if (items.length >= 10) return toast('Máximo 10 puestos', 'bad'); items.push({ file: null, url: '', label: '', start: '', end: '' }); i = items.length - 1; }
          items[i].url = v.url; draw();
          b.textContent = `✓ Puesto ${i + 1}`; b.disabled = true;
        });
      } catch (err) { $('#sres').innerHTML = `<div class="err small">${esc(err.message)}</div>`; }
    });
  };
  $('#pick').onchange = e => { if (e.target.files[0]) { items[pickFor].file = e.target.files[0]; items[pickFor].source = null; e.target.value = ''; draw(); } };
  $('#add').onclick = () => { if (items.length < 10) { items.push({ file: null, url: '', label: '', start: '', end: '' }); draw(); } };
  for (const k of ['title', 'bottom', 'highlight', 'background']) f[k].oninput = preview;
  let meta = null;
  $('#ai').onclick = () => busy($('#ai'), async () => {
    const r = await api('/api/ranking/suggest', { method: 'POST', body: { topic: $('#topic').value || f.title.value, notes: items.map(x => x.label || x.file?.name || '') } });
    if (r.title) f.title.value = r.title;
    (r.labels || []).forEach((l, i) => { if (items[i] && !items[i].label) items[i].label = l; });
    meta = { yt_title: r.yt_title, description: r.description, tags: r.tags };
    draw(); toast('Sugerencias aplicadas', 'good');
  });
  f.onsubmit = e => {
    e.preventDefault();
    const used = items.filter(x => x.file || x.source || x.url.trim());
    if (used.length < 2) return toast('Añade un vídeo en al menos 2 puestos', 'bad');
    if (used.length !== items.length) return toast(`Falta el vídeo de algún puesto (o quita los puestos vacíos)`, 'bad');
    busy($('#go'), async () => {
      const d = Object.fromEntries(new FormData(f));
      d.keepAudio = f.keepAudio.checked; d.flash = f.flash.checked;
      const out = [];
      for (const [i, it] of items.entries()) {
        let source = it.source || null;
        if (it.file) source = await uploadFile(it.file, pct => { $('#up').textContent = `Subiendo vídeo del puesto ${i + 1}… ${pct}%`; });
        out.push({ source, url: it.file || it.source ? '' : it.url, label: it.label, start: it.start, end: it.end });
      }
      const r = await api('/api/ranking', { method: 'POST', body: { ...d, ...(meta || {}), items: out } });
      location.hash = '#/proyecto/' + r.id;
    });
  };
  draw();
  $('#list').innerHTML = projectTable(await api('/api/projects?type=ranking'));
};

// ---------- Licencias y usuarios (solo administradores, en el servidor central) ----------
routes.licencias = async () => {
  const users = await api('/api/license/users');
  const fdate = d => d ? new Date(d).toLocaleDateString('es', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
  const ago = d => { if (!d) return 'nunca'; const m = Math.round((Date.now() - new Date(d)) / 60000); return m < 60 ? `hace ${m} min` : m < 2880 ? `hace ${Math.round(m / 60)} h` : `hace ${Math.round(m / 1440)} días`; };
  const state = u => !u.active ? '<span class="pill error">Desactivado</span>' : u.expires_at && new Date(u.expires_at) < new Date() ? '<span class="pill error">Vencido</span>'
    : u.expires_at && new Date(u.expires_at) - Date.now() < 7 * 864e5 ? '<span class="pill processing">Vence pronto</span>' : '<span class="pill ready">Activo</span>';
  main.innerHTML = `<h1>🔑 Licencias y usuarios</h1><p class="sub">Solo los usuarios que crees aquí pueden abrir la app de escritorio. Cada cuenta queda ligada a los equipos donde inicia sesión (hasta el máximo que pongas).</p>
  <div class="grid g2" style="align-items:start">
    <form id="nf" class="card stack"><h2>Nuevo usuario</h2>
      <div class="row"><div style="flex:1"><label>Usuario</label><input name="username" required autocomplete="off"></div>
        <div style="flex:1"><label>Contraseña</label><div class="row" style="flex-wrap:nowrap"><input name="password" required minlength="8" autocomplete="off"><button type="button" class="btn sm" id="gen" title="Generar">🎲</button></div></div></div>
      <div class="row"><div style="flex:1"><label>Suscripción</label><select name="days"><option value="30">1 mes</option><option value="90">3 meses</option><option value="180">6 meses</option><option value="365">1 año</option><option value="">Sin vencimiento</option></select></div>
        <div style="flex:1"><label>Equipos máximos</label><input type="number" name="max_devices" value="1" min="1" max="20"></div>
        <div style="flex:1"><label>Rol</label><select name="role"><option value="user">Suscriptor</option><option value="admin">Administrador</option></select></div></div>
      <div><label>Notas <span class="muted">(email, pago…)</span></label><input name="notes"></div>
      <button class="btn gold">＋ Crear usuario</button>
      <div class="small muted" id="created"></div></form>
    <div class="card stack"><h2>Cómo funciona</h2><ol class="small">
      <li>Crea el usuario y pásale su usuario y contraseña.</li>
      <li>Al abrir la app de escritorio inicia sesión; ese equipo queda registrado (ID único del equipo).</li>
      <li>Si intenta entrar desde más equipos de los permitidos, se rechaza. Puedes liberar o bloquear equipos abajo.</li>
      <li>La app comprueba la licencia cada hora. Si desactivas la cuenta, vence o bloqueas el equipo, se cierra el acceso (sin conexión sigue hasta 3 días como máximo).</li></ol></div>
  </div>
  <h2 style="margin-top:24px">Usuarios (${users.length})</h2>
  <div class="stack">${users.map(u => `<div class="card stack" data-u="${u.id}">
    <div class="row between"><div class="row"><b style="font-size:16px">${esc(u.username)}</b> ${u.role === 'admin' ? '<span class="pill">admin</span>' : ''} ${state(u)}
      ${u.locked_until && new Date(u.locked_until) > new Date() ? '<span class="pill error">bloqueado por intentos</span> <button class="btn sm" data-act="unlock">Desbloquear</button>' : ''}</div>
      <div class="small muted">Vence: <b>${fdate(u.expires_at)}</b> · Equipos: <b>${u.devices.filter(d => !d.blocked).length}/${u.max_devices}</b> · Último acceso: ${ago(u.last_login)}</div></div>
    ${u.notes ? `<div class="small muted">📝 ${esc(u.notes)}</div>` : ''}
    <div class="row" style="gap:6px">
      <button class="btn sm" data-act="add" data-v="30">+30 días</button><button class="btn sm" data-act="add" data-v="365">+1 año</button>
      <button class="btn sm" data-act="date">📅 Fecha…</button><button class="btn sm" data-act="max">Equipos…</button><button class="btn sm" data-act="pass">Nueva contraseña…</button>
      <button class="btn sm" data-act="notes">Notas…</button>
      <button class="btn sm ${u.active ? 'red' : 'gold'}" data-act="toggle">${u.active ? 'Desactivar' : 'Activar'}</button>
      <button class="btn sm red" data-act="del">Eliminar</button></div>
    ${u.devices.length ? `<table class="small" style="width:100%"><tr class="muted"><td>Equipo</td><td>Sistema</td><td>Versión</td><td>Último uso</td><td>IP</td><td></td></tr>${u.devices.map(d => `<tr data-d="${d.id}">
      <td>${d.blocked ? '⛔ ' : '💻 '}${esc(d.name || 'Equipo')} <span class="muted">${esc(d.device_id.slice(0, 10))}…</span></td><td>${esc(d.platform || '')}</td><td>${esc(d.app_version || '')}</td>
      <td>${ago(d.last_seen)}</td><td class="muted">${esc(d.last_ip || '')}</td>
      <td style="text-align:right"><button class="btn sm" data-dact="block">${d.blocked ? 'Desbloquear' : 'Bloquear'}</button> <button class="btn sm red" data-dact="del" title="Libera el hueco para otro equipo">Liberar</button></td></tr>`).join('')}</table>` : '<div class="small muted">Aún no ha iniciado sesión en ningún equipo.</div>'}
  </div>`).join('')}</div>`;
  const nf = $('#nf');
  $('#gen').onclick = () => { const a = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; nf.password.value = [...crypto.getRandomValues(new Uint32Array(12))].map(x => a[x % a.length]).join(''); };
  nf.onsubmit = e => { e.preventDefault(); busy(nf.querySelector('.btn.gold'), async () => {
    const d = Object.fromEntries(new FormData(nf));
    await api('/api/license/users', { method: 'POST', body: d });
    toast(`Usuario ${d.username} creado`, 'good');
    await routes.licencias();
    $('#created').innerHTML = `Pásale estos datos: <b>Usuario:</b> <code>${esc(d.username.toLowerCase())}</code> · <b>Contraseña:</b> <code>${esc(d.password)}</code>`;
  }); };
  const patch = (id, body) => api('/api/license/users/' + id, { method: 'PATCH', body }).then(() => routes.licencias());
  main.querySelectorAll('[data-u]').forEach(el => {
    const id = +el.dataset.u, u = users.find(x => x.id === id);
    el.querySelectorAll('[data-act]').forEach(b => b.onclick = () => busy(b, async () => {
      const a = b.dataset.act;
      if (a === 'add') return patch(id, { addDays: +b.dataset.v });
      if (a === 'unlock') return patch(id, { unlock: true });
      if (a === 'toggle') return patch(id, { active: !u.active });
      if (a === 'date') { const v = prompt('Fecha de vencimiento (AAAA-MM-DD). Vacío = sin vencimiento:', u.expires_at ? u.expires_at.slice(0, 10) : ''); if (v === null) return; return patch(id, { expires_at: v ? v + 'T23:59:59' : null }); }
      if (a === 'max') { const v = prompt('Número máximo de equipos:', u.max_devices); if (v) return patch(id, { max_devices: +v }); return; }
      if (a === 'pass') { const v = prompt('Nueva contraseña (mín. 8 caracteres):'); if (v) { await patch(id, { password: v }); toast('Contraseña cambiada', 'good'); } return; }
      if (a === 'notes') { const v = prompt('Notas:', u.notes || ''); if (v !== null) return patch(id, { notes: v }); return; }
      if (a === 'del' && confirm(`¿Eliminar a ${u.username} y todos sus equipos?`)) { await api('/api/license/users/' + id, { method: 'DELETE' }); return routes.licencias(); }
    }));
    el.querySelectorAll('[data-d]').forEach(row => row.querySelectorAll('[data-dact]').forEach(b => b.onclick = () => busy(b, async () => {
      const did = +row.dataset.d, d = u.devices.find(x => x.id === did);
      if (b.dataset.dact === 'block') await api('/api/license/devices/' + did, { method: 'PATCH', body: { blocked: !d.blocked } });
      else if (confirm('¿Liberar este equipo? El usuario tendrá que iniciar sesión de nuevo en él (y ocupará un hueco).')) await api('/api/license/devices/' + did, { method: 'DELETE' });
      else return;
      await routes.licencias();
    })));
  });
};

// ---------- Miniaturas y portadas con IA ----------
const THUMB_STYLES = { impacto: 'Impactante (colores intensos)', misterio: 'Misterio / oscuro', gaming: 'Gaming / neón', documental: 'Documental / realista', minimal: 'Minimalista', cartoon: 'Dibujo / cartoon' };
const THUMB_FORMATS = { youtube: 'YouTube 16:9 (1280×720)', short: 'Portada Shorts / Reels 9:16', square: 'Cuadrada 1:1' };
const POSITIONS = { left: 'Texto a la izquierda', right: 'Texto a la derecha', top: 'Texto arriba', bottom: 'Texto abajo', center: 'Texto en el centro' };
const TEXT_FX = { clasico: 'Clásico (borde negro)', neon: 'Neón (brillo de color)', caja: 'Caja de color', '3d': '3D (sombra larga)' };
routes.miniaturas = async (id) => {
  const [chs, list, caps] = await Promise.all([channelsCache.get(), api('/api/thumbs'), api('/api/thumbs/caps').catch(() => ({ aiText: true }))]);
  let t = id ? await api('/api/thumbs/' + id) : null;
  main.innerHTML = `<h1>🖼 Miniaturas IA</h1><p class="sub">${caps.aiText ? 'Escribe el título de tu vídeo: la IA propone ideas y Gemini diseña la miniatura completa, con el texto integrado y una tipografía profesional acorde al tema (dorada, 3D, neón, terror…). Para cambiar el texto, la IA edita la propia imagen.' : 'Escribe el título de tu vídeo: la IA propone ideas, genera la imagen de fondo y le pone un texto grande y editable. También puedes usar los mejores fotogramas de tu vídeo (pestaña Miniaturas del proyecto).'}</p>
  <div class="grid g2" style="align-items:start">
    <form id="f" class="card stack"><h2>1. Tu vídeo</h2>
      <div><label>Título del vídeo</label><input name="title" required placeholder="Ej: Probé el truco de ahorro que nadie usa" value="${esc(t?.title || '')}"></div>
      <div class="row"><div style="flex:1"><label>Formato</label><select name="format">${opts(THUMB_FORMATS, t?.format || 'youtube')}</select></div>
        <div style="flex:1"><label>Estilo</label><select name="style">${opts(THUMB_STYLES, t?.style || 'impacto')}</select></div></div>
      ${caps.aiText ? `<div><label>Texto de la miniatura</label><select name="mode"><option value="ai">✨ Diseñado por la IA (Gemini): tipografía profesional según el tema</option><option value="overlay">Superpuesto y editable al instante (sin coste extra)</option></select></div>`
        : `<input type="hidden" name="mode" value="overlay"><div class="small muted">🧠 La imagen se genera en tu equipo (IA local) y el texto se pone encima, editable al instante. ${caps.local ? 'Cada imagen tarda de 20 s a unos minutos según tu ordenador.' : ''}</div>`}
      <div><label>Nicho o canal <span class="muted">(opcional)</span></label><input name="niche" list="chn" value="${esc(t?.niche || '')}"><datalist id="chn">${chs.map(c => `<option value="${esc(c.niche || c.name)}">`).join('')}</datalist></div>
      <div ${caps.aiText ? '' : 'hidden'}><label>Tu foto o personaje <span class="muted">(opcional: aparecerá en la miniatura; funciona con OpenAI y Gemini)</span></label><input type="file" name="ref" accept="image/*" multiple></div>
      <div class="row"><div style="flex:1"><label>Efecto del texto</label><select name="effect">${opts(TEXT_FX, 'clasico')}</select></div>
        <div style="flex:1"><label>Emoji grande <span class="muted">(opcional)</span></label><input name="emoji" list="emojis" placeholder="😱 🔥 💰" maxlength="4"></div>
        ${caps.local && !caps.aiText ? `<div style="flex:1"><label>Calidad de imagen</label><select name="quality"><option value="rapida">Rápida (~40% menos tiempo)</option><option value="normal" selected>Normal</option><option value="alta">Alta (más detalle)</option></select></div>` : ''}</div>
      <datalist id="emojis">${['😱', '🔥', '💰', '😂', '🤯', '❌', '✅', '⚠️', '👀', '💀', '🚀', '❤️'].map(e => `<option value="${e}">`).join('')}</datalist>
      <div class="row"><button class="btn gold" id="ideasBtn">✨ Ideas con IA</button><button type="button" class="btn" id="ownBtn">🖼 Usar mi imagen de fondo</button>${aiTag()}</div>
      <input type="file" id="ownFile" accept="image/*" hidden>
      <div class="small muted" id="st"></div>
    </form>
    <div class="card stack"><h2>2. Ideas</h2><div id="ideas" class="stack">${t?.ideas?.length ? '' : '<div class="muted small">Pulsa "✨ Ideas con IA" y elige una (o genera todas).</div>'}</div></div>
  </div>
  <h2 style="margin-top:24px">3. Miniaturas</h2><div id="items" class="th-grid"></div>
  ${list.length ? `<h2 style="margin-top:28px">Anteriores</h2><div class="card">${list.map(x => `<div class="row between" style="padding:6px 0;border-bottom:1px solid var(--line)">
    <a href="#/miniaturas/${x.id}" class="row" style="gap:10px">${x.items[0] ? `<img src="${x.items[0].url}" style="height:42px;border-radius:4px">` : ''}<span>${esc(x.title)}</span></a>
    <span class="small muted">${THUMB_FORMATS[x.format]?.split(' (')[0] || ''} · ${x.items.length} <button class="btn sm red" data-delset="${x.id}">✕</button></span></div>`).join('')}</div>` : ''}`;
  const f = $('#f');
  const ensure = async () => {
    if (t && t.title === f.title.value && t.format === f.format.value && t.style === f.style.value && !f.ref.files.length) return t;
    const refs = [];
    for (const file of f.ref.files) refs.push(await uploadFile(file, pct => { $('#st').textContent = `Subiendo foto… ${pct}%`; }));
    $('#st').textContent = '';
    t = await api('/api/thumbs', { method: 'POST', body: { title: f.title.value, format: f.format.value, style: f.style.value, niche: f.niche.value, refs } });
    history.replaceState(null, '', '#/miniaturas/' + t.id);
    return t;
  };
  const drawIdeas = () => {
    $('#ideas').innerHTML = (t?.ideas || []).map((i, k) => `<div class="scene stack" style="gap:4px"><div class="row between"><b style="font-family:Anton,Impact,sans-serif;font-size:20px;letter-spacing:.5px">${esc(i.text).replace(esc(i.highlight || '¤'), `<span style="color:${esc(i.color || '#FFD400')}">${esc(i.highlight || '')}</span>`)}</b>
      <button class="btn sm gold" data-gen="${k}">🎨 Generar</button></div><div class="small muted">${esc(i.why || '')}${i.typography ? ` · 🔤 ${esc(i.typography)}` : ''}</div></div>`).join('') +
      (t?.ideas?.length ? '<button class="btn" id="genAll">🎨 Generar todas</button>' : '<div class="muted small">Pulsa "✨ Ideas con IA" y elige una (o genera todas).</div>');
    $('#ideas').querySelectorAll('[data-gen]').forEach(b => b.onclick = () => busy(b, () => generate(t.ideas[+b.dataset.gen])));
    const ga = $('#genAll'); if (ga) ga.onclick = () => busy(ga, async () => { for (const i of t.ideas) await generate(i); });
  };
  const card = it => it.design.mode === 'ai' ? `<div class="card th-card" data-it="${it.id}">
    <a href="${it.url}" target="_blank"><img src="${it.url}?v=${Date.now()}" class="th-img ${t.format}"></a>
    <div class="stack" style="gap:6px;margin-top:8px">
      <div class="small muted">✨ Texto diseñado por la IA. Para cambiarlo, la IA edita la imagen (conserva el resto).</div>
      <div class="row" style="flex-wrap:nowrap"><input data-k="text" value="${esc(it.design.text)}" placeholder="Texto" style="flex:2"><input data-k="highlight" value="${esc(it.design.highlight)}" placeholder="Palabra en color" style="flex:1">
        <input type="color" data-k="color" value="${esc(it.design.color || '#FFD400')}" title="Color de la palabra resaltada" style="width:44px;height:38px;padding:2px"></div>
      <input data-k="typography" placeholder="Estilo de letra (opcional): p. ej. letras doradas 3D con brillo" value="">
      <input data-k="instructions" placeholder="Otros cambios (opcional): p. ej. fondo más oscuro, añade flechas rojas" value="">
      <div class="row" style="gap:6px"><button class="btn sm gold" data-apply>✏️ Cambiar con IA</button><a class="btn sm" href="${it.url}" download="miniatura.png" target="_blank">⬇ Descargar</a>
        <button class="btn sm" data-again title="Otra versión con la misma idea">↻ Otra versión</button><button class="btn sm red" data-del>✕</button></div></div></div>` : `<div class="card th-card" data-it="${it.id}">
    <a href="${it.url}" target="_blank"><img src="${it.url}?v=${Date.now()}" class="th-img ${t.format}"></a>
    <div class="stack" style="gap:6px;margin-top:8px">
      <div class="row" style="flex-wrap:nowrap"><input data-k="text" value="${esc(it.design.text)}" placeholder="Texto" style="flex:2"><input data-k="highlight" value="${esc(it.design.highlight)}" placeholder="Palabra en color" style="flex:1"></div>
      <div class="row" style="flex-wrap:nowrap;gap:6px"><select data-k="position" style="flex:2">${opts(POSITIONS, it.design.position)}</select>
        <input type="color" data-k="color" value="${esc(it.design.color || '#FFD400')}" title="Color resaltado" style="width:44px;height:38px;padding:2px">
        <input type="color" data-k="textColor" value="${esc(it.design.textColor || '#FFFFFF')}" title="Color del texto" style="width:44px;height:38px;padding:2px"></div>
      <div class="row small muted" style="flex-wrap:nowrap;gap:8px">Tamaño<input type="range" data-k="scale" min="0.5" max="1.5" step="0.05" value="${it.design.scale || 1}" style="flex:1">Giro<input type="range" data-k="tilt" min="-10" max="10" step="1" value="${it.design.tilt || 0}" style="flex:1">
        <label class="check" style="margin:0"><input type="checkbox" data-k="shade" ${it.design.shade !== false ? 'checked' : ''}> Sombra</label></div>
      <div class="row" style="flex-wrap:nowrap;gap:6px"><select data-k="effect" style="flex:2">${opts(TEXT_FX, it.design.effect || 'clasico')}</select>
        <input data-k="emoji" list="emojis" value="${esc(it.design.emoji || '')}" placeholder="Emoji" maxlength="4" style="flex:1"></div>
      <div class="row" style="gap:6px"><button class="btn sm gold" data-apply>✓ Aplicar</button><a class="btn sm" href="${it.url}" download="miniatura.png" target="_blank">⬇ Descargar</a>
        <button class="btn sm" data-again title="Otra imagen con la misma idea">↻ Otra imagen</button><button class="btn sm red" data-del>✕</button></div></div></div>`;
  const drawItems = () => {
    $('#items').innerHTML = t?.items?.length ? t.items.map(card).join('') : '<div class="empty">Aún no hay miniaturas.</div>';
    $('#items').querySelectorAll('[data-it]').forEach(el => {
      const it = t.items.find(x => x.id === el.dataset.it);
      const val = () => Object.fromEntries([...el.querySelectorAll('[data-k]')].map(i => [i.dataset.k, i.type === 'checkbox' ? i.checked : i.type === 'range' ? Number(i.value) : i.value]).filter(([k, v]) => v !== '' || k === 'emoji'));
      el.querySelector('[data-apply]').onclick = e => busy(e.target, async () => {
        if (it.design.mode === 'ai') $('#st').innerHTML = '<span class="spinner"></span> La IA está cambiando el texto de la miniatura… (20–60 s)';
        try { Object.assign(it, await api(`/api/thumbs/${t.id}/items/${it.id}`, { method: 'PATCH', body: val() })); drawItems(); } finally { $('#st').textContent = ''; }
      });
      el.querySelector('[data-again]').onclick = e => busy(e.target, () => generate({ ...it.design, prompt: it.prompt }));
      el.querySelector('[data-del]').onclick = e => busy(e.target, async () => { await api(`/api/thumbs/${t.id}/items/${it.id}`, { method: 'DELETE' }); t.items = t.items.filter(x => x !== it); drawItems(); });
    });
  };
  const generate = async (idea, base) => {
    await ensure();
    $('#st').innerHTML = `<span class="spinner"></span> ${f.mode.value === 'ai' && !base ? 'Gemini está diseñando la miniatura con el texto…' : 'Generando la imagen con IA…'} (20–60 s)`;
    try {
      const it = await api(`/api/thumbs/${t.id}/generate`, { method: 'POST', body: { effect: f.effect.value, emoji: f.emoji.value, quality: f.quality?.value, ...idea, base, mode: base ? 'overlay' : (idea.mode || f.mode.value) } });
      t.items = [it, ...(t.items || [])]; drawItems();
    } finally { $('#st').textContent = ''; }
  };
  f.onsubmit = e => { e.preventDefault(); busy($('#ideasBtn'), async () => {
    await ensure();
    t.ideas = (await api(`/api/thumbs/${t.id}/ideas`, { method: 'POST', body: {} })).ideas; drawIdeas();
  }); };
  $('#ownBtn').onclick = () => { if (!f.title.value) return toast('Escribe primero el título', 'bad'); $('#ownFile').click(); };
  $('#ownFile').onchange = e => { const file = e.target.files[0]; if (!file) return; busy($('#ownBtn'), async () => {
    const base = await uploadFile(file, pct => { $('#st').textContent = `Subiendo… ${pct}%`; });
    const first = t?.ideas?.[0] || { text: f.title.value.split(' ').slice(0, 3).join(' ').toUpperCase(), position: 'left' };
    await generate(first, base);
  }); e.target.value = ''; };
  main.querySelectorAll('[data-delset]').forEach(b => b.onclick = e => { e.preventDefault(); if (confirm('¿Borrar estas miniaturas?')) busy(b, async () => { await api('/api/thumbs/' + b.dataset.delset, { method: 'DELETE' }); location.hash = '#/miniaturas'; router(); }); });
  drawIdeas(); drawItems();
};

// ---------- Analizador ----------
const fmtN = n => Number(n || 0).toLocaleString('es');
routes.analizador = async (id) => {
  const hist = await api('/api/analyses');
  main.innerHTML = `<h1>Analizador</h1><p class="sub">Analiza cualquier canal o vídeo de YouTube: qué funciona, frecuencia, mejores días y recomendaciones de la IA.</p>
    <form class="card row" id="f"><input name="target" placeholder="https://youtube.com/@canal · URL de un vídeo · ID" style="flex:1" required><button class="btn gold">◔ Analizar</button></form>
    <div id="res" style="margin-top:16px"></div>
    ${hist.length ? `<h2 style="margin-top:24px">Análisis anteriores</h2><div class="card">${hist.map(a => `<div class="row between" style="padding:5px 0"><a href="#/analizador/${a.id}">${a.kind === 'video' ? '🎬' : '📺'} ${esc(a.target)}</a><span class="row"><span class="muted small">${String(a.created_at).slice(0, 10)}</span><button class="btn sm red" data-del="${a.id}">✕</button></span></div>`).join('')}</div>` : ''}`;
  main.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { await api('/api/analyses/' + b.dataset.del, { method: 'DELETE' }); location.hash = '#/analizador'; router(); });
  const show = r => {
    const ai = r.ai || {};
    const li = a => (a || []).map(x => `<li>${esc(x)}</li>`).join('');
    if (r.kind === 'video') {
      const v = r.stats.video;
      $('#res').innerHTML = `<div class="grid g2">
        <div class="card stack"><div class="row" style="flex-wrap:nowrap">${v.thumbnail ? `<img src="${v.thumbnail}" style="width:160px;border-radius:8px">` : ''}<div><h2>${esc(v.title)}</h2><a class="small" target="_blank" href="https://youtube.com/watch?v=${v.id}">Ver en YouTube</a></div></div>
          <div class="grid g4"><div><div class="muted small">Vistas</div><div class="stat">${fmtN(v.views)}</div></div><div><div class="muted small">Vistas/día</div><div class="stat">${fmtN(r.stats.viewsPerDay)}</div></div>
          <div><div class="muted small">% likes</div><div class="stat">${r.stats.likeRate}</div></div><div><div class="muted small">Nota del título</div><div class="stat">${esc(ai.title_score)}</div></div></div>
          <p>${esc(ai.summary)}</p><p class="small"><b>Audiencia:</b> ${esc(ai.audience_sentiment)}</p></div>
        <div class="card"><h3>Títulos mejores</h3><ul>${li(ai.better_titles)}</ul><h3>SEO</h3><ul>${li(ai.seo)}</ul></div>
        <div class="card"><h3>Lo que pide la audiencia</h3><ul>${li(ai.audience_requests)}</ul><h3>Ideas de clips</h3><ul>${li(ai.shorts_ideas)}</ul></div>
        <div class="card"><h3>Recomendaciones</h3><ul>${li(ai.recommendations)}</ul></div></div>`;
      return;
    }
    const st = r.stats, c = st.channel;
    $('#res').innerHTML = `<div class="card row" style="margin-bottom:16px">${c.thumbnail ? `<img src="${c.thumbnail}" style="width:56px;border-radius:50%">` : ''}<div style="flex:1"><h2 style="margin:0">${esc(c.title)}</h2><div class="muted small">${esc(ai.niche || '')} · creado ${String(c.created).slice(0, 10)}</div></div>
      <a class="btn sm" target="_blank" href="https://youtube.com/channel/${c.id}">Abrir canal</a></div>
      <div class="grid g4" style="margin-bottom:16px">
        <div class="card"><div class="muted small">Suscriptores</div><div class="stat">${fmtN(c.subscribers)}</div></div>
        <div class="card"><div class="muted small">Vídeos / semana</div><div class="stat">${st.perWeek}</div></div>
        <div class="card"><div class="muted small">Mediana Shorts</div><div class="stat">${fmtN(st.shorts.medianViews)}</div><div class="muted small">${st.shorts.count} shorts</div></div>
        <div class="card"><div class="muted small">Mediana largos</div><div class="stat">${fmtN(st.longs.medianViews)}</div><div class="muted small">${st.longs.count} largos</div></div>
      </div>
      <div class="grid g2">
        <div class="card stack"><h3>Diagnóstico</h3><p>${esc(ai.summary)}</p><p class="small"><b>Replicable como faceless:</b> ${esc(ai.faceless_score)}</p>
          <h3>Fortalezas</h3><ul>${li(ai.strengths)}</ul><h3>Debilidades</h3><ul>${li(ai.weaknesses)}</ul></div>
        <div class="card stack"><h3>Recomendaciones</h3><ul>${li(ai.recommendations)}</ul><h3>Patrones de títulos</h3><ul>${li(ai.title_patterns)}</ul></div>
        <div class="card"><h3>Vídeos más vistos</h3><table>${st.top.map(v => `<tr><td><a target="_blank" href="https://youtube.com/watch?v=${v.id}">${esc(v.title)}</a></td><td class="muted small" style="white-space:nowrap">${fmtN(v.views)}</td></tr>`).join('')}</table></div>
        <div class="card"><h3>Mejores días para publicar</h3><table>${st.bestDays.map(d => `<tr><td>${d.day}</td><td class="muted small">${fmtN(d.medianViews)} vistas (mediana) · ${d.count} vídeos</td></tr>`).join('')}</table>
          <h3 style="margin-top:14px">Ideas de vídeos</h3><ul>${li(ai.video_ideas)}</ul></div>
      </div>`;
  };
  $('#f').onsubmit = e => { e.preventDefault(); busy(e.target.querySelector('button'), async () => { const r = await api('/api/analyze', { method: 'POST', body: { target: e.target.target.value } }); show(r); }); };
  if (id) show(await api('/api/analyses/' + id));
};

// ---------- Estado del servidor ----------
routes.servidor = async () => {
  const [a, sys] = await Promise.all([api('/api/admin'), api('/api/system')]);
  const JOB = { 'shorts.start': 'Preparar vídeo', 'shorts.transcribe': 'Transcribir', 'shorts.pick': 'Elegir clips', 'clip.render': 'Render de Short', 'clip.translate': 'Traducir Short',
    'compose.script': 'Guion', 'compose.scene': 'Escena', 'compose.concat': 'Unir escenas' };
  main.innerHTML = `<h1>Estado del servidor</h1><p class="sub">Infraestructura y cola de trabajos.</p>
    <div class="grid g4" style="margin-bottom:16px">
      <div class="card"><div class="muted small">Alojamiento</div><div class="stat" style="font-size:20px">${a.vercel ? 'Vercel' : 'Servidor propio'}</div></div>
      <div class="card"><div class="muted small">Base de datos</div><div class="stat" style="font-size:20px">${a.db === 'postgres' ? 'Postgres (Neon)' : 'Local (PGlite)'}</div></div>
      <div class="card"><div class="muted small">Archivos</div><div class="stat" style="font-size:20px">${a.storage === 's3' ? 'S3 · ' + esc(/r2\.cloudflarestorage/.test(a.s3?.endpoint) ? 'Cloudflare R2' : /backblaze/.test(a.s3?.endpoint) ? 'Backblaze B2' : a.s3?.endpoint) : a.storage === 'blob' ? 'Vercel Blob' : 'Disco local'}</div>
        ${a.storage === 's3' ? `<div class="small muted">Bucket: ${esc(a.s3.bucket)}</div><button class="btn sm" id="cors" style="margin-top:6px">Configurar CORS</button>` : ''}</div>
      <div class="card"><div class="muted small">ffmpeg</div><div class="stat" style="font-size:20px">${sys.ffmpeg ? '✓ OK' : '✕ No'}</div></div>
    </div>
    <div class="card stack" style="margin-bottom:16px" id="cleanup"><h2>🧹 Limpieza automática de originales</h2><p class="muted small">Calculando…</p></div>
    <div class="card"><div class="row between"><h2>Cola de trabajos</h2><div class="row"><span class="pill">${a.queue.waiting} en espera</span><span class="pill processing">${a.queue.running} en curso</span><span class="pill error">${a.queue.failed} fallidos</span>
      <button class="btn sm" id="kick">▶ Procesar cola</button>${a.queue.failed ? '<button class="btn sm red" id="clean">Limpiar fallidos</button>' : ''}</div></div>
      ${a.jobs.length ? `<table><tr><th>#</th><th>Paso</th><th>Proyecto</th><th>Estado</th><th>Intentos</th><th>Error</th><th></th></tr>${a.jobs.map(j => `<tr><td>${j.id}</td><td>${JOB[j.type] || j.type}</td>
        <td>${j.payload.id ? `<a href="#/proyecto/${j.payload.id}">#${j.payload.id}</a>` : j.payload.clipId ? 'clip ' + j.payload.clipId : ''}</td><td>${pill(j.status === 'queued' ? 'pending' : j.status === 'running' ? 'processing' : 'error')}</td>
        <td>${j.attempts}</td><td class="small err">${esc((j.error || '').slice(0, 160))}</td><td>${j.status === 'failed' ? `<button class="btn sm" data-retry="${j.id}">Reintentar</button>` : ''}</td></tr>`).join('')}</table>` : '<p class="muted">La cola está vacía.</p>'}</div>`;
  api('/api/admin/cleanup').then(c => {
    const mb = b => b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : Math.round(b / 1e6) + ' MB';
    $('#cleanup').innerHTML = `<h2>🧹 Limpieza automática de originales</h2>
      <p class="small">${c.days > 0 ? `Los vídeos originales se borran <b>${c.days} día${c.days > 1 ? 's' : ''}</b> después de terminar el proyecto (cada día, automáticamente). Los clips y vídeos terminados se conservan.` : 'Desactivada: los originales no se borran.'}
        Cámbialo en <a href="#/ajustes">Ajustes y claves → Almacenamiento</a>.</p>
      ${c.count ? `<p class="small">Ahora mismo se pueden borrar <b>${c.count}</b> proyecto(s), unos <b>${mb(c.bytes)}</b>:</p>
        <ul class="small">${c.items.slice(0, 8).map(i => `<li><a href="#/proyecto/${i.id}">${esc(i.title || 'Proyecto ' + i.id)}</a> · ${mb(i.bytes)}</li>`).join('')}</ul>
        <div><button class="btn gold sm" id="cleanNow">🧹 Liberar espacio ahora</button></div>` : c.days > 0 ? '<p class="small muted">No hay originales pendientes de borrar.</p>' : ''}`;
    const bn = $('#cleanNow');
    if (bn) bn.onclick = () => { if (confirm(`Se borrarán los originales de ${c.count} proyecto(s). Los clips terminados se conservan, pero esos proyectos no se podrán volver a renderizar. ¿Continuar?`)) busy(bn, async () => { const r = await api('/api/admin/cleanup', { method: 'POST' }); toast(`${r.files} archivo(s) borrados`, 'good'); router(); }); };
  }).catch(e => { $('#cleanup').innerHTML = `<h2>🧹 Limpieza automática</h2><p class="err small">${esc(e.message)}</p>`; });
  const cb = $('#cors');
  if (cb) cb.onclick = e => busy(e.target, async () => {
    try { const r = await api('/api/admin/s3-cors', { method: 'POST' }); toast('CORS configurado para ' + r.origins.join(', '), 'good'); }
    catch (err) { toast('No se pudo configurar automáticamente (el token no tiene permiso de administración). Configúralo a mano: ver Ayuda → Cloudflare R2.', 'bad'); }
  });
  $('#kick').onclick = e => busy(e.target, async () => { await api('/api/admin/kick', { method: 'POST' }); toast('Procesando…'); setTimeout(router, 1500); });
  const c = $('#clean'); if (c) c.onclick = async () => { await api('/api/admin/jobs', { method: 'DELETE' }); router(); };
  main.querySelectorAll('[data-retry]').forEach(b => b.onclick = async () => { await api(`/api/admin/jobs/${b.dataset.retry}/retry`, { method: 'POST' }); router(); });
  if (a.queue.waiting || a.queue.running) poll(router, 4000);
};

// ---------- Ajustes y claves ----------
// Meta y TikTok solo aceptan direcciones https: en la app de escritorio la vuelta pasa por la web de Clippers Pro
const socialBase = () => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(location.origin) ? 'https://faceless-studio-chi.vercel.app' : location.origin;
routes.ajustes = async (_, params) => {
  const [{ values, fields }, sys0] = await Promise.all([api('/api/settings'), getSystem()]);
  const localMode = sys0.desktop && sys0.localAvailable;
  // App de escritorio: IA local; las claves de la nube quedan en una sección opcional y plegada
  const KEEP = ['local_llm', 'meta_app_id', 'meta_app_secret', 'meta_config_id', 'tiktok_client_key', 'tiktok_client_secret', 'whisper_model', 'caption_color', 'cleanup_days'];
  const groups = {}, cloud = {};
  for (const [k, f] of Object.entries(fields)) {
    if ((localMode && k === 'use_cloud') || (!localMode && k === 'local_llm')) continue;
    if (f.group === 'Marca') continue;
    const target = localMode && !KEEP.includes(k) ? cloud : groups;
    (target[f.group] ||= []).push([k, f]);
  }
  if (!localMode) delete groups.Nube;
  const card = ([g, list]) => `<div class="card stack"><h2>${g}</h2>
      ${list.map(([k, f]) => `<div><label>${f.label}</label>${f.options
        ? `<select name="${k}">${f.options.map(o => `<option ${values[k] === o ? 'selected' : ''}>${o}</option>`).join('')}</select>`
        : /^(openai|groq|openrouter)_model$/.test(k)
          ? `<input name="${k}" list="ml_${k}" data-models="${k.split('_')[0]}" value="${esc(values[k])}" placeholder="Elige de la lista" autocomplete="off"><datalist id="ml_${k}"></datalist><div class="small muted" data-mhint="${k}">Haz clic para ver los modelos disponibles con tu clave.</div>`
          : `<input name="${k}" ${f.secret ? 'type="password" autocomplete="off"' : ''} value="${esc(values[k])}" placeholder="${f.secret ? 'Pega tu clave' : ''}">`}</div>`).join('')}
      ${g.startsWith('IA') ? `<div class="row"><button type="button" class="btn sm" data-test="openai">Probar OpenAI</button><button type="button" class="btn sm" data-test="anthropic">Probar Claude</button><button type="button" class="btn sm" data-test="gemini">Probar Gemini</button><button type="button" class="btn sm" data-test="groq">Probar Groq</button><button type="button" class="btn sm" data-test="openrouter">Probar OpenRouter</button></div>` : ''}
      ${g === 'Publicar en YouTube' ? `<div class="small muted">URI de redirección autorizada para tu cliente OAuth:<br><code>${location.origin}/api/youtube/callback</code></div>` : ''}
      ${g === 'Redes sociales' ? `<div class="small muted">URIs de redirección para tus apps (cópialas tal cual):<br>Meta: <code>${socialBase()}/api/social/meta/callback</code><br>TikTok: <code>${socialBase()}/api/social/tiktok/callback</code><br>Pasos completos en <a href="#/ayuda">Ayuda</a>.</div>` : ''}
      </div>`;
  main.innerHTML = `<h1>Ajustes</h1><p class="sub">${localMode ? 'La IA funciona en tu equipo: transcripción, elección de clips, títulos e imágenes. No necesitas claves ni pagas por uso.' : 'Tus claves API se guardan cifradas en tu servidor y nunca se envían al navegador. Solo pagas lo que uses en cada proveedor.'}</p>
    <div id="localModels"></div>
    <form id="f" class="grid g2">${Object.entries(groups).map(card).join('')}
      ${localMode ? `<details class="card" id="cloudBox" style="grid-column:1/-1" ${values.use_cloud === '1' || params?.get('cloud') ? 'open' : ''}><summary style="cursor:pointer"><b>☁ Servicios en la nube (opcional)</b> <span class="small muted">— solo para Vídeo completo (voz y vídeos de stock), Analizador, Publicar en YouTube o si prefieres la IA de OpenAI/Gemini</span></summary>
        <div class="stack" style="margin-top:12px"><label class="check"><input type="checkbox" id="useCloud" ${values.use_cloud === '1' ? 'checked' : ''}> Usar los servicios en la nube con mis claves en vez de la IA local</label>
        <div class="grid g2">${Object.entries(cloud).map(card).join('')}</div></div></details>` : ''}
      <div style="grid-column:1/-1"><button class="btn gold">Guardar ajustes</button></div></form>`;
  const f = $('#f');
  f.onsubmit = e => {
    e.preventDefault();
    busy(f.querySelector('.btn.gold'), async () => { const body = Object.fromEntries(new FormData(f)); if ($('#useCloud')) body.use_cloud = $('#useCloud').checked ? '1' : '0';
      await api('/api/settings', { method: 'PUT', body }); toast('Ajustes guardados', 'good'); systemInfo = null; drawAiMode(true); router(); });
  };
  // Modelos de texto: lista real del proveedor; avisa si el nombre escrito no existe
  f.querySelectorAll('[data-models]').forEach(inp => {
    let loaded = null;
    const hint = f.querySelector(`[data-mhint="${inp.name}"]`);
    const check = () => {
      if (!loaded?.length) return;
      const ok = loaded.includes(inp.value.trim());
      hint.innerHTML = ok ? `✓ Modelo disponible (${loaded.length} en total)` : `⚠ <b>${esc(inp.value || '(vacío)')}</b> no existe en ${inp.dataset.models}: elige uno de la lista (si no, se usará el recomendado).`;
      hint.style.color = ok ? '' : 'var(--warn, #f59e0b)';
    };
    const load = async () => {
      if (loaded) return check();
      const r = await api('/api/ai-models/' + inp.dataset.models).catch(e => ({ error: e.message }));
      if (r.error) { hint.textContent = r.error; return; }
      loaded = r.models || [];
      f.querySelector('#ml_' + inp.name).innerHTML = loaded.map(m => `<option value="${esc(m)}">`).join('');
      check();
    };
    inp.addEventListener('focus', load); inp.addEventListener('input', check);
    load(); // al abrir Ajustes ya se avisa si el modelo guardado está mal escrito
  });
  f.querySelectorAll('[data-test]').forEach(b => b.onclick = () => busy(b, async () => {
    await api('/api/settings', { method: 'PUT', body: Object.fromEntries(new FormData(f)) });
    const r = await api('/api/settings/test', { method: 'POST', body: { provider: b.dataset.test } });
    toast(`${b.dataset.test}: conexión correcta (${r.reply})`, 'good');
  }));
  const sys = await getSystem();
  await localModelsCard();
  if (!localMode) await whisperCard();
  if (sys.desktop) await cloudCard();
};


/** Modelos de IA locales: estado, descarga (una vez) y progreso. */
async function localModelsCard() {
  const box = $('#localModels'); if (!box) return;
  const st0 = await api('/api/local-models').catch(() => null);
  if (!st0?.available) return;
  const draw = st => {
    box.innerHTML = `<div class="card stack" style="margin-bottom:20px"><h2>🧠 IA local (en tu equipo)</h2>
      <div class="small muted">Cada modelo se descarga una sola vez. Puedes descargarlos ahora o se descargarán solos la primera vez que se usen.</div>
      ${st.models.map(m => `<div class="row between" style="border-bottom:1px solid var(--line);padding:8px 0"><div><b>${esc(m.label)}</b><div class="small muted">${esc(m.use)} · ~${m.mb >= 1000 ? (m.mb / 1000).toFixed(1) + ' GB' : m.mb + ' MB'}</div></div>
        <div style="min-width:180px;text-align:right">${m.ready ? '<span class="pill ready">✓ Listo</span>' : m.download?.active ? pbar(m.download.pct, 'Descargando') : `${m.download?.error ? `<div class="err small">${esc(m.download.error)}</div>` : ''}<button class="btn sm gold" data-dl="${m.kind}:${m.id}">⬇ Descargar</button>`}</div></div>`).join('')}
      <div class="row"><button class="btn sm" id="dlAll">⬇ Descargar todo</button><span class="small muted">La IA de texto necesita unos 4–6 GB de memoria RAM libre.</span></div></div>`;
    box.querySelectorAll('[data-dl]').forEach(b => b.onclick = () => busy(b, async () => { const [kind, id] = b.dataset.dl.split(':'); await api('/api/local-models/download', { method: 'POST', body: { kind, id } }); poll(); }));
    $('#dlAll').onclick = e => busy(e.target, async () => { for (const m of st.models.filter(m => !m.ready)) await api('/api/local-models/download', { method: 'POST', body: { kind: m.kind, id: m.id } }); poll(); });
  };
  const poll = async () => { const st = await api('/api/local-models'); draw(st); if (st.models.some(m => m.download?.active) && document.body.contains(box)) setTimeout(poll, 1500); };
  draw(st0);
  if (st0.models.some(m => m.download?.active)) setTimeout(poll, 1500);
}

/** Transcripción local (whisper.cpp): estado del modelo y descarga. */
async function whisperCard() {
  const w = await api('/api/whisper').catch(() => null);
  if (!w?.available) return;
  const box = document.createElement('div');
  box.className = 'card stack'; box.style.marginTop = '20px';
  const draw = st => {
    box.innerHTML = `<h2>🎙 Transcripción local (gratis, en tu equipo)</h2>
      <p class="small muted" style="margin:0">Whisper funciona dentro de la app: no gasta saldo y tu audio no sale del ordenador. Elige "local" en <b>Transcripción</b> y el modelo arriba; el modelo se descarga una sola vez.</p>
      ${Object.entries(st.models).map(([k, m]) => `<div class="row between"><span>${esc(m.label)} ${k === st.model ? '<span class="pill">elegido</span>' : ''}</span>
        <span>${m.ready ? '<span class="pill ready">Descargado</span>' : m.download?.active ? pbar(m.download.pct, 'Descargando') : `<button class="btn sm" data-dl="${k}">⬇ Descargar</button>`}</span></div>`).join('')}
      ${st.provider !== 'local' ? '<div class="small" style="color:var(--gold)">Ahora mismo se transcribe con ' + esc(st.provider) + '. Cambia "Transcripción" a <b>local</b> arriba y guarda para usar Whisper en tu equipo.</div>' : ''}`;
    box.querySelectorAll('[data-dl]').forEach(b => b.onclick = () => busy(b, async () => { await api('/api/whisper/download', { method: 'POST', body: { model: b.dataset.dl } }); poll(); }));
  };
  const poll = async () => { const st = await api('/api/whisper'); draw(st); if (Object.values(st.models).some(m => m.download?.active) && document.body.contains(box)) setTimeout(poll, 1500); };
  draw(w);
  main.appendChild(box);
  if (Object.values(w.models).some(m => m.download?.active)) setTimeout(poll, 1500);
}

/** App de escritorio: guardar los vídeos en R2/S3 y (opcional) compartir la base de datos con la web. */
async function cloudCard() {
  const c = await api('/api/desktop/cloud');
  const box = document.createElement('div');
  box.className = 'card stack'; box.style.marginTop = '20px';
  const on = c.storage === 's3';
  box.innerHTML = `<h2>☁ Nube: guardar en R2 / S3 ${on ? '<span class="pill ready">Activa</span>' : '<span class="pill">Desactivada: se guarda en este ordenador</span>'}</h2>
    <p class="small muted">Los vídeos subidos y los clips se guardan en tu bucket (Cloudflare R2, Backblaze B2, AWS S3…). Si además pegas la <b>DATABASE_URL</b> de Neon y tu <b>APP_SECRET</b> de Vercel,
      la app de escritorio y la web comparten los mismos proyectos, vídeos y claves API, y tu ordenador también procesa la cola de la web (más rápido y sin el límite de 5 minutos).</p>
    <form id="cf" class="grid g2">
      <div><label>Endpoint S3</label><input name="S3_ENDPOINT" value="${esc(c.S3_ENDPOINT)}" placeholder="https://<cuenta>.r2.cloudflarestorage.com"></div>
      <div><label>Bucket</label><input name="S3_BUCKET" value="${esc(c.S3_BUCKET)}" placeholder="faceless-studio"></div>
      <div><label>Access Key ID</label><input name="S3_ACCESS_KEY_ID" value="${esc(c.S3_ACCESS_KEY_ID)}" autocomplete="off"></div>
      <div><label>Secret Access Key</label><input name="S3_SECRET_ACCESS_KEY" type="password" autocomplete="off" placeholder="${c.hasSecret ? '•••••• (guardada; déjalo vacío para no cambiarla)' : 'Pega la clave secreta'}"></div>
      <div><label>Región <span class="muted">(vacío para R2)</span></label><input name="S3_REGION" value="${esc(c.S3_REGION)}" placeholder="auto"></div>
      <div></div>
      <div><label>DATABASE_URL de Neon <span class="muted">(opcional: compartir proyectos con la web)</span></label><input name="DATABASE_URL" type="password" autocomplete="off" placeholder="${c.hasDb ? 'Conectada a ' + esc(c.dbHost) + ' (vacío = no cambiar)' : 'postgresql://usuario:clave@…neon.tech/neondb?sslmode=require'}"></div>
      <div><label>APP_SECRET de Vercel <span class="muted">(obligatorio si compartes la base de datos)</span></label><input name="APP_SECRET" type="password" autocomplete="off" placeholder="${c.hasAppSecret ? '•••••• (guardado)' : 'El mismo valor que en Vercel'}"></div>
      <div class="row" style="grid-column:1/-1">
        <button class="btn gold" id="csave">Probar, guardar y reiniciar</button>
        ${c.hasDb ? '<button type="button" class="btn" id="cnodb">Dejar de compartir la base de datos</button>' : ''}
        ${on ? '<button type="button" class="btn red" id="coff">Volver a guardar en este ordenador</button>' : ''}
      </div>
      <div class="small muted" style="grid-column:1/-1">Se prueba a escribir en el bucket (y a conectar con la base de datos) antes de guardar. ${c.encrypted ? 'Las claves se guardan cifradas en este ordenador.' : 'Las claves se guardan solo en este ordenador (este sistema no ofrece cifrado).'}
        Los proyectos que ya tenías en este ordenador no se mueven a la nube.</div>
    </form>`;
  main.appendChild(box);
  const f = box.querySelector('#cf');
  const restart = () => { main.innerHTML = '<div class="card"><span class="spinner"></span> Reiniciando la app con la nueva configuración…</div>'; setTimeout(() => location.reload(), 6000); };
  f.onsubmit = e => { e.preventDefault(); busy(box.querySelector('#csave'), async () => {
    await api('/api/desktop/cloud', { method: 'POST', body: Object.fromEntries(new FormData(f)) }); toast('Conexión correcta. Reiniciando…', 'good'); restart();
  }); };
  const nodb = box.querySelector('#cnodb');
  if (nodb) nodb.onclick = () => confirm('¿Dejar de usar la base de datos de la web? Volverás a ver los proyectos de este ordenador.') && busy(nodb, async () => {
    await api('/api/desktop/cloud', { method: 'POST', body: { ...Object.fromEntries(new FormData(f)), removeDb: true } }); restart();
  });
  const off = box.querySelector('#coff');
  if (off) off.onclick = () => confirm('¿Dejar de usar la nube? Los vídeos nuevos se guardarán en este ordenador.') && busy(off, async () => {
    await api('/api/desktop/cloud', { method: 'POST', body: { disable: true } }); restart();
  });
}

// ---------- Ayuda ----------
routes.ayuda = () => {
  main.innerHTML = `<h1>Ayuda</h1><p class="sub">Cómo sacar partido a tu estudio.</p><div class="grid g2">
  <div class="card stack"><h2>¿Qué claves necesito?</h2>
    <p><b>Mínimo para Shorts:</b> una clave de <b>OpenAI</b> (transcribe con Whisper y escribe títulos y ganchos). Alternativa más barata: <b>Groq</b> para transcribir + Claude/Gemini/OpenRouter para el texto.</p>
    <p><b>Vídeo completo:</b> IA de texto + voz (<b>OpenAI TTS</b> o <b>ElevenLabs</b>) + <b>Pixabay</b> (gratis; regístrate en pixabay.com y copia tu clave en pixabay.com/api/docs) o Pexels para vídeos de stock.</p>
    <p><b>Imágenes (Miniaturas IA):</b> elige el proveedor en Ajustes: <b>OpenAI</b>, <b>Gemini</b> (con tu clave de Gemini) o <b>Pollinations</b> (gratis, sin clave; con marca de agua y una imagen cada ~45 s). Si el elegido falla, se usan los demás.</p>
    <p><b>Analizador:</b> una <b>YouTube Data API key</b> (gratis en Google Cloud) o un canal conectado.</p>
    <p><b>Publicar:</b> credenciales OAuth de Google (gratis).</p></div>
  <div class="card stack"><h2>Herramientas</h2><ul>
    <li><b>Analizador:</b> pega un canal o vídeo de YouTube para ver estadísticas, mejores días, patrones de títulos e ideas.</li>
    <li><b>Estado del servidor:</b> mira la cola de trabajos y reintenta los que fallen.</li></ul></div>
  <div class="card stack"><h2>Convertir a Clips</h2><ol>
    <li>Sube un vídeo largo (o pega un enlace si el servidor tiene yt-dlp).</li>
    <li>Se transcribe con marcas de tiempo por palabra.</li>
    <li>La IA elige los mejores momentos, les pone nota del 1 al 10 y escribe un gancho.</li>
    <li>La nota viral combina el criterio de la IA (gancho, historia, emoción, valor, final) con señales medidas: picos de energía, risas, ritmo de habla y cambios de plano.</li>
    <li>Cada Short sale en 1080×1920 con <b>Recorte centrado en quien habla</b> (si hay varias personas en plano, detecta quién habla por el movimiento de la boca y corta a esa persona), recorte fijo o fondo difuminado, gancho 4 s arriba, subtítulos con el estilo elegido, palabras clave en color y emojis animados.</li>
    <li>Ajusta inicio/fin con ±1 s, cambia el gancho y pulsa <b>Aplicar cambios</b>.</li>
    <li>Descarga el .zip o publica directamente en YouTube.</li></ol></div>
  <div class="card stack"><h2>🖼 Miniaturas IA</h2><ol>
    <li>Escribe el título del vídeo y elige formato (YouTube 16:9, portada de Shorts 9:16 o cuadrada) y estilo.</li>
    <li>"✨ Ideas con IA" propone textos cortos y escenas pensadas para conseguir clics. Pulsa "🎨 Generar" en las que te gusten.</li>
    <li>Si subes tu foto o tu personaje, aparece en la imagen (con OpenAI o Gemini).</li>
    <li>Con "✨ Diseñado por la IA" (recomendado) Gemini dibuja el texto como parte del diseño, con la tipografía que pide el tema. Para cambiarlo, escribe el texto nuevo y pulsa "✏️ Cambiar con IA": edita la misma imagen. Necesita una clave de Gemini (o de OpenAI).</li>
    <li>Con "Superpuesto" el texto se pone encima y se cambia al instante sin gastar (texto, colores, posición, tamaño y giro).</li></ol></div>
  <div class="card stack"><h2>🏆 Rankings Top</h2><ol>
    <li>Pon un vídeo en cada puesto (el 1 es el mejor). Puedes subirlo o, en la app de escritorio, buscarlo en YouTube Shorts con el buscador del módulo o pegar un enlace de YouTube, TikTok o Instagram. Elige inicio y fin si solo quieres una parte.</li>
    <li>Escribe una etiqueta corta por puesto y el título. La palabra entre *asteriscos* sale en color; si no marcas ninguna, se resalta la última.</li>
    <li>"✨ Sugerir título y etiquetas" usa la IA a partir del tema y de tus notas.</li>
    <li>El vídeo sale en vertical 1080×1920: título arriba, números de colores a la izquierda y los clips en cuenta atrás (5 → 1). La etiqueta de cada puesto aparece cuando empieza su clip y se queda.</li></ol></div>
  <div class="card stack"><h2>🔴 Clips de directos</h2><ol>
    <li>Pega el enlace de un directo que esté emitiendo. La app lo graba por segmentos (2–4 min) sin recodificar y sin huecos entre ellos.</li>
    <li>Cada segmento se transcribe y la IA busca los momentos virales. También revisa el final del segmento anterior, así que los momentos que cruzan el corte no se pierden.</li>
    <li>Solo se cortan los momentos con la nota mínima que elijas. Los clips aparecen mientras el directo sigue.</li>
    <li>Pulsa <b>Detener directo</b> cuando quieras. Si el directo termina o se llega al máximo de minutos, se detiene solo.</li>
    <li><b>En Vercel</b> solo funcionan enlaces directos <code>.m3u8</code>. Para <b>YouTube, Twitch o Kick</b> instala la app en tu PC con Linux: yt-dlp obtiene la emisión. Allí también funcionan <code>rtmp://</code>, <code>srt://</code> y <code>rtsp://</code>.</li></ol></div>
  <div class="card stack"><h2>Almacenamiento gratis: Cloudflare R2</h2>
    <p class="small">Vercel Blob cobra cada descarga de vídeo; R2 da 10 GB gratis y <b>descargas ilimitadas gratis</b>.</p><ol>
    <li>En Cloudflare: <b>R2 Object Storage → Create bucket</b>.</li>
    <li><b>Manage API tokens → Create API token</b> con permiso <i>Object Read &amp; Write</i> sobre ese bucket. Copia Access Key ID, Secret y el endpoint <code>https://&lt;cuenta&gt;.r2.cloudflarestorage.com</code>.</li>
    <li>En el bucket: <b>Settings → CORS policy</b> y pega:<br><code style="word-break:break-all">[{"AllowedOrigins":["${location.origin}"],"AllowedMethods":["GET","PUT","HEAD"],"AllowedHeaders":["*"],"ExposeHeaders":["ETag","Content-Length"],"MaxAgeSeconds":3600}]</code></li>
    <li>En Vercel añade <code>S3_ENDPOINT</code>, <code>S3_BUCKET</code>, <code>S3_ACCESS_KEY_ID</code>, <code>S3_SECRET_ACCESS_KEY</code> y haz Redeploy.</li></ol></div>
  <div class="card stack"><h2>Conectar YouTube</h2><ol>
    <li>Entra en <a href="https://console.cloud.google.com/" target="_blank">Google Cloud Console</a> y crea un proyecto.</li>
    <li>Activa <b>YouTube Data API v3</b>.</li>
    <li>En "Pantalla de consentimiento OAuth" elige Externo y añade tu correo como usuario de prueba.</li>
    <li>En "Credenciales" crea un <b>ID de cliente OAuth → Aplicación web</b> con la URI de redirección:<br><code>${location.origin}/api/youtube/callback</code></li>
    <li>Pega el Client ID y Secret en Ajustes y claves, y pulsa "Conectar YouTube" en Mis canales.</li></ol>
    <p class="muted small">Nota: los proyectos de Google no verificados suben los vídeos como privados hasta que pases la auditoría de la API.</p></div>
  <div class="card stack"><h2>Publicar en Instagram y Facebook</h2><ol>
    <li>Tu Instagram tiene que ser una <b>cuenta profesional</b> (empresa o creador) <b>vinculada a una página de Facebook</b> (Instagram → Configuración → Cuenta → Cambiar a cuenta profesional; y en la página de Facebook → Configuración → Cuentas vinculadas).</li>
    <li>Entra en <a href="https://developers.facebook.com/apps" target="_blank">developers.facebook.com/apps</a> → <b>Crear app</b>. En "Casos de uso" elige <b>Otro</b> y en tipo de app <b>Empresa</b>. (Si ya creaste la app con otro caso de uso, sigue con el paso siguiente.)</li>
    <li>En el panel de la app → <b>Casos de uso</b> → <b>Agregar casos de uso</b>, añade:<br>
      • <b>Administrar todo en tu página</b> (Manage everything on your Page) → <b>Personalizar</b> → añade los permisos <code>pages_show_list</code>, <code>pages_read_engagement</code> y <code>pages_manage_posts</code>.<br>
      • <b>Administrar mensajes y contenido en Instagram</b> → <b>Configuración de la API con inicio de sesión con Facebook</b> → añade <code>instagram_basic</code> e <code>instagram_content_publish</code>.<br>
      <span class="muted">Si al conectar Facebook dice <i>"Invalid Scopes"</i>, es que falta alguno de estos casos de uso o permisos.</span></li>
    <li>Añade también el producto <b>Inicio de sesión con Facebook</b> (si no aparece ya) y en su <b>Configuración</b>, en <b>URI de redireccionamiento de OAuth válidos</b>, pega:<br><code>${socialBase()}/api/social/meta/callback</code></li>
    <li>En Configuración de la app → Básica copia el <b>Identificador de la app</b> y la <b>Clave secreta</b> y pégalos en Ajustes y claves (Meta App ID / Secret). Deja vacío el "Configuration ID" salvo que uses Facebook Login for Business.</li>
    <li>Mientras la app está en modo desarrollo solo funciona con tu cuenta (y las que añadas en Roles como administradores o probadores): para publicar en <b>tus propias</b> páginas y cuentas no necesitas la revisión de Meta.</li>
    <li>En Mis canales → Redes sociales pulsa <b>Conectar Facebook / Instagram</b> y acepta todas las páginas y permisos.</li></ol>
    <p class="muted small">Si tu app usa "Facebook Login for Business", crea una configuración con los permisos de páginas e Instagram y pega su Configuration ID en Ajustes.</p></div>
  <div class="card stack"><h2>Publicar en TikTok</h2><ol>
    <li>Entra en <a href="https://developers.tiktok.com/apps" target="_blank">developers.tiktok.com</a> → <b>Manage apps → Connect an app</b>.</li>
    <li>Añade los productos <b>Login Kit</b> y <b>Content Posting API</b>, con los permisos <code>user.info.basic</code>, <code>video.upload</code> y <code>video.publish</code>.</li>
    <li>En Login Kit añade la URI de redirección:<br><code>${socialBase()}/api/social/tiktok/callback</code></li>
    <li>Copia el <b>Client key</b> y el <b>Client secret</b> en Ajustes y claves.</li>
    <li>En Mis canales → Redes sociales pulsa <b>Conectar TikTok</b>.</li></ol>
    <p class="muted small">Hasta que TikTok audite tu app, los vídeos se envían a tus <b>borradores de TikTok</b> (te llega un aviso en la app de TikTok para publicarlo con un toque) o se publican en privado. Para publicar directamente en público, solicita la auditoría en el portal de desarrolladores.</p></div>
  <div class="card stack"><h2>Consejos</h2><ul>
    <li>Usa vídeos que sean tuyos o con permiso: subir contenido ajeno puede generar reclamaciones de derechos de autor.</li>
    <li>Los ganchos cortos (3–6 palabras) funcionan mejor.</li>
    <li>Programa 1–3 clips al día con el calendario.</li></ul></div></div>`;
};

router();
