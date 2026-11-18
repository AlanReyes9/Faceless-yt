// Puente de la ventana principal: la ruta real de un archivo elegido o arrastrado (para usarlo sin subirlo).
const { contextBridge, webUtils } = require('electron');
contextBridge.exposeInMainWorld('clippersDesktop', {
  pathFor: file => { try { return webUtils.getPathForFile(file) || null; } catch { return null; } },
});
