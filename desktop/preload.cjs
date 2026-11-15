// Puente seguro entre la ventana de inicio de sesión y el proceso principal (sin acceso a Node en la página).
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('clippers', {
  login: (username, password) => ipcRenderer.invoke('license:login', { username, password }),
  info: () => ipcRenderer.invoke('license:info'),
});
