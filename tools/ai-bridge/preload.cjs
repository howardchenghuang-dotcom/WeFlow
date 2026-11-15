const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('weflowBridge', {
  status: () => ipcRenderer.invoke('bridge-status'),
  signIn: () => ipcRenderer.invoke('bridge-sign-in'),
  disconnect: () => ipcRenderer.invoke('bridge-disconnect'),
  openUsage: () => ipcRenderer.invoke('bridge-open-usage'),
  onError: callback => ipcRenderer.on('bridge-error', (_event, message) => callback(message)),
});
