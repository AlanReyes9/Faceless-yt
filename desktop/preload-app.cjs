// Puente de la ventana principal: la ruta real de un archivo elegido o arrastrado (para usarlo sin subirlo).
const { contextBridge, webUtils, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('clippersDesktop', {
  pathFor: file => { try { return webUtils.getPathForFile(file) || null; } catch { return null; } },
  // Publicar a mano: arrastrar el vídeo a la web de la red social y guardar una copia con nombre legible en Descargas
  dragFile: file => ipcRenderer.send('clip:drag', file),
  saveToDownloads: (file, name) => ipcRenderer.invoke('clip:save', { file, name }),
});
