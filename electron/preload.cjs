const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('castv', {
  getDisplaySources: () => ipcRenderer.invoke('castv:get-display-sources'),
  selectDisplaySource: (sourceId) => ipcRenderer.invoke('castv:select-display-source', sourceId),
  getCastTargets: () => ipcRenderer.invoke('castv:get-cast-targets'),
  rescanCastTargets: () => ipcRenderer.invoke('castv:rescan-cast-targets'),
  onCastTargets: (callback) => {
    const listener = (_event, targets) => callback(targets);
    ipcRenderer.on('castv:cast-targets-changed', listener);
    return () => ipcRenderer.removeListener('castv:cast-targets-changed', listener);
  },
  setAirplayMeta: (meta) => ipcRenderer.invoke('castv:airplay-set-meta', meta),
  setAirplayInit: (data) => ipcRenderer.invoke('castv:airplay-set-init', data),
  setAirplaySegment: (data, info) => ipcRenderer.invoke('castv:airplay-set-segment', data, info),
  playAirplay: (target) => ipcRenderer.invoke('castv:airplay-play', target),
  stopAirplay: () => ipcRenderer.invoke('castv:airplay-stop'),
  onAirplayError: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('castv:airplay-error', listener);
    return () => ipcRenderer.removeListener('castv:airplay-error', listener);
  },
});
