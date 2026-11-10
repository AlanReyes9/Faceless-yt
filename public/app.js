// Faceless Studio — frontend sin dependencias (SPA con rutas por hash)
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
  ['HERRAMIENTAS', [['nichos', '⌕', 'Buscador de nichos'], ['completo', '▶', 'Vídeo completo'], ['shorts', '✂', 'Convertir a Shorts'],
    ['personaje', '☺', 'Personaje IA'], ['anuncios', '✦', 'Creador de anuncios IA'], ['montar', '⧉', 'Montar mi material'], ['analizador', '◎', 'Analizador']]],
  ['CUENTA', [['ajustes', '⚿', 'Ajustes y claves'], ['papelera', '🗑', 'Papelera'], ['ayuda', '?', 'Ayuda']]],
  ['ADMINISTRACIÓN', [['servidor', '⚙', 'Estado del servidor']]],
];
function renderNav(route) {
  $('#nav').innerHTML = NAV.map(([h, items]) => `<div class="nav-h">${h}</div>` + items.map(([r, ic, label]) =>
    `<a class="nav-a ${route === r ? 'active' : ''}" href="#/${r}"><span class="ic">${ic}</span>${label}</a>`).join('')).join('');
}
$('#menuBtn').onclick = () => $('#sidebar').classList.toggle('open');

let pollTimer = null;
function poll(fn, ms = 3000) { clearTimeout(pollTimer); pollTimer = setTimeout(fn, ms); }

const routes = {};
async function router() {
  clearTimeout(pollTimer);
  $('#sidebar').classList.remove('open');
  const [path, query] = location.hash.replace(/^#\/?/, '').split('?');
  const [route, arg] = path.split('/');
  const params = new URLSearchParams(query || '');
  renderNav(route === 'proyecto' ? 'videos' : route);
  const me = await api('/api/me').catch(() => ({ authed: false, setup: [] }));
  if (me.blocked) return renderSetup(me.setup, me);
  if (route !== 'login' && !me.authed) { location.hash = '#/login'; return; }
  main.innerHTML = '<div class="muted"><span class="spinner"></span> Cargando…</div>';
  try { await (routes[route] || routes[''])(arg, params); }
  catch (e) { main.innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', router);

let systemInfo = null;
const getSystem = async () => (systemInfo ||= await api('/api/system'));

/** Sube un archivo y devuelve su referencia. En Vercel va directo a Blob (archivos grandes). */
async function uploadFile(file, onProgress = () => {}) {
  const sys = await getSystem();
  if (sys.storage === 's3') {
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
    xhr.onerror = () => reject(new Error('Error de red al subir'));
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
const TYPE_LABEL = { shorts: '✂ Shorts', long: '▶ Completo', ad: '✦ Anuncio', montage: '⧉ Montaje' };

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
routes.login = () => {
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
  const hasLLM = v[v.llm_provider + '_key'];
  const steps = [
    [!!hasLLM, `Añade tu clave de IA de texto (${v.llm_provider})`, 'ajustes'],
    [!!(v.transcribe_provider === 'groq' ? v.groq_key : v.openai_key), 'Añade una clave para transcribir (OpenAI o Groq)', 'ajustes'],
    [s.channels > 0, 'Crea tu primer canal', 'canales'],
    [s.shorts > 0, 'Convierte un vídeo largo en Shorts', 'shorts'],
  ];
  main.innerHTML = `
    <h1>Hola 👋</h1><p class="sub">Tu fábrica de contenido faceless con tus propias claves de IA.</p>
    ${!sys.ffmpeg ? '<div class="card err" style="margin-bottom:16px">ffmpeg no está instalado en el servidor. Sin él no se pueden renderizar vídeos.</div>' : ''}
    ${sys.vercel && sys.db !== 'postgres' ? '<div class="card err" style="margin-bottom:16px">⚠ No hay base de datos conectada: los datos se perderán. En Vercel abre el proyecto → <b>Storage</b> → conecta una base de datos <b>Neon</b> y vuelve a desplegar.</div>' : ''}
    ${sys.vercel && sys.storage === 'local' ? '<div class="card err" style="margin-bottom:16px">⚠ No hay almacenamiento de archivos: configura <b>Cloudflare R2</b> (ver Ayuda) o conecta un Blob store en Vercel → Storage.</div>' : ''}
    <div class="grid g4" style="margin-bottom:16px">
      <div class="card"><div class="muted small">Canales</div><div class="stat">${s.channels}</div></div>
      <div class="card"><div class="muted small">Proyectos</div><div class="stat">${s.projects}</div></div>
      <div class="card"><div class="muted small">Shorts listos</div><div class="stat">${s.shorts}</div></div>
      <div class="card"><div class="muted small">Publicados</div><div class="stat">${s.published}</div></div>
    </div>
    <div class="grid g2">
      <div class="card"><h2>Primeros pasos</h2>${steps.map(([ok, t, r]) => `<div style="display:flex;gap:10px;padding:6px 0"><span>${ok ? '✅' : '⬜'}</span><a href="#/${r}" style="color:${ok ? 'var(--muted)' : 'var(--text)'}">${t}</a></div>`).join('')}
        <div class="row" style="margin-top:14px"><a class="btn gold" href="#/shorts">✂ Convertir a Shorts</a><a class="btn" href="#/completo">▶ Vídeo completo</a></div></div>
      <div class="card"><h2>Próximas publicaciones</h2>${s.upcoming.length ? s.upcoming.map(i => `<div class="row between" style="padding:5px 0"><span>${esc(i.title)}</span><span class="muted small">${i.date}</span></div>`).join('') : '<p class="muted">Nada programado. <a href="#/calendario">Planifica tu calendario</a>.</p>'}</div>
      <div class="card" style="grid-column:1/-1"><h2>Proyectos recientes</h2>${projectTable(s.recent)}</div>
    </div>`;
};
function projectTable(rows, trash = false) {
  if (!rows.length) return '<p class="muted">Aún no hay proyectos.</p>';
  return `<table><tr><th>Proyecto</th><th>Tipo</th><th>Estado</th><th>Fecha</th><th></th></tr>${rows.map(p => `<tr>
    <td><a href="#/proyecto/${p.id}">${esc(p.title || 'Sin título')}</a>${['pending', 'processing'].includes(p.status) ? `<div style="max-width:320px;margin-top:4px">${pbar(p.percent, p.progress || 'En cola…')}</div>` : p.status === 'error' && p.error ? `<div class="err small">${esc(p.error.slice(0, 120))}</div>` : ''}</td>
    <td>${TYPE_LABEL[p.type] || p.type}${p.type === 'shorts' && p.ready_clips != null ? ` (${p.ready_clips})` : ''}</td>
    <td>${pill(p.status)}</td><td class="muted small">${(p.created_at || '').slice(0, 16)}</td>
    <td style="text-align:right">${trash ? `<button class="btn sm" data-restore="${p.id}">Restaurar</button> <button class="btn sm red" data-purge="${p.id}">Borrar definitivamente</button>` : ''}</td></tr>`).join('')}</table>`;
}

// ---------- Canales ----------
routes.canales = async (_, params) => {
  if (params.get('ok')) toast('Canal conectado con YouTube', 'good');
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
        <button class="btn gold">Guardar canal</button></form></div>`;
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
  main.innerHTML = `<div class="row between"><div><h1>Mis vídeos</h1><p class="sub">Todos tus proyectos de Shorts y vídeos completos.</p></div>
    <div class="row"><a class="btn gold" href="#/shorts">✂ Nuevo Shorts</a><a class="btn" href="#/completo">▶ Nuevo vídeo</a></div></div>
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

// ---------- Convertir a Shorts ----------
routes.shorts = async () => {
  const [chs, sys] = await Promise.all([channelsCache.get(), getSystem()]);
  main.innerHTML = `<h1>Convertir a Shorts</h1><p class="sub">Sube un vídeo largo. La IA lo transcribe, encuentra los mejores momentos y crea Shorts verticales con gancho y subtítulos.</p>
  <form id="f" class="grid g2">
    <div class="card stack">
      <h2>1. Vídeo de origen</h2>
      <div class="drop" id="drop"><div style="font-size:30px">⬆</div><b>Arrastra tu vídeo aquí</b><div class="muted small">o haz clic para elegirlo (mp4, mov, mkv…)</div><div id="fname" class="small" style="margin-top:8px;color:var(--gold)"></div></div>
      <input type="file" name="video" accept="video/*" hidden>
      <div><label>…o pega un enlace (YouTube, etc.) ${sys.ytdlp ? '' : `<span class="muted">— ${sys.vercel ? 'no disponible en Vercel, sube el archivo' : 'yt-dlp no está instalado en el servidor'}</span>`}</label><input name="url" placeholder="https://www.youtube.com/watch?v=…" ${sys.ytdlp ? '' : 'disabled'}></div>
      <div><label>Título del proyecto (opcional)</label><input name="title"></div>
      <div><label>Canal</label><select name="channel_id">${channelOptions(chs)}</select></div>
    </div>
    <div class="card stack">
      <h2>2. Opciones</h2>
      <div class="row"><div style="flex:1"><label>Nº de Shorts</label><input type="number" name="count" value="10" min="1" max="30"></div>
        <div style="flex:1"><label>Duración mín. (s)</label><input type="number" name="minSec" value="20" min="5"></div>
        <div style="flex:1"><label>Duración máx. (s)</label><input type="number" name="maxSec" value="60" min="10" max="180"></div></div>
      <div class="row"><div style="flex:1"><label>Encuadre</label><select name="layout">
          <option value="face">Recorte centrado en quien habla (automático, recomendado)</option>
          <option value="crop">Recorte centrado fijo (centro de la imagen)</option><option value="blur">Fondo difuminado (vídeo completo centrado)</option></select></div>
        <div style="flex:1"><label>Estilo de subtítulos</label><select name="captionStyle">${opts(CAP_STYLES, 'impacto')}</select></div></div>
      <div class="row"><div style="flex:1"><label>Idioma del audio</label><select name="language"><option value="">Detectar automáticamente</option>${Object.entries(LANGS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
        <div style="flex:1"><label>Idioma de títulos y ganchos</label><select name="titleLanguage"><option value="">Igual que el vídeo</option>${Object.entries(LANGS).map(([k, v]) => `<option value="${v}">${v}</option>`).join('')}</select></div></div>
      <label class="check"><input type="checkbox" name="captions" checked> Subtítulos palabra a palabra</label>
      <label class="check"><input type="checkbox" name="emojis" checked> Emojis animados y palabras clave resaltadas</label>
      <div id="up" class="small muted"></div>
      <button class="btn gold block" id="go">✂ Crear Shorts</button>
    </div>
  </form>
  <h2 style="margin-top:28px">Proyectos de Shorts</h2><div id="list" class="card"></div>`;
  const f = $('#f'), file = f.video, drop = $('#drop');
  drop.onclick = () => file.click();
  file.onchange = () => { $('#fname').textContent = file.files[0]?.name || ''; };
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); file.files = e.dataTransfer.files; file.onchange(); };
  f.onsubmit = async e => {
    e.preventDefault();
    if (!file.files[0] && !f.url.value) return toast('Sube un vídeo o pega un enlace', 'bad');
    const go = $('#go'); go.disabled = true;
    try {
      const d = Object.fromEntries(new FormData(f)); delete d.video;
      d.captions = f.captions.checked; d.emojis = f.emojis.checked;
      if (file.files[0]) { d.source = await uploadFile(file.files[0], pct => { $('#up').textContent = `Subiendo… ${pct}%`; }); d.filename = file.files[0].name; }
      const r = await api('/api/shorts', { method: 'POST', body: d });
      location.hash = '#/proyecto/' + r.id;
    } catch (err) { toast(err.message, 'bad'); go.disabled = false; $('#up').textContent = ''; }
  };
  const list = await api('/api/projects?type=shorts');
  $('#list').innerHTML = projectTable(list);
};

// ---------- Proyecto (Shorts o completo) ----------
routes.proyecto = async id => {
  const [p, chs] = await Promise.all([api('/api/projects/' + id), channelsCache.get()]);
  const working = ['pending', 'processing'].includes(p.status) || p.clips?.some(c => c.status === 'rendering');
  const head = `<div class="row between" style="margin-bottom:16px"><div><a href="#/videos" class="small">← Mis vídeos</a><h1>${esc(p.title || 'Proyecto')}</h1>
      <div class="row small muted">${pill(p.status)} ${p.duration ? '· ' + mmss(p.duration) : ''} ${p.progress ? '· ' + esc(p.progress) : ''}</div></div>
    <div class="row">${p.type === 'shorts' && p.clips?.length ? `<a class="btn gold" href="/api/projects/${p.id}/zip">⬇ Descargar .zip</a>` : ''}
      ${p.status === 'error' ? '<button class="btn" id="retry">↻ Reintentar</button>' : ''}<button class="btn red" id="del">Eliminar</button></div></div>
    ${p.error ? `<div class="card err" style="margin-bottom:16px">${esc(p.error)}</div>` : ''}
    ${cleanupBanner(p)}
    ${['pending', 'processing'].includes(p.status) ? `<div class="progress stack" style="margin-bottom:16px">${pbar(p.percent, p.progress || 'Procesando…')}
      <div class="muted small">Puedes cerrar esta página: el servidor sigue trabajando. ${p.type === 'shorts' ? 'Los Shorts se renderizan de uno en uno.' : ''}</div></div>` : ''}`;
  main.innerHTML = head + (p.type === 'shorts' ? shortsGrid(p, chs) : longView(p, chs));
  const r = $('#retry'); if (r) r.onclick = () => busy(r, async () => { await api(`/api/projects/${p.id}/retry`, { method: 'POST' }); router(); });
  $('#del').onclick = async () => { if (confirm('¿Mover a la papelera?')) { await api('/api/projects/' + p.id, { method: 'DELETE' }); location.hash = '#/videos'; } };
  main.querySelectorAll('[data-keep]').forEach(b => b.onclick = () => busy(b, async () => {
    await api('/api/projects/' + p.id, { method: 'PATCH', body: { keepSource: b.dataset.keep === '1' } });
    toast(b.dataset.keep === '1' ? 'El original se conservará' : 'Se borrará automáticamente', 'good'); router();
  }));
  if (p.type === 'shorts') bindClips(p); else bindLong(p);
  if (p.cleanup?.deletedAt) main.querySelectorAll('[data-apply],[data-tr],[data-retry],#retry').forEach(b => { b.disabled = true; b.title = 'El original se borró: no se puede volver a renderizar'; });
  if (working) livePoll(p);
};

// Firma de lo que cambia la estructura de la página (si no cambia, solo se actualizan las barras)
const projSig = p => [p.status, p.error, p.output, ...(p.clips || []).map(c => `${c.id}:${c.status}:${c.file}:${Object.keys(c.variants || {}).join(',')}`)].join('|');
function livePoll(prev) {
  const sig = projSig(prev);
  poll(async () => {
    if (!location.hash.startsWith('#/proyecto/' + prev.id)) return;
    let p;
    try { p = await api('/api/projects/' + prev.id); } catch { return livePoll(prev); }
    const editing = document.activeElement && main.contains(document.activeElement) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
    if (projSig(p) !== sig && !editing) return router(); // algo terminó o cambió: redibujar
    // Solo actualizar las barras de progreso, sin tocar los vídeos que se estén viendo
    const top = main.querySelector('.progress .pbar');
    if (top) top.outerHTML = pbar(p.percent, p.progress || 'Procesando…');
    for (const c of p.clips || []) {
      const box = main.querySelector(`[data-clip="${c.id}"] .vid .pbar`);
      if (box && c.status === 'rendering') box.outerHTML = pbar(c.progress, c.stage || 'En cola…');
    }
    livePoll(projSig(p) === sig ? p : prev);
  }, 3000);
}

function shortsGrid(p, chs) {
  if (!p.clips?.length) return p.status === 'ready' ? '<div class="empty">No se generaron clips.</div>' : '';
  return `<div class="shorts">${p.clips.map(c => {
    const dur = c.end - c.start;
    const langs = Object.entries(c.variants || {}).filter(([, v]) => v.url);
    return `<div class="clip" data-clip="${c.id}">
      <div class="vid"><button class="btn sm xbtn" data-x title="Eliminar clip">✕</button>${c.url && c.status !== 'rendering' ? `<video src="${c.url}" controls preload="metadata" playsinline></video>`
        : c.status === 'error' ? `<div class="stack" style="padding:14px;text-align:center"><div style="font-size:26px">⚠️</div><div class="err small">${esc(friendlyError(c.error))}</div><button class="btn sm gold" data-retry>↻ Reintentar</button></div>`
        : `<div style="width:80%">${pbar(c.progress, c.stage || 'En cola…')}</div>`}</div>
      <div class="body">
        <div class="row" style="gap:5px"><b>#${c.idx}</b><span class="pill">${c.score}/10</span><span class="pill">${c.layout === 'face' ? 'quien habla' : c.layout === 'crop' ? 'recorte fijo' : 'fondo difuminado'}</span></div>
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
        <details><summary>📤 Publicar este Short</summary><div class="stack" style="margin-top:6px">
          ${c.yt_video_id ? `<a class="small" target="_blank" href="https://youtube.com/shorts/${c.yt_video_id}">✓ Publicado en YouTube</a>` : ''}
          <select data-ch>${channelOptions(chs.filter(x => x.connected), p.channel_id, 'Elige canal conectado')}</select>
          <select data-pub-lang><option value="">Versión original</option>${langs.map(([l]) => `<option value="${l}">${LANGS[l] || l}</option>`).join('')}</select>
          <select data-priv><option value="public">Público</option><option value="unlisted">Oculto</option><option value="private">Privado</option></select>
          <div><label>Programar (opcional)</label><input type="datetime-local" data-at></div>
          <button class="btn gold sm" data-pub>Publicar ahora</button></div></details>
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
    $('[data-pub]', el).onclick = e => busy(e.target, async () => {
      const channel_id = $('[data-ch]', el).value;
      if (!channel_id) throw new Error('Elige un canal conectado a YouTube (Mis canales).');
      const at = $('[data-at]', el).value;
      const r = await api(`/api/clips/${c.id}/publish`, { method: 'POST', body: {
        channel_id, lang: $('[data-pub-lang]', el).value, privacy: $('[data-priv]', el).value,
        title: $('[data-f=title]', el).value, publishAt: at ? new Date(at).toISOString() : undefined } });
      toast('¡Publicado! ' + r.url, 'good'); router();
    });
  });
}

// ---------- Vídeo completo ----------
routes.completo = async (_, params) => {
  const [chs, settings, chars] = await Promise.all([channelsCache.get(), api('/api/settings'), api('/api/characters')]);
  const preChar = params.get('personaje');
  main.innerHTML = `<h1>Vídeo completo</h1><p class="sub">De una idea a un vídeo terminado: guion con IA → voz en off → vídeos de stock → subtítulos.</p>
  <div class="grid g2">
    <form class="card stack" id="f">
      <div><label>Tema o idea del vídeo</label><textarea name="topic" required placeholder="Ej: La historia del robo de banco más increíble de la historia"></textarea></div>
      <div class="row"><div style="flex:1"><label>Canal</label><select name="channel_id">${channelOptions(chs)}</select></div>
        <div style="flex:1"><label>Idioma</label><select name="language">${Object.entries(LANGS).map(([k, v]) => `<option value="${v}">${v}</option>`).join('')}</select></div></div>
      <div class="row"><div style="flex:1"><label>Duración (min)</label><input type="number" name="minutes" value="3" min="0.5" max="20" step="0.5"></div>
        <div style="flex:1"><label>Formato</label><select name="format"><option value="horizontal">Horizontal 16:9</option><option value="vertical">Vertical 9:16 (Short)</option></select></div></div>
      <div><label>Estilo de narración</label><input name="style" value="documental, narrativo, con intriga"></div>
      <div class="row"><div style="flex:1"><label>Imágenes del vídeo</label><select name="visual">
          <option value="stock">Vídeos de stock (Pixabay / Pexels)</option><option value="character" ${preChar ? 'selected' : ''}>Imágenes IA con mi personaje</option><option value="none">Fondo liso</option></select></div>
        <div style="flex:1"><label>Personaje (narrador)</label><select name="characterId"><option value="">Ninguno</option>${chars.map(c => `<option value="${c.id}" ${c.id == preChar ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div></div>
      <label class="check"><input type="checkbox" name="captions" checked> Subtítulos</label>
      <div class="muted small">Voz: ${settings.values.tts_provider} · Stock: ${settings.values.pixabay_key || settings.values.pexels_key ? [settings.values.pixabay_key && 'Pixabay ✓', settings.values.pexels_key && 'Pexels ✓'].filter(Boolean).join(' · ') : '<span class="err">sin clave de vídeos de stock (fondo liso): añade Pixabay en Ajustes</span>'}</div>
      <div class="row"><button type="button" class="btn" id="draft">✎ Generar guion para revisar</button><button class="btn gold" id="go">▶ Crear vídeo directamente</button></div>
    </form>
    <div class="card" id="script"><h2>Guion</h2><p class="muted">Genera un borrador para revisarlo y editarlo antes de producir el vídeo.</p></div>
  </div>
  <h2 style="margin-top:28px">Vídeos completos</h2><div class="card" id="list"></div>`;
  const f = $('#f');
  const opts = () => { const d = Object.fromEntries(new FormData(f)); d.type = 'long'; d.captions = f.captions.checked; d.minutes = Number(d.minutes); d.characterId = Number(d.characterId) || null; if (d.visual === 'character' && !d.characterId) throw new Error('Elige un personaje para usar imágenes IA.'); return d; };
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
      <div class="row" style="margin-top:10px"><a class="btn" href="${p.outputUrl}" download="video_${p.id}.mp4" target="_blank">⬇ Descargar MP4</a></div>` : '<div class="empty">El vídeo aparecerá aquí cuando termine.</div>'}</div>
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

// ---------- Personaje IA ----------
routes.personaje = async () => {
  const list = await api('/api/characters');
  main.innerHTML = `<h1>Personaje IA</h1><p class="sub">Crea un personaje con aspecto, personalidad y voz propios. Genera imágenes coherentes y úsalo como narrador en tus vídeos.</p>
  <div class="grid g2">
    <form class="card stack" id="f"><h2 id="fh">Nuevo personaje</h2><input type="hidden" name="id">
      <div class="row"><input id="idea" placeholder="Idea rápida: un zorro detective con gabardina…" style="flex:1"><button type="button" class="btn sm" id="suggest">✨ Sugerir</button></div>
      <div><label>Nombre</label><input name="name" required></div>
      <div><label>Aspecto (en inglés funciona mejor para las imágenes)</label><textarea name="description" placeholder="A red fox detective wearing a brown trench coat and a fedora, green eyes…"></textarea></div>
      <div><label>Personalidad y forma de hablar</label><textarea name="personality" placeholder="Sarcástico, curioso, habla con frases cortas…"></textarea></div>
      <div><label>Estilo visual</label><input name="style" placeholder="3D Pixar style, cinematic lighting"></div>
      <div><label>Voz (opcional)</label><input name="voice" placeholder="openai:nova · openai:onyx · elevenlabs:VOICE_ID"></div>
      <button class="btn gold">Guardar personaje</button></form>
    <div class="stack" id="list">${list.length ? '' : '<div class="empty">Aún no tienes personajes.</div>'}</div>
  </div>`;
  const f = $('#f');
  $('#suggest').onclick = e => busy(e.target, async () => {
    const r = await api('/api/characters/suggest', { method: 'POST', body: { idea: $('#idea').value } });
    for (const k of ['name', 'description', 'personality', 'style']) f[k].value = r[k] || '';
  });
  f.onsubmit = e => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(f));
    busy(f.querySelector('.gold'), async () => { await api('/api/characters' + (d.id ? '/' + d.id : ''), { method: d.id ? 'PUT' : 'POST', body: d }); toast('Personaje guardado', 'good'); router(); });
  };
  $('#list').insertAdjacentHTML('beforeend', list.map(c => `<div class="card stack" data-c="${c.id}">
    <div class="row between"><h3>${esc(c.name)}</h3><div class="row"><button class="btn sm" data-edit>Editar</button><button class="btn sm red" data-del>Eliminar</button></div></div>
    <div class="muted small">${esc(c.personality)}</div>
    <div class="row" style="gap:8px">${c.imageUrls.map((u, i) => `<div style="position:relative"><img src="${u}" style="width:90px;height:135px;object-fit:cover;border-radius:8px"><button class="btn sm xdel" data-img="${i}" style="position:absolute;top:2px;right:2px;padding:0 6px">✕</button></div>`).join('') || '<span class="muted small">Sin imágenes todavía.</span>'}</div>
    <div class="row"><input data-prompt placeholder="Escena opcional: en una calle lluviosa de noche…" style="flex:1"><button class="btn sm gold" data-gen>🎨 Generar imagen</button></div>
    <div class="row"><label class="btn sm" style="margin:0">⬆ Subir imagen de referencia<input type="file" accept="image/*" data-up hidden></label><span class="small muted" data-st></span>
      <a class="btn sm" href="#/completo?personaje=${c.id}">▶ Crear vídeo con ${esc(c.name)}</a></div></div>`).join(''));
  main.querySelectorAll('[data-c]').forEach(el => {
    const c = list.find(x => x.id == el.dataset.c);
    $('[data-edit]', el).onclick = () => { for (const k of ['id', 'name', 'description', 'personality', 'style', 'voice']) f[k].value = c[k] || ''; $('#fh').textContent = 'Editar personaje'; f.scrollIntoView({ behavior: 'smooth' }); };
    $('[data-del]', el).onclick = async () => { if (confirm('¿Eliminar el personaje y sus imágenes?')) { await api('/api/characters/' + c.id, { method: 'DELETE' }); router(); } };
    $('[data-gen]', el).onclick = e => busy(e.target, async () => { await api(`/api/characters/${c.id}/image`, { method: 'POST', body: { prompt: $('[data-prompt]', el).value } }); router(); });
    $('[data-up]', el).onchange = async e => {
      try { const ref = await uploadFile(e.target.files[0], p => { $('[data-st]', el).textContent = p + '%'; }); await api(`/api/characters/${c.id}/images`, { method: 'POST', body: { ref } }); router(); }
      catch (err) { toast(err.message, 'bad'); }
    };
    el.querySelectorAll('[data-img]').forEach(b => b.onclick = async () => { if (confirm('¿Quitar esta imagen?')) { await api(`/api/characters/${c.id}/images/${b.dataset.img}`, { method: 'DELETE' }); router(); } });
  });
};

// ---------- Creador de anuncios IA ----------
routes.anuncios = async () => {
  const chs = await channelsCache.get();
  main.innerHTML = `<h1>Creador de anuncios IA</h1><p class="sub">Describe tu producto y sube sus fotos: la IA escribe el anuncio (gancho, problema, solución y llamada a la acción) y lo monta en vertical con voz y subtítulos.</p>
  <div class="grid g2">
    <form class="card stack" id="f">
      <div><label>Producto o servicio</label><input name="product" required placeholder="Ej: Botella térmica SmartBottle"></div>
      <div><label>Descripción y beneficios</label><textarea name="description" placeholder="Mantiene el agua fría 24 h, indica la temperatura en la tapa…"></textarea></div>
      <div class="row"><div style="flex:1"><label>Público objetivo</label><input name="audience" placeholder="Deportistas de 20-35 años"></div><div style="flex:1"><label>Oferta</label><input name="offer" placeholder="-30% solo hoy"></div></div>
      <div class="row"><div style="flex:1"><label>Llamada a la acción</label><input name="cta" value="Compra ahora"></div>
        <div style="flex:1"><label>Duración</label><select name="seconds"><option>15</option><option selected>30</option><option>45</option><option>60</option></select></div></div>
      <div class="row"><div style="flex:1"><label>Idioma</label><select name="language">${Object.values(LANGS).map(v => `<option>${v}</option>`).join('')}</select></div>
        <div style="flex:1"><label>Tono</label><input name="tone" value="enérgico y directo"></div></div>
      <div><label>Fotos o clips del producto (opcional, recomendado)</label><input type="file" id="files" multiple accept="image/*,video/*"></div>
      <div id="thumbs" class="row"></div>
      <div><label>Canal</label><select name="channel_id">${channelOptions(chs)}</select></div>
      <div class="small muted" id="up"></div>
      <div class="row"><button type="button" class="btn" id="draft">✎ Ver guion primero</button><button class="btn gold" id="go">✦ Crear anuncio</button></div>
    </form>
    <div class="card" id="script"><h2>Guion del anuncio</h2><p class="muted">Pide un borrador para revisar los ganchos y las escenas antes de producirlo.</p></div>
  </div><h2 style="margin-top:28px">Anuncios</h2><div class="card" id="list"></div>`;
  const f = $('#f');
  let media = null, script = null;
  $('#files').onchange = () => { media = null; $('#thumbs').innerHTML = [...$('#files').files].map(x => `<span class="pill">${esc(x.name)}</span>`).join(''); };
  const getMedia = async () => (media ||= await uploadMany($('#files').files, $('#up')));
  const opts = async () => { const d = Object.fromEntries(new FormData(f)); d.type = 'ad'; d.seconds = Number(d.seconds); d.format = 'vertical'; d.media = await getMedia(); return d; };
  $('#draft').onclick = e => { if (!f.product.value) return toast('Escribe el producto', 'bad'); busy(e.target, async () => {
    script = await api('/api/compose/script', { method: 'POST', body: await opts() });
    $('#script').innerHTML = `<h2>${esc(script.title || 'Anuncio')}</h2>
      <div class="small muted">Ganchos alternativos:</div><ul>${(script.hooks || []).map(x => `<li>${esc(x)}</li>`).join('')}</ul>
      <div class="stack">${script.scenes.map((s, i) => `<div class="scene stack"><div class="small muted">Escena ${i + 1}${Number.isInteger(s.image) ? ` · foto ${s.image + 1}` : s.search ? ` · stock: ${esc(s.search)}` : ''}</div>
        <textarea data-nar="${i}">${esc(s.narration)}</textarea><input data-ov="${i}" value="${esc(s.overlay || '')}" placeholder="Texto en pantalla (opcional)"></div>`).join('')}
      <button class="btn gold block" id="prod">✦ Producir este anuncio</button></div>`;
    $('#prod').onclick = ev => busy(ev.target, async () => {
      script.scenes.forEach((s, i) => { s.narration = $(`[data-nar="${i}"]`).value; s.overlay = $(`[data-ov="${i}"]`).value; });
      const r = await api('/api/compose', { method: 'POST', body: { ...(await opts()), script } }); location.hash = '#/proyecto/' + r.id;
    });
  }); };
  f.onsubmit = e => { e.preventDefault(); busy($('#go'), async () => { const r = await api('/api/compose', { method: 'POST', body: await opts() }); location.hash = '#/proyecto/' + r.id; }); };
  $('#list').innerHTML = projectTable(await api('/api/projects?type=ad'));
};

// ---------- Montar mi material ----------
routes.montar = async () => {
  const chs = await channelsCache.get();
  main.innerHTML = `<h1>Montar mi material</h1><p class="sub">Sube tus propios clips e imágenes. La IA escribe (o adapta) la narración, añade voz en off y subtítulos y lo monta todo en orden.</p>
  <form class="grid g2" id="f">
    <div class="card stack"><h2>1. Tu material</h2>
      <div class="drop" id="drop"><div style="font-size:30px">⬆</div><b>Arrastra clips o imágenes</b><div class="muted small">Se usarán en este orden, una escena por archivo</div></div>
      <input type="file" id="files" multiple accept="video/*,image/*" hidden>
      <div id="items" class="stack"></div>
    </div>
    <div class="card stack"><h2>2. Narración</h2>
      <div><label>Tema del vídeo</label><input name="topic" placeholder="Ej: Mi viaje por Japón en 7 días"></div>
      <div><label>…o pega tu propio guion (se repartirá entre las escenas)</label><textarea name="ownScript" placeholder="Opcional"></textarea></div>
      <label class="check"><input type="checkbox" name="voice" checked> Añadir voz en off con IA (si lo desactivas se conserva el audio original de los clips)</label>
      <div class="row"><div style="flex:1"><label>Formato</label><select name="format"><option value="vertical">Vertical 9:16</option><option value="horizontal">Horizontal 16:9</option></select></div>
        <div style="flex:1"><label>Idioma</label><select name="language">${Object.values(LANGS).map(v => `<option>${v}</option>`).join('')}</select></div></div>
      <div><label>Estilo</label><input name="style" value="cercano y dinámico"></div>
      <label class="check"><input type="checkbox" name="captions" checked> Subtítulos</label>
      <div><label>Canal</label><select name="channel_id">${channelOptions(chs)}</select></div>
      <div class="small muted" id="up"></div>
      <button class="btn gold" id="go">⧉ Montar vídeo</button>
    </div></form><h2 style="margin-top:28px">Montajes</h2><div class="card" id="list"></div>`;
  let files = [];
  const draw = () => { $('#items').innerHTML = files.map((x, i) => `<div class="scene row" style="flex-wrap:nowrap"><b>${i + 1}</b><span class="small" style="flex:1;overflow:hidden;text-overflow:ellipsis">${esc(x.name)}</span>
      <input data-note="${i}" placeholder="¿Qué se ve? (opcional)" style="flex:2" value="${esc(x.note || '')}"><button type="button" class="btn sm" data-rm="${i}">✕</button></div>`).join('');
    $('#items').querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { files.splice(+b.dataset.rm, 1); draw(); });
    $('#items').querySelectorAll('[data-note]').forEach(i => i.oninput = () => { files[+i.dataset.note].note = i.value; }); };
  const add = list => { files.push(...[...list]); draw(); };
  const drop = $('#drop');
  drop.onclick = () => $('#files').click();
  $('#files').onchange = e => add(e.target.files);
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); add(e.dataTransfer.files); };
  $('#f').onsubmit = e => {
    e.preventDefault();
    const f = e.target;
    if (!files.length) return toast('Sube al menos un archivo', 'bad');
    if (f.voice.checked && !f.topic.value && !f.ownScript.value) return toast('Escribe un tema o tu guion', 'bad');
    busy($('#go'), async () => {
      const d = Object.fromEntries(new FormData(f));
      d.type = 'montage'; d.voice = f.voice.checked; d.captions = f.captions.checked;
      d.notes = files.map(x => x.note || '');
      d.media = await uploadMany(files, $('#up'));
      // Sin voz no hace falta IA: una escena por archivo con su audio original
      const body = d.voice ? d : { ...d, script: { title: d.topic || 'Montaje', scenes: files.map(() => ({ narration: '' })) } };
      const r = await api('/api/compose', { method: 'POST', body });
      location.hash = '#/proyecto/' + r.id;
    });
  };
  $('#list').innerHTML = projectTable(await api('/api/projects?type=montage'));
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
        <div class="card"><h3>Lo que pide la audiencia</h3><ul>${li(ai.audience_requests)}</ul><h3>Ideas de Shorts</h3><ul>${li(ai.shorts_ideas)}</ul></div>
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
      <p class="small">${c.days > 0 ? `Los vídeos originales se borran <b>${c.days} día${c.days > 1 ? 's' : ''}</b> después de terminar el proyecto (cada día, automáticamente). Los Shorts y vídeos terminados se conservan.` : 'Desactivada: los originales no se borran.'}
        Cámbialo en <a href="#/ajustes">Ajustes y claves → Almacenamiento</a>.</p>
      ${c.count ? `<p class="small">Ahora mismo se pueden borrar <b>${c.count}</b> proyecto(s), unos <b>${mb(c.bytes)}</b>:</p>
        <ul class="small">${c.items.slice(0, 8).map(i => `<li><a href="#/proyecto/${i.id}">${esc(i.title || 'Proyecto ' + i.id)}</a> · ${mb(i.bytes)}</li>`).join('')}</ul>
        <div><button class="btn gold sm" id="cleanNow">🧹 Liberar espacio ahora</button></div>` : c.days > 0 ? '<p class="small muted">No hay originales pendientes de borrar.</p>' : ''}`;
    const bn = $('#cleanNow');
    if (bn) bn.onclick = () => { if (confirm(`Se borrarán los originales de ${c.count} proyecto(s). Los Shorts terminados se conservan, pero esos proyectos no se podrán volver a renderizar. ¿Continuar?`)) busy(bn, async () => { const r = await api('/api/admin/cleanup', { method: 'POST' }); toast(`${r.files} archivo(s) borrados`, 'good'); router(); }); };
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
routes.ajustes = async () => {
  const { values, fields } = await api('/api/settings');
  const groups = {};
  for (const [k, f] of Object.entries(fields)) (groups[f.group] ||= []).push([k, f]);
  main.innerHTML = `<h1>Ajustes y claves</h1><p class="sub">Tus claves API se guardan cifradas en tu servidor y nunca se envían al navegador. Solo pagas lo que uses en cada proveedor.</p>
    <form id="f" class="grid g2">${Object.entries(groups).map(([g, list]) => `<div class="card stack"><h2>${g}</h2>
      ${list.map(([k, f]) => `<div><label>${f.label}</label>${f.options
        ? `<select name="${k}">${f.options.map(o => `<option ${values[k] === o ? 'selected' : ''}>${o}</option>`).join('')}</select>`
        : `<input name="${k}" ${f.secret ? 'type="password" autocomplete="off"' : ''} value="${esc(values[k])}" placeholder="${f.secret ? 'Pega tu clave' : ''}">`}</div>`).join('')}
      ${g.startsWith('IA') ? `<div class="row"><button type="button" class="btn sm" data-test="openai">Probar OpenAI</button><button type="button" class="btn sm" data-test="anthropic">Probar Claude</button><button type="button" class="btn sm" data-test="gemini">Probar Gemini</button><button type="button" class="btn sm" data-test="groq">Probar Groq</button><button type="button" class="btn sm" data-test="openrouter">Probar OpenRouter</button></div>` : ''}
      ${g === 'Publicar en YouTube' ? `<div class="small muted">URI de redirección autorizada para tu cliente OAuth:<br><code>${location.origin}/api/youtube/callback</code></div>` : ''}
      </div>`).join('')}
      <div style="grid-column:1/-1"><button class="btn gold">Guardar ajustes</button></div></form>`;
  const f = $('#f');
  f.onsubmit = e => {
    e.preventDefault();
    busy(f.querySelector('.btn.gold'), async () => { await api('/api/settings', { method: 'PUT', body: Object.fromEntries(new FormData(f)) }); toast('Ajustes guardados', 'good'); router(); });
  };
  f.querySelectorAll('[data-test]').forEach(b => b.onclick = () => busy(b, async () => {
    await api('/api/settings', { method: 'PUT', body: Object.fromEntries(new FormData(f)) });
    const r = await api('/api/settings/test', { method: 'POST', body: { provider: b.dataset.test } });
    toast(`${b.dataset.test}: conexión correcta (${r.reply})`, 'good');
  }));
};

// ---------- Ayuda ----------
routes.ayuda = () => {
  main.innerHTML = `<h1>Ayuda</h1><p class="sub">Cómo sacar partido a tu estudio.</p><div class="grid g2">
  <div class="card stack"><h2>¿Qué claves necesito?</h2>
    <p><b>Mínimo para Shorts:</b> una clave de <b>OpenAI</b> (transcribe con Whisper y escribe títulos y ganchos). Alternativa más barata: <b>Groq</b> para transcribir + Claude/Gemini/OpenRouter para el texto.</p>
    <p><b>Vídeo completo, anuncios y montajes:</b> IA de texto + voz (<b>OpenAI TTS</b> o <b>ElevenLabs</b>) + <b>Pixabay</b> (gratis; regístrate en pixabay.com y copia tu clave en pixabay.com/api/docs) o Pexels para vídeos de stock.</p>
    <p><b>Personaje IA:</b> OpenAI (modelo de imágenes gpt-image-1).</p>
    <p><b>Analizador:</b> una <b>YouTube Data API key</b> (gratis en Google Cloud) o un canal conectado.</p>
    <p><b>Publicar:</b> credenciales OAuth de Google (gratis).</p></div>
  <div class="card stack"><h2>Herramientas</h2><ul>
    <li><b>Personaje IA:</b> crea un personaje con aspecto, personalidad y voz. Genera imágenes coherentes (usa su primera imagen como referencia) y úsalo como narrador en "Vídeo completo".</li>
    <li><b>Creador de anuncios IA:</b> producto + fotos → anuncio vertical con gancho, voz, subtítulos y llamada a la acción.</li>
    <li><b>Montar mi material:</b> tus clips e imágenes en orden + narración con IA (o tu propio guion) → vídeo terminado. Sin voz conserva el audio original.</li>
    <li><b>Analizador:</b> pega un canal o vídeo de YouTube para ver estadísticas, mejores días, patrones de títulos e ideas.</li>
    <li><b>Estado del servidor:</b> mira la cola de trabajos y reintenta los que fallen.</li></ul></div>
  <div class="card stack"><h2>Convertir a Shorts</h2><ol>
    <li>Sube un vídeo largo (o pega un enlace si el servidor tiene yt-dlp).</li>
    <li>Se transcribe con marcas de tiempo por palabra.</li>
    <li>La IA elige los mejores momentos, les pone nota del 1 al 10 y escribe un gancho.</li>
    <li>La nota viral combina el criterio de la IA (gancho, historia, emoción, valor, final) con señales medidas: picos de energía, risas, ritmo de habla y cambios de plano.</li>
    <li>Cada Short sale en 1080×1920 con <b>Recorte centrado en quien habla</b> (si hay varias personas en plano, detecta quién habla por el movimiento de la boca y corta a esa persona), recorte fijo o fondo difuminado, gancho 4 s arriba, subtítulos con el estilo elegido, palabras clave en color y emojis animados.</li>
    <li>Ajusta inicio/fin con ±1 s, cambia el gancho y pulsa <b>Aplicar cambios</b>.</li>
    <li>Descarga el .zip o publica directamente en YouTube.</li></ol></div>
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
  <div class="card stack"><h2>Consejos</h2><ul>
    <li>Usa vídeos que sean tuyos o con permiso: subir contenido ajeno puede generar reclamaciones de derechos de autor.</li>
    <li>Los ganchos cortos (3–6 palabras) funcionan mejor.</li>
    <li>Programa 1–3 Shorts al día con el calendario.</li></ul></div></div>`;
};

router();
