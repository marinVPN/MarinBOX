'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);

// Тема и акцент передаются при запуске, чтобы применить их до первой отрисовки
const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--marin-${name}=`));
  return hit ? hit.slice(name.length + 9) : '';
};

contextBridge.exposeInMainWorld('marin', {
  initialTheme: arg('theme') || 'dark',
  initialAccent: arg('accent') || '',
  state: call('state:get'),
  cabinetLoginStart: call('cabinet:login-start'),
  cabinetLoginExchange: call('cabinet:login-exchange'),
  cabinet: call('cabinet:get'),
  cabinetAction: call('cabinet:action'),
  cabinetLogout: call('cabinet:logout'),
  openExternal: call('external:open'),
  saveSettings: call('settings:save'),
  add: call('sub:add'),
  refresh: call('sub:refresh'),
  remove: call('sub:remove'),
  select: call('server:select'),
  pingAll: call('ping:all'),
  connect: call('vpn:connect'),
  disconnect: call('vpn:disconnect'),
  readClipboard: call('clipboard:read'),
  writeClipboard: call('clipboard:write'),
  openLog: call('log:open'),
  routePresets: call('route:presets'),
  changelog: call('changelog:get'),
  xrayCheck: call('xray:check'),
  xrayUpdate: call('xray:update'),
  checkUpdate: call('update:check'),
  downloadUpdate: call('update:download'),
  installUpdate: call('update:install'),
  minimize: () => ipcRenderer.send('win:min'),
  hide: () => ipcRenderer.send('win:hide'),
  onStatus: (cb) => ipcRenderer.on('vpn:status', (_e, s) => cb(s)),
  onState: (cb) => ipcRenderer.on('state:changed', (_e, s) => cb(s)),
  onToast: (cb) => ipcRenderer.on('toast', (_e, m) => cb(m)),
  onUpdateAvailable: (cb) => ipcRenderer.on('update:available', (_e, m) => cb(m)),
  onUpdateProgress: (cb) => ipcRenderer.on('update:progress', (_e, p) => cb(p)),
  onChangelog: (cb) => ipcRenderer.on('changelog:show', (_e, m) => cb(m)),
});
