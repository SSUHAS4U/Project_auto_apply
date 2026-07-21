// The only bridge between the dashboard (web content) and the Electron shell. Everything
// exposed here is deliberately small and typed by hand in the frontend (see lib/desktop.ts).
// The presence of window.jobpilot is how the React app knows it's running inside the app
// (and therefore shows the terminal + Connect controls).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jobpilot', {
  isDesktop: true,
  platform: process.platform,
  backendUrl: ipcRenderer.sendSync('app:backendUrl'),

  // ---- worker control ----
  startWorker: (token) => ipcRenderer.invoke('worker:start', token),
  stopWorker: () => ipcRenderer.invoke('worker:stop'),
  getWorkerStatus: () => ipcRenderer.invoke('worker:status'),
  getSavedToken: () => ipcRenderer.invoke('worker:savedToken'),

  // ---- live streams (return an unsubscribe fn) ----
  onWorkerLog: (cb) => {
    const h = (_e, line) => cb(line);
    ipcRenderer.on('worker:log', h);
    return () => ipcRenderer.removeListener('worker:log', h);
  },
  onWorkerStatus: (cb) => {
    const h = (_e, status) => cb(status);
    ipcRenderer.on('worker:status', h);
    return () => ipcRenderer.removeListener('worker:status', h);
  },
});
