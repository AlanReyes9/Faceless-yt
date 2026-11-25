// Clippers Pro de escritorio (Windows / macOS / Linux).
// Arranca el mismo servidor de la web dentro de la app (base de datos y vídeos en tu ordenador)
// y lo muestra en una ventana. ffmpeg y yt-dlp van incluidos.
import { app, BrowserWindow, shell, Menu, dialog, safeStorage, ipcMain, nativeImage } from 'electron';
import * as lic from './license.js';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREFERRED_PORT = 47821; // fijo: la URI de redirección de YouTube (OAuth) no cambia entre arranques

if (!app.requestSingleInstanceLock()) app.quit();

let win = null, baseUrl = null;

// ---------- Conexión a la nube (opcional): R2/S3 y la misma base de datos que la web ----------
const CLOUD_KEYS = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_REGION', 'DATABASE_URL', 'APP_SECRET'];
const cloudFile = () => path.join(app.getPath('userData'), 'cloud.json');
function readCloud() {
  try {
    const raw = JSON.parse(fs.readFileSync(cloudFile(), 'utf8'));
    const json = raw.enc ? safeStorage.decryptString(Buffer.from(raw.enc, 'base64')) : raw.plain;
    return JSON.parse(json || '{}');
  } catch { return {}; }
}
function writeCloud(cfg) {
  const json = JSON.stringify(cfg);
  const data = safeStorage.isEncryptionAvailable() ? { enc: safeStorage.encryptString(json).toString('base64') } : { plain: json };
  fs.writeFileSync(cloudFile(), JSON.stringify(data), { mode: 0o600 });
}

function setupEnv() {
  const data = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(data, { recursive: true });
  process.env.DATA_DIR ||= data;
  process.env.DESKTOP = '1';
  // Solo almacenamiento y base de datos locales
  for (const k of ['DATABASE_URL', 'POSTGRES_URL', 'BLOB_READ_WRITE_TOKEN', 'S3_ENDPOINT', 'APP_PASSWORD', 'VERCEL']) delete process.env[k];
  // Nube configurada en Ajustes (R2/S3 y, opcionalmente, la base de datos Neon compartida con la web)
  const cloud = readCloud();
  for (const k of CLOUD_KEYS) if (cloud[k]) process.env[k] = cloud[k];
  // Puente para el servidor: leer/guardar la configuración y reiniciar la app
  globalThis.__desktop = {
    getCloud: () => readCloud(),
    saveCloud: cfg => writeCloud(Object.fromEntries(CLOUD_KEYS.filter(k => cfg[k]).map(k => [k, String(cfg[k]).trim()]))),
    relaunch: () => setTimeout(() => { app.relaunch(); app.exit(0); }, 600),
    encrypted: () => safeStorage.isEncryptionAvailable(),
    licensed: () => licensed,
    license: () => lic.licenseInfo(),
    logout: () => logout(),
  };
  // yt-dlp incluido (YouTube, Twitch, Kick)
  const bin = app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(ROOT, 'desktop', 'bin');
  if (fs.existsSync(bin)) process.env.PATH = bin + path.delimiter + (process.env.PATH || '');
  // Transcripción local: whisper-cli incluido y modelos en la carpeta del usuario
  const wcli = path.join(bin, process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
  if (fs.existsSync(wcli)) { process.env.WHISPER_CLI = wcli; process.env.DEFAULT_TRANSCRIBE ||= 'local'; }
  process.env.WHISPER_MODELS_DIR ||= path.join(app.getPath('userData'), 'models');
  // IA local de texto (llama.cpp) e imágenes (stable-diffusion.cpp) incluidas
  for (const [env, names] of [['LLAMA_SERVER', ['llama-server']], ['SD_CLI', ['sd', 'sd-cli']]]) {
    const f = names.map(n => path.join(bin, process.platform === 'win32' ? n + '.exe' : n)).find(x => fs.existsSync(x));
    if (f) process.env[env] = f;
  }
  if (process.env.LLAMA_SERVER) process.env.DEFAULT_LLM ||= 'local';
  if (process.env.SD_CLI) process.env.DEFAULT_IMAGE ||= 'local';
  const ytdlpBin = path.join(bin, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  if (fs.existsSync(ytdlpBin)) process.env.YTDLP_PATH = ytdlpBin;
  // YouTube exige a yt-dlp un motor de JavaScript: se le da el Node que lleva la propia app (Electron en modo Node)
  try {
    const rt = path.join(app.getPath('userData'), 'runtime');
    fs.mkdirSync(rt, { recursive: true });
    let node;
    if (process.platform === 'win32') {
      node = path.join(rt, 'node.cmd');
      fs.writeFileSync(node, `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" %*\r\n`);
    } else {
      node = path.join(rt, 'node');
      fs.writeFileSync(node, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "$@"\n`, { mode: 0o755 });
      fs.chmodSync(node, 0o755);
    }
    process.env.YTDLP_JS_RUNTIME = 'node:' + node;
  } catch (e) { console.warn('motor JS para yt-dlp:', e.message); }
  // Registro en un archivo (útil si algo falla)
  const logFile = path.join(app.getPath('userData'), 'faceless.log');
  try { if (fs.statSync(logFile).size > 5e6) fs.rmSync(logFile); } catch {}
  const out = fs.createWriteStream(logFile, { flags: 'a' });
  for (const m of ['log', 'warn', 'error']) {
    const orig = console[m].bind(console);
    console[m] = (...a) => { try { out.write(`[${new Date().toISOString()}] ${a.map(x => typeof x === 'string' ? x : x instanceof Error ? x.stack : JSON.stringify(x)).join(' ')}\n`); } catch {} orig(...a); };
  }
  return logFile;
}

const freePort = p => new Promise(res => {
  const s = net.createServer().once('error', () => res(false)).once('listening', () => s.close(() => res(true))).listen(p, '127.0.0.1');
});

async function startServer() {
  const port = (await freePort(PREFERRED_PORT)) ? PREFERRED_PORT : 0;
  if (port) process.env.PUBLIC_URL = `http://localhost:${port}`;
  const { app: server } = await import(pathToFileURL(path.join(ROOT, 'server', 'app.js')).href);
  const { startLocalWorker } = await import(pathToFileURL(path.join(ROOT, 'server', 'jobs.js')).href);
  const { runCleanup } = await import(pathToFileURL(path.join(ROOT, 'server', 'cleanup.js')).href);
  const real = await new Promise((resolve, reject) => {
    const s = server.listen(port, '127.0.0.1', () => resolve(s.address().port)).on('error', reject);
    s.requestTimeout = 0; s.timeout = 0; // sin límite de tiempo por petición (vídeos grandes)
  });
  if (!port) process.env.PUBLIC_URL = `http://localhost:${real}`;
  startLocalWorker();
  import(pathToFileURL(path.join(ROOT, 'server', 'video', 'live.js')).href).then(m => m.startLiveWatchdog()).catch(e => console.warn('vigilante:', e.message));
  (await import(pathToFileURL(path.join(ROOT, 'server', 'social.js')).href)).startSocialScheduler(); // publicaciones programadas en redes
  const clean = () => runCleanup().catch(e => console.error('limpieza:', e.message));
  setTimeout(clean, 60000); setInterval(clean, 6 * 3600e3);
  // Precarga de la IA local de texto: la primera respuesta llega sin esperar a que se cargue el modelo
  setTimeout(() => import(pathToFileURL(path.join(ROOT, 'server', 'ai', 'localmodels.js')).href).then(m => m.warmUp()).catch(() => {}), 45000);
  console.log('Clippers Pro (escritorio) en', process.env.PUBLIC_URL, '· datos:', process.env.DATA_DIR);
  return `http://localhost:${real}`;
}

// Pantalla de carga: se ve al momento mientras arranca el servidor
const SPLASH = 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><body style="margin:0;height:100vh;display:grid;place-items:center;background:#0f1013;color:#e5e7eb;font:15px -apple-system,Segoe UI,sans-serif">
  <div style="text-align:center"><div style="width:54px;height:54px;margin:0 auto 18px;border-radius:14px;background:#22c55e;display:grid;place-items:center;color:#0f1013;font-size:26px">▶</div>
  <b style="font-size:18px">Clippers Pro</b><div style="margin-top:10px;color:#9ca3af">Cargando…</div>
  <div style="margin:18px auto 0;width:160px;height:4px;border-radius:4px;background:#1f2937;overflow:hidden"><div style="width:40%;height:100%;background:#22c55e;animation:m 1.1s ease-in-out infinite alternate"></div></div></div>
  <style>@keyframes m{from{margin-left:0}to{margin-left:60%}}</style></body></html>`);

function createWindow(url = baseUrl) {
  win = new BrowserWindow({
    width: 1360, height: 880, minWidth: 900, minHeight: 600, backgroundColor: '#0f1013', title: 'Clippers Pro',
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: { preload: path.join(ROOT, 'desktop', 'preload-app.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const isApp = u => { try { return new URL(u).origin === new URL(baseUrl).origin; } catch { return false; } };
  // Enlaces externos (Google, YouTube, webs de las claves…) en el navegador del sistema.
  // Google no permite iniciar sesión dentro de una ventana embebida.
  win.webContents.setWindowOpenHandler(({ url }) => {
    // El editor de clips se abre en su propia ventana
    if (isApp(url)) return { action: 'allow', overrideBrowserWindowOptions: { width: 1440, height: 900, minWidth: 1050, minHeight: 680, backgroundColor: '#0a0b0f', autoHideMenuBar: true, title: 'Editor · Clippers Pro' } };
    shell.openExternal(url); return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!isApp(url)) { e.preventDefault(); shell.openExternal(url); } });
  // Las redirecciones del servidor (p. ej. Conectar YouTube → accounts.google.com) también van al navegador del sistema:
  // dentro de la app el inicio de sesión de Google no funciona y la ventana se quedaba atrapada sin poder volver.
  win.webContents.on('will-redirect', (e, url) => { if (!isApp(url)) { e.preventDefault(); shell.openExternal(url); } });
  win.__splash = !url || url === SPLASH;
  win.loadURL(url || SPLASH);
  win.on('closed', () => { win = null; });
}

function buildMenu(logFile) {
  const tpl = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'Archivo', submenu: [
      { label: 'Abrir carpeta de datos', click: () => shell.openPath(process.env.DATA_DIR) },
      { label: 'Ver registro', click: () => shell.openPath(logFile) },
      { label: 'Abrir en el navegador', click: () => shell.openExternal(baseUrl) },
      { type: 'separator' },
      { label: 'Cerrar sesión', click: () => logout() },
      { type: 'separator' }, process.platform === 'darwin' ? { role: 'close' } : { role: 'quit', label: 'Salir' }] },
    { label: 'Editar', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'Ver', submenu: [{ role: 'reload', label: 'Recargar' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => { if (!loginWin && licensed) app.quit(); }); // al cerrar la ventana se detiene el servidor (los trabajos en curso se reanudan al volver a abrir)
app.on('activate', () => { if (!win && baseUrl && licensed) createWindow(); });

// ---------- Licencia: solo usuarios autorizados por el administrador ----------
let licensed = false, loginWin = null, loginMessage = '', loginResolve = null;
const NO_LICENSE = !app.isPackaged && process.env.CLIPPERS_NO_LICENSE === '1'; // solo para desarrollo

// ---------- Publicar a mano: el vídeo del clip se arrastra a la web (Instagram, Facebook, TikTok) o se guarda en Descargas ----------
const DRAG_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAQklEQVR4nO3OQQ0AIAwAsVlBGG4RhguOR5MK6KyzvzL5QEhISKgeCAkJCdUDISEhoXogJCQkVA+EhISE6oGQkNBjF7PXUqaJlJzbAAAAAElFTkSuQmCC';
const insideData = f => { try { const r = path.relative(path.resolve(process.env.DATA_DIR), path.resolve(String(f))); return !!f && !r.startsWith('..') && !path.isAbsolute(r) && fs.existsSync(f); } catch { return false; } };
ipcMain.on('clip:drag', (e, file) => { if (insideData(file)) e.sender.startDrag({ file, icon: nativeImage.createFromDataURL(DRAG_ICON) }); });
ipcMain.handle('clip:save', async (e, { file, name }) => {
  if (!insideData(file)) throw new Error('No se encontró el vídeo del clip.');
  const base = String(name || 'clip').replace(/[\\/:*?"<>|#%\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'clip';
  let dest = path.join(app.getPath('downloads'), base + '.mp4');
  for (let i = 2; fs.existsSync(dest); i++) dest = path.join(app.getPath('downloads'), `${base} (${i}).mp4`);
  await fs.promises.copyFile(file, dest);
  shell.showItemInFolder(dest);
  return dest;
});
ipcMain.handle('license:info', () => ({ ...lic.licenseInfo(), message: loginMessage }));
ipcMain.handle('license:login', async (e, { username, password }) => {
  try {
    await lic.login(String(username || ''), String(password || ''));
    loginMessage = '';
    loginResolve?.(); loginResolve = null;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: /fetch failed|ENOTFOUND|ECONN|timeout/i.test(err.message) ? 'No se pudo conectar con el servidor de licencias. Revisa tu conexión a internet.' : err.message };
  }
});

/** Muestra la ventana de inicio de sesión y espera a que el usuario entre. */
function askLogin(message = '') {
  loginMessage = message;
  return new Promise(resolve => {
    loginResolve = () => { licensed = true; resolve(); }; // la ventana se cierra después de abrir la principal (closeLogin)
    if (loginWin) { loginWin.focus(); return; }
    loginWin = new BrowserWindow({ width: 420, height: 540, resizable: false, backgroundColor: '#0e0f13', title: 'Clippers Pro',
      webPreferences: { preload: path.join(ROOT, 'desktop', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    loginWin.setMenuBarVisibility(false);
    loginWin.loadFile(path.join(ROOT, 'desktop', 'login.html'));
    loginWin.on('closed', () => { if (loginWin) { loginWin = null; if (!licensed) app.quit(); } });
    loginWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
}

function closeLogin() { const w = loginWin; loginWin = null; w?.destroy(); }

/** Comprueba la licencia al arrancar: guardada y vigente (renovándola si hay conexión) o inicio de sesión. */
async function ensureLicense() {
  if (NO_LICENSE) { licensed = true; return; }
  const local = lic.localLicense();
  if (local) {
    // con una licencia local válida se entra al momento; la renovación por internet va en segundo plano
    licensed = true;
    lic.refresh().then(r => { if (!(r.ok || r.offline)) lock(r.message || 'Tu acceso ya no está autorizado.'); }).catch(() => {});
    return;
  }
  return askLogin(lic.licenseInfo().username ? 'Tu sesión caducó. Vuelve a iniciar sesión.' : '');
}

/** Pierde la licencia (revocada, vencida o cierre de sesión): se cierra la ventana y se pide iniciar sesión otra vez. */
let locking = false, serverReady = null;
async function lock(message) {
  licensed = false; locking = true;
  const waiting = askLogin(message); // primero la ventana de inicio de sesión (si no, al cerrar la otra se saldría de la app)
  const w = win; win = null; w?.destroy();
  await waiting;
  await serverReady?.catch(() => {}); // por si el servidor aún está arrancando
  locking = false;
  createWindow();
  closeLogin();
}
function logout() { lic.clearLicense(); lock('Has cerrado la sesión.'); }

// Renovación cada hora; sin conexión la licencia local sirve hasta su caducidad (3 días como máximo)
setInterval(async () => {
  if (!licensed || NO_LICENSE) return;
  const r = await lic.refresh();
  if (r.revoked) return lock(r.message || 'Tu acceso ya no está autorizado.');
  if (r.offline && !lic.localLicense()) return lock('No se pudo comprobar tu licencia durante varios días. Conéctate a internet e inicia sesión.');
}, 3600e3).unref();

app.whenReady().then(async () => {
  const logFile = setupEnv();
  // El servidor arranca a la vez que se comprueba la licencia, y la ventana sale al momento con «Cargando…»
  const serverP = serverReady = startServer();
  serverP.catch(() => {});
  if (NO_LICENSE || lic.localLicense()) createWindow(SPLASH);
  await ensureLicense();
  try {
    baseUrl = await serverP;
  } catch (e) {
    console.error('arranque:', e);
    dialog.showErrorBox('Clippers Pro no pudo arrancar', `${e.message}\n\nRegistro: ${logFile}`);
    return app.quit();
  }
  buildMenu(logFile);
  if (win && !win.isDestroyed()) { if (win.__splash) { win.__splash = false; win.loadURL(baseUrl); } }
  else if (licensed && !locking) createWindow();
  if (!locking) closeLogin();
});
