// Faceless Studio — frontend sin dependencias (SPA con rutas por hash)
const $ = (s, el = document) => el.querySelector(s);
const main = $('#main');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mmss = t => { t = Math.max(0, t || 0); const m = Math.floor(t / 60), s = Math.floor(t % 60); return `${m}:${String(s).padStart(2, '0')}`; };
const LANGS = { es: 'Español', en: 'Inglés', pt: 'Portugués', fr: 'Francés', de: 'Alemán', it: 'Italiano' };

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
const pill = s => `<span class="pill ${s}">${['processing', 'rendering', 'pending'].includes(s) ? '<span class="spinner"></span> ' : ''}${statusLabel(s)}</span>`;

// ---------- Navegación ----------
const NAV = [
  ['ESTUDIO', [['', '⌂', 'Inicio'], ['canales', '▦', 'Mis canales'], ['videos', '▤', 'Mis vídeos'], ['calendario', '▣', 'Calendario de contenido']]],
  ['HERRAMIENTAS', [['nichos', '⌕', 'Buscador de nichos'], ['completo', '▶', 'Vídeo completo'], ['shorts', '✂', 'Convertir a Shorts']]],
  ['CUENTA', [['ajustes', '⚿', 'Ajustes y claves'], ['papelera', '🗑', 'Papelera'], ['ayuda', '?', 'Ayuda']]],
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
  renderNav(route === 'proyecto' ? (arg && 'shorts') : route);
  if (route !== 'login') {
    const me = await api('/api/me').catch(() => ({ authed: false }));
    if (!me.authed) { location.hash = '#/login'; return; }
  }
  main.innerHTML = '<div class="muted"><span class="spinner"></span> Cargando…</div>';
  try { await (routes[route] || routes[''])(arg, params); }
  catch (e) { main.innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', router);

const channelsCache = { list: null, async get() { return this.list ||= await api('/api/channels'); }, reset() { this.list = null; } };
const channelOptions = (list, sel, empty = 'Sin canal') => `<option value="">${empty}</option>` + list.map(c => `<option value="${c.id}" ${c.id == sel ? 'selected' : ''}>${esc(c.name)}</option>`).join('');

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
  const [s, sys, settings] = await Promise.all([api('/api/stats'), api('/api/system'), api('/api/settings')]);
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
    <td><a href="#/proyecto/${p.id}">${esc(p.title || 'Sin título')}</a>${p.status === 'processing' && p.progress ? `<div class="muted small">${esc(p.progress)}</div>` : ''}</td>
    <td>${p.type === 'shorts' ? '✂ Shorts' + (p.ready_clips != null ? ` (${p.ready_clips})` : '') : '▶ Completo'}</td>
    <td>${pill(p.status)}</td><td class="muted small">${(p.created_at || '').slice(0, 16)}</td>
    <td style="text-align:right">${trash ? `<button class="btn sm" data-restore="${p.id}">Restaurar</button> <button class="btn sm red" data-purge="${p.id}">Borrar definitivamente</button>` : ''}</td></tr>`).join('')}</table>`;
}

// ---------- Canales ----------
routes.canales = async (_, params) => {
  if (params.get('ok')) toast('Canal conectado con YouTube', 'good');
  if (params.get('error')) toast(params.get('error'), 'bad');
  channelsCache.reset();
  const [list, sys] = await Promise.all([channelsCache.get(), api('/api/system')]);
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
  const [chs, sys] = await Promise.all([channelsCache.get(), api('/api/system')]);
  main.innerHTML = `<h1>Convertir a Shorts</h1><p class="sub">Sube un vídeo largo. La IA lo transcribe, encuentra los mejores momentos y crea Shorts verticales con gancho y subtítulos.</p>
  <form id="f" class="grid g2">
    <div class="card stack">
      <h2>1. Vídeo de origen</h2>
      <div class="drop" id="drop"><div style="font-size:30px">⬆</div><b>Arrastra tu vídeo aquí</b><div class="muted small">o haz clic para elegirlo (mp4, mov, mkv…)</div><div id="fname" class="small" style="margin-top:8px;color:var(--gold)"></div></div>
      <input type="file" name="video" accept="video/*" hidden>
      <div><label>…o pega un enlace (YouTube, etc.) ${sys.ytdlp ? '' : '<span class="err">— yt-dlp no está instalado en el servidor</span>'}</label><input name="url" placeholder="https://www.youtube.com/watch?v=…" ${sys.ytdlp ? '' : 'disabled'}></div>
      <div><label>Título del proyecto (opcional)</label><input name="title"></div>
      <div><label>Canal</label><select name="channel_id">${channelOptions(chs)}</select></div>
    </div>
    <div class="card stack">
      <h2>2. Opciones</h2>
      <div class="row"><div style="flex:1"><label>Nº de Shorts</label><input type="number" name="count" value="10" min="1" max="30"></div>
        <div style="flex:1"><label>Duración mín. (s)</label><input type="number" name="minSec" value="20" min="5"></div>
        <div style="flex:1"><label>Duración máx. (s)</label><input type="number" name="maxSec" value="60" min="10" max="180"></div></div>
      <div><label>Encuadre</label><select name="layout"><option value="blur">Fondo difuminado (vídeo completo centrado)</option><option value="crop">Recorte centrado (pantalla completa)</option></select></div>
      <div class="row"><div style="flex:1"><label>Idioma del audio</label><select name="language"><option value="">Detectar automáticamente</option>${Object.entries(LANGS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
        <div style="flex:1"><label>Idioma de títulos y ganchos</label><select name="titleLanguage"><option value="">Igual que el vídeo</option>${Object.entries(LANGS).map(([k, v]) => `<option value="${v}">${v}</option>`).join('')}</select></div></div>
      <label class="check"><input type="checkbox" name="captions" checked> Subtítulos palabra a palabra</label>
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
  f.onsubmit = e => {
    e.preventDefault();
    const fd = new FormData(f);
    fd.set('captions', f.captions.checked ? 'true' : 'false');
    if (!file.files[0]) fd.delete('video');
    if (!file.files[0] && !f.url.value) return toast('Sube un vídeo o pega un enlace', 'bad');
    // XHR para mostrar progreso de subida de archivos grandes
    const xhr = new XMLHttpRequest();
    $('#go').disabled = true;
    xhr.upload.onprogress = ev => { $('#up').textContent = `Subiendo… ${Math.round(ev.loaded / ev.total * 100)}%`; };
    xhr.onload = () => {
      $('#go').disabled = false;
      const j = JSON.parse(xhr.responseText || '{}');
      if (xhr.status >= 400) return toast(j.error || 'Error', 'bad');
      location.hash = '#/proyecto/' + j.id;
    };
    xhr.onerror = () => { $('#go').disabled = false; toast('Error de red al subir', 'bad'); };
    xhr.open('POST', '/api/shorts'); xhr.send(fd);
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
    ${['pending', 'processing'].includes(p.status) ? `<div class="progress" style="margin-bottom:16px"><span class="spinner"></span> ${esc(p.progress || 'Procesando…')} <span class="muted small">— puedes cerrar esta página, el servidor sigue trabajando.</span></div>` : ''}`;
  main.innerHTML = head + (p.type === 'shorts' ? shortsGrid(p, chs) : longView(p, chs));
  const r = $('#retry'); if (r) r.onclick = () => busy(r, async () => { await api(`/api/projects/${p.id}/retry`, { method: 'POST' }); router(); });
  $('#del').onclick = async () => { if (confirm('¿Mover a la papelera?')) { await api('/api/projects/' + p.id, { method: 'DELETE' }); location.hash = '#/videos'; } };
  if (p.type === 'shorts') bindClips(p); else bindLong(p);
  if (working) poll(() => { if (!document.activeElement || !main.contains(document.activeElement) || document.activeElement.tagName === 'BUTTON') router(); else poll(router, 3000); }, 3500);
};

function shortsGrid(p, chs) {
  if (!p.clips?.length) return p.status === 'ready' ? '<div class="empty">No se generaron clips.</div>' : '';
  return `<div class="shorts">${p.clips.map(c => {
    const dur = c.end - c.start;
    const langs = Object.entries(c.variants || {}).filter(([, v]) => v.file);
    return `<div class="clip" data-clip="${c.id}">
      <div class="vid"><button class="btn sm xbtn" data-x title="Eliminar clip">✕</button>${c.file && c.status !== 'rendering' ? `<video src="/files/${c.file}" controls preload="metadata" playsinline></video>` : c.status === 'error' ? `<div class="err small" style="padding:10px">${esc(c.error || 'Error')}</div>` : '<span class="spinner"></span>'}</div>
      <div class="body">
        <div class="row" style="gap:5px"><b>#${c.idx}</b><span class="pill">${c.score}/10</span><span class="pill">${c.layout === 'crop' ? 'recorte' : 'fondo difuminado'}</span></div>
        ${c.status === 'rendering' ? pill('rendering') : ''}
        <div><label>Título</label><input data-f="title" value="${esc(c.title)}"></div>
        <div><label>Frase de gancho (sale 4 s arriba)</label><input data-f="hook" value="${esc(c.hook)}"></div>
        <div class="muted" data-time>${mmss(c.start)} → ${mmss(c.end)} · ${Math.round(dur)} s</div>
        <div class="nudge"><span class="muted">Inicio</span><button class="btn" data-n="start:-1">−1 s</button><button class="btn" data-n="start:1">+1 s</button>
          <span class="muted">Fin</span><button class="btn" data-n="end:-1">−1 s</button><button class="btn" data-n="end:1">+1 s</button></div>
        <select data-f="layout"><option value="blur" ${c.layout !== 'crop' ? 'selected' : ''}>Fondo difuminado</option><option value="crop" ${c.layout === 'crop' ? 'selected' : ''}>Recorte centrado</option></select>
        <button class="btn gold" data-apply>Aplicar cambios</button>
        ${c.reason ? `<details><summary>¿Por qué este momento?</summary><div class="muted">${esc(c.reason)}</div></details>` : ''}
        <details><summary>🌐 Sacarlo en otro idioma</summary><div class="stack" style="margin-top:6px">
          <select data-lang>${Object.entries(LANGS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
          <button class="btn sm" data-tr>Traducir subtítulos y gancho</button>
          ${langs.map(([l, v]) => `<a href="/files/${v.file}" target="_blank" class="small">▶ Versión ${LANGS[l] || l}</a>`).join('<br>')}</div></details>
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
      await api('/api/clips/' + c.id, { method: 'PATCH', body: { ...st, title: $('[data-f=title]', el).value, hook: $('[data-f=hook]', el).value, layout: $('[data-f=layout]', el).value } });
      await api(`/api/clips/${c.id}/render`, { method: 'POST' });
      toast('Renderizando de nuevo…'); router();
    });
    $('[data-f=title]', el).onchange = e => api('/api/clips/' + c.id, { method: 'PATCH', body: { title: e.target.value } }).catch(err => toast(err.message, 'bad'));
    $('[data-zip]', el).onchange = e => api('/api/clips/' + c.id, { method: 'PATCH', body: { include_zip: e.target.checked } });
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
routes.completo = async () => {
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
      <label class="check"><input type="checkbox" name="captions" checked> Subtítulos</label>
      <div class="muted small">Voz: ${settings.values.tts_provider} · Stock: ${settings.values.pexels_key ? 'Pexels ✓' : '<span class="err">sin clave de Pexels (fondo liso)</span>'}</div>
      <div class="row"><button type="button" class="btn" id="draft">✎ Generar guion para revisar</button><button class="btn gold" id="go">▶ Crear vídeo directamente</button></div>
    </form>
    <div class="card" id="script"><h2>Guion</h2><p class="muted">Genera un borrador para revisarlo y editarlo antes de producir el vídeo.</p></div>
  </div>
  <h2 style="margin-top:28px">Vídeos completos</h2><div class="card" id="list"></div>`;
  const f = $('#f');
  const opts = () => { const d = Object.fromEntries(new FormData(f)); d.captions = f.captions.checked; d.minutes = Number(d.minutes); return d; };
  let script = null;
  const showScript = () => {
    $('#script').innerHTML = `<h2>Guion</h2><div class="stack">
      <div><label>Título</label><input id="st" value="${esc(script.title)}"></div>
      <div><label>Descripción</label><textarea id="sd">${esc(script.description)}</textarea></div>
      ${script.scenes.map((s, i) => `<div class="scene stack"><div class="small muted">Escena ${i + 1}</div><textarea data-nar="${i}">${esc(s.narration)}</textarea><input data-q="${i}" value="${esc(s.search)}" title="Búsqueda de stock (inglés)"></div>`).join('')}
      <button class="btn gold block" id="prod">▶ Producir vídeo con este guion</button></div>`;
    $('#prod').onclick = e => busy(e.target, async () => {
      script.title = $('#st').value; script.description = $('#sd').value;
      script.scenes.forEach((s, i) => { s.narration = $(`[data-nar="${i}"]`).value; s.search = $(`[data-q="${i}"]`).value; });
      const r = await api('/api/long', { method: 'POST', body: { ...opts(), script } });
      location.hash = '#/proyecto/' + r.id;
    });
  };
  $('#draft').onclick = e => { if (!f.topic.value) return toast('Escribe un tema', 'bad'); busy(e.target, async () => { script = await api('/api/long/script', { method: 'POST', body: opts() }); showScript(); }); };
  f.onsubmit = e => { e.preventDefault(); busy($('#go'), async () => { const r = await api('/api/long', { method: 'POST', body: opts() }); location.hash = '#/proyecto/' + r.id; }); };
  $('#list').innerHTML = projectTable(await api('/api/projects?type=long'));
};

function longView(p, chs) {
  const s = p.data.script;
  return `<div class="grid g2">
    <div class="card">${p.output_path ? `<video src="/files/${p.output_path}" controls style="width:100%;border-radius:8px;background:#000"></video>
      <div class="row" style="margin-top:10px"><a class="btn" href="/files/${p.output_path}" download>⬇ Descargar MP4</a></div>` : '<div class="empty">El vídeo aparecerá aquí cuando termine.</div>'}</div>
    <div class="card stack"><h2>Publicar en YouTube</h2>
      ${p.data.yt_video_id ? `<a target="_blank" href="https://youtube.com/watch?v=${p.data.yt_video_id}">✓ Publicado en YouTube</a>` : ''}
      <div><label>Título</label><input id="pt" value="${esc(s?.title || p.title)}"></div>
      <div><label>Descripción</label><textarea id="pd">${esc(s?.description || '')}</textarea></div>
      <div><label>Etiquetas (separadas por comas)</label><input id="ptags" value="${esc((s?.tags || []).join(', '))}"></div>
      <div class="row"><select id="pch" style="flex:1">${channelOptions(chs.filter(x => x.connected), p.channel_id, 'Elige canal conectado')}</select>
        <select id="ppriv" style="flex:1"><option value="public">Público</option><option value="unlisted">Oculto</option><option value="private">Privado</option></select></div>
      <div><label>Programar (opcional)</label><input type="datetime-local" id="pat"></div>
      <button class="btn gold" id="pub" ${p.output_path ? '' : 'disabled'}>Publicar ahora</button></div>
    ${s?.scenes ? `<div class="card" style="grid-column:1/-1"><h2>Guion</h2>${s.scenes.map((x, i) => `<p><b class="muted">${i + 1}.</b> ${esc(x.narration)}</p>`).join('')}</div>` : ''}
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
      ${g.startsWith('IA') ? `<div class="row"><button type="button" class="btn sm" data-test="openai">Probar OpenAI</button><button type="button" class="btn sm" data-test="anthropic">Probar Claude</button><button type="button" class="btn sm" data-test="gemini">Probar Gemini</button><button type="button" class="btn sm" data-test="openrouter">Probar OpenRouter</button></div>` : ''}
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
    <p><b>Mínimo para Shorts:</b> una clave de <b>OpenAI</b> (transcribe con Whisper y escribe títulos/ganchos). Alternativa más barata: <b>Groq</b> para transcribir + Claude/Gemini/OpenRouter para el texto.</p>
    <p><b>Vídeo completo:</b> IA de texto + voz (<b>OpenAI TTS</b> o <b>ElevenLabs</b>) + <b>Pexels</b> (gratis) para vídeos de stock.</p>
    <p><b>Publicar:</b> credenciales OAuth de Google (gratis).</p></div>
  <div class="card stack"><h2>Convertir a Shorts</h2><ol>
    <li>Sube un vídeo largo (o pega un enlace si el servidor tiene yt-dlp).</li>
    <li>Se transcribe con marcas de tiempo por palabra.</li>
    <li>La IA elige los mejores momentos, les pone nota del 1 al 10 y escribe un gancho.</li>
    <li>Se renderiza cada Short 1080×1920 con fondo difuminado, gancho 4 s arriba y subtítulos.</li>
    <li>Ajusta inicio/fin con ±1 s, cambia el gancho y pulsa <b>Aplicar cambios</b>.</li>
    <li>Descarga el .zip o publica directamente en YouTube.</li></ol></div>
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
