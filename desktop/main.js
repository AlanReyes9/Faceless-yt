// Clippers Pro de escritorio (Windows / macOS / Linux).
// Arranca el mismo servidor de la web dentro de la app (base de datos y vídeos en tu ordenador)
// y lo muestra en una ventana. ffmpeg y yt-dlp van incluidos.
import { app, BrowserWindow, shell, Menu, dialog, safeStorage } from 'electron';
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
  };
  // yt-dlp incluido (YouTube, Twitch, Kick)
  const bin = app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(ROOT, 'desktop', 'bin');
  if (fs.existsSync(bin)) process.env.PATH = bin + path.delimiter + (process.env.PATH || '');
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
  });
  if (!port) process.env.PUBLIC_URL = `http://localhost:${real}`;
  startLocalWorker();
  const clean = () => runCleanup().catch(e => console.error('limpieza:', e.message));
  setTimeout(clean, 60000); setInterval(clean, 6 * 3600e3);
  console.log('Clippers Pro (escritorio) en', process.env.PUBLIC_URL, '· datos:', process.env.DATA_DIR);
  return `http://localhost:${real}`;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 880, minWidth: 900, minHeight: 600, backgroundColor: '#0f1013', title: 'Clippers Pro',
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const isApp = u => { try { return new URL(u).origin === new URL(baseUrl).origin; } catch { return false; } };
  // Enlaces externos (Google, YouTube, webs de las claves…) en el navegador del sistema.
  // Google no permite iniciar sesión dentro de una ventana embebida.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isApp(url)) return { action: 'allow' };
    shell.openExternal(url); return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!isApp(url)) { e.preventDefault(); shell.openExternal(url); } });
  win.loadURL(baseUrl);
  win.on('closed', () => { win = null; });
}

function buildMenu(logFile) {
  const tpl = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'Archivo', submenu: [
      { label: 'Abrir carpeta de datos', click: () => shell.openPath(process.env.DATA_DIR) },
      { label: 'Ver registro', click: () => shell.openPath(logFile) },
      { label: 'Abrir en el navegador', click: () => shell.openExternal(baseUrl) },
      { type: 'separator' }, process.platform === 'darwin' ? { role: 'close' } : { role: 'quit', label: 'Salir' }] },
    { label: 'Editar', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'Ver', submenu: [{ role: 'reload', label: 'Recargar' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit()); // al cerrar la ventana se detiene el servidor (los trabajos en curso se reanudan al volver a abrir)
app.on('activate', () => { if (!win && baseUrl) createWindow(); });

app.whenReady().then(async () => {
  const logFile = setupEnv();
  try {
    baseUrl = await startServer();
  } catch (e) {
    console.error('arranque:', e);
    dialog.showErrorBox('Clippers Pro no pudo arrancar', `${e.message}\n\nRegistro: ${logFile}`);
    return app.quit();
  }
  buildMenu(logFile);
  createWindow();
});
