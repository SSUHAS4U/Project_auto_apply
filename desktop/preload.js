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
  // The installed build's version, shown in the sidebar. Without it there is no way to tell a
  // freshly auto-updated app from the one that has been running for three days, and a report
  // like "still broken" is unanswerable — a whole afternoon went into diagnosing runs that
  // turned out to predate the fixes entirely.
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  startWorker: (token) => ipcRenderer.invoke('worker:start', token),
  stopWorker: () => ipcRenderer.invoke('worker:stop'),
  getWorkerStatus: () => ipcRenderer.invoke('worker:status'),
  getSavedToken: () => ipcRenderer.invoke('worker:savedToken'),
  getRecentLog: () => ipcRenderer.invoke('worker:recentLog'),
  clearLog: () => ipcRenderer.invoke('worker:clearLog'),

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
