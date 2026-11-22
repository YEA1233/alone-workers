const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aloneDesktop', Object.freeze({
  listReleases: () => ipcRenderer.invoke('launcher:list-releases'),
  launchRelease: id => ipcRenderer.invoke('launcher:launch-release', id),
  getState: () => ipcRenderer.invoke('desktop:get-state'),
  completeSetup: settings => ipcRenderer.invoke('desktop:complete-setup', settings),
  setWindowSize: (width, height) => ipcRenderer.invoke('desktop:set-window-size', width, height),
  setFullscreen: enabled => ipcRenderer.invoke('desktop:set-fullscreen', enabled),
  setTheme: theme => ipcRenderer.invoke('desktop:set-theme', theme),
  setLaunchAtStartup: enabled => ipcRenderer.invoke('desktop:set-launch-at-startup', enabled),
  setDiscordEnabled: enabled => ipcRenderer.invoke('desktop:set-discord-enabled', enabled),
  setPresence: state => ipcRenderer.invoke('desktop:set-presence', state),
  quit: () => ipcRenderer.invoke('desktop:quit'),
  getUpdateState: () => ipcRenderer.invoke('desktop:updates:get-state'),
  checkForUpdates: () => ipcRenderer.invoke('desktop:updates:check'),
  downloadUpdate: () => ipcRenderer.invoke('desktop:updates:download'),
  installUpdate: () => ipcRenderer.invoke('desktop:updates:install'),
  openReleasePage: () => ipcRenderer.invoke('desktop:updates:open-releases'),
  onUpdateStatus: callback => {
    if (typeof callback !== 'function') throw new TypeError('Update status callback must be a function.');
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('desktop:update-status', listener);
    return () => ipcRenderer.removeListener('desktop:update-status', listener);
  },
  saves: Object.freeze({
    list: () => ipcRenderer.invoke('desktop:saves:list'),
    read: id => ipcRenderer.invoke('desktop:saves:read', id),
    write: (id, save) => ipcRenderer.invoke('desktop:saves:write', id, save),
    delete: id => ipcRenderer.invoke('desktop:saves:delete', id)
  }),
  openSave: () => ipcRenderer.invoke('desktop:open-save'),
  exportSave: (save, filename) => ipcRenderer.invoke('desktop:export-save', save, filename)
}));
