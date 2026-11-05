// The only door between the sandboxed window and the rest of the system.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (name) => async (...args) => {
  const r = await ipcRenderer.invoke(name, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

const api = {};
for (const name of ['docs', 'notices', 'create', 'openNote', 'openPath', 'openFile', 'update', 'commit', 'close', 'setFormat', 'setExtension',
  'tree', 'createFolder', 'createNote', 'readForConvert', 'createBelow', 'move', 'setOrder', 'trash', 'listTrash', 'restoreTrash', 'emptyTrash', 'history', 'readVersion',
  'saveImage', 'search', 'reveal', 'openLink', 'session', 'saveSession', 'settings', 'setSettings', 'chooseFolder', 'changeVault', 'setBackup', 'version']) {
  api[name] = call(name);
}
api.win = (what) => ipcRenderer.send('win', what);
api.onEvent = (fn) => ipcRenderer.on('event', (_e, ev) => fn(ev));
api.onFlush = (fn) => ipcRenderer.on('flush', async () => {
  await fn();
  ipcRenderer.send('flushed');
});
api.pathOfFile = (file) => webUtils.getPathForFile(file);
api.platform = process.platform;

contextBridge.exposeInMainWorld('api', api);
