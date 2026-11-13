// The Electron main process: window, IPC, lifecycle. Everything about keeping text safe lives in store.js.

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, net, protocol, screen, session, shell } from 'electron';
import { existsSync, watch } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { language, setLanguage, t } from '../shared/i18n.js';
import { atomicWrite, checkRel, Store } from './store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;
const SEARCH_TIMEOUT_MS = 15_000;

const dataDir = app.getPath('userData'); // set in boot.cjs

if (!app.requestSingleInstanceLock()) app.exit(0);

const settingsFile = path.join(dataDir, 'settings.json');
const sessionFile = path.join(dataDir, 'session.json');
const DEFAULTS = {
  vault: process.env.MYNOTES_VAULT ?? path.join(os.homedir(), 'MyNotes'), backup: null, theme: 'auto', contrast: false,
  transparency: false, motion: false, glass: 0.5, fontSize: 14, wrap: true, fullWidth: false, jsonIndent: 2, sidebarWidth: 232, sidebarHidden: false, bounds: null, maximized: false, language: 'auto',
  spellcheck: {}, // the documents to check, by path in the notes folder or full path outside it
};

let settings;
let store;
let win = null;
let quitting = false;
let vaultWatcher = null;
let watchTimer = null;

async function loadSettings() {
  let saved;
  try { saved = JSON.parse(await fs.readFile(settingsFile, 'utf8')); }
  catch (e) {
    if (e.code !== 'ENOENT') await fs.rename(settingsFile, `${settingsFile}.unreadable`).catch(() => {});
    saved = null;
  }
  settings = { ...DEFAULTS, ...saved };
  applyLanguage();
  // Only the default folder on first start is ever created. A configured folder that is missing may simply be an
  // unplugged drive, and creating it would put notes where they will not be found later.
  if (!saved) await fs.mkdir(settings.vault, { recursive: true });
}

/** 'auto' follows the system: German for any German locale, English for everything else. */
const applyLanguage = () => setLanguage(settings.language === 'auto' ? app.getLocale() : settings.language);

const saveSettings = () => atomicWrite(settingsFile, Buffer.from(JSON.stringify(settings, null, 2)));

const send = (e) => { if (win && !win.isDestroyed()) win.webContents.send('event', e); };

function watchVault() {
  vaultWatcher?.close();
  vaultWatcher = null;
  try {
    vaultWatcher = watch(settings.vault, { recursive: true }, (_ev, name) => {
      if (name?.endsWith('.mynotes-tmp')) return;
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        send({ type: 'tree' });
        store.checkExternal().catch(() => {});
      }, 400);
    });
    vaultWatcher.on('error', () => { vaultWatcher?.close(); vaultWatcher = null; }); // the window focus check still covers it
  } catch { /* folder offline: picked up again when the window gets focus */ }
}

/** color.background.bottom of MyStyle: what an opaque window shows for a moment while it grows. */
const windowBackground = () => (settings.theme === 'dark' || (settings.theme === 'auto' && nativeTheme.shouldUseDarkColors) ? '#1C1C1F' : '#D5D9E0');

const toggleMaximize = () => { if (win?.isMaximized()) win.unmaximize(); else win?.maximize(); };

function createWindow() {
  // A margin on small screens: a transparent window that exactly fills the work area counts as maximized, and has no size to go back to.
  const { workArea } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    ...(settings.bounds ?? { width: Math.min(1180, workArea.width - 80), height: Math.min(760, workArea.height - 80) }),
    minWidth: 720, minHeight: 480,
    frame: false, title: 'MyNotes', show: false,
    // Windows gives a transparent window no frame styles: no snapping to the screen edges, no animations, no shadow. So there the
    // window is opaque and Windows rounds its corners; elsewhere it is transparent for the round corners of MyStyle W-1.
    ...(process.platform === 'win32'
      ? { backgroundColor: windowBackground() }
      :{ transparent: true, backgroundColor: '#00000000' }),
    webPreferences: {
      preload: path.join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false,
      spellcheck: true, // only where an editor asks for it (spellcheck="true"), with the dictionaries that came with the app
      backgroundThrottling: false, // the timer that saves what was just typed must not wait up to a second because another window covers this one
    },
  });
  if (settings.maximized) win.maximize();
  // MYNOTES_INACTIVE: test runs must not take the keyboard away from whoever is working at this machine
  win.once('ready-to-show', () => (process.env.MYNOTES_INACTIVE ? win.showInactive() : win.show()));
  win.loadURL('mynotes://app/index.html');

  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => { openLink(url); return { action: 'deny' }; });
  // The journal has every acknowledged change, so a crashed window just comes back with its tabs.
  win.webContents.on('render-process-gone', () => { if (!quitting) win.reload(); });
  // Only a misspelled word gets a menu: the window has no other right-click menu in the text.
  win.webContents.on('context-menu', (_e, p) => {
    if (p.misspelledWord) send({ type: 'misspelled', word: p.misspelledWord, suggestions: p.dictionarySuggestions, x: p.x, y: p.y });
  });

  const state = () => send({ type: 'window', maximized: win.isMaximized(), focused: win.isFocused() });
  win.webContents.on('did-finish-load', state); // after a reload too, or a maximized window gets round corners
  win.on('maximize', state);
  win.on('unmaximize', state);
  win.on('blur', state);
  win.on('focus', () => {
    state();
    send({ type: 'tree' }); // also clears the "folder offline" message once a drive is back
    store.checkExternal().catch(() => {});
    if (!vaultWatcher) watchVault();
  });
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    quit();
  });
}

function openLink(url) {
  try {
    if (['http:', 'https:', 'mailto:'].includes(new URL(url).protocol)) shell.openExternal(url);
  } catch { /* not a URL */ }
}

/**
 * The MSI gives its shortcuts the icon from %APPDATA%\Microsoft\Installer\{ProductCode}, and every update has a new
 * ProductCode and deletes the old folder. The installer renews its own shortcuts, but not a pin on the taskbar,
 * which is left with a blank icon. So a pin that starts this exe takes its icon from the exe itself.
 */
async function fixPinnedIcons(dir, exe) {
  for (const name of await fs.readdir(dir).catch(() => [])) {
    const file = path.join(dir, name);
    try {
      const link = shell.readShortcutLink(file);
      if (link.target.toLowerCase() === exe.toLowerCase() && link.icon !== exe) shell.writeShortcutLink(file, 'update', { icon: exe, iconIndex: 0 });
    } catch { /* not a shortcut, or not ours to change */ }
  }
}

/**
 * German and English at once, and never online: Chromium would download its dictionaries from Google. It finds them in place
 * instead, and if it looked for one anyway, its download address leads nowhere. On Windows the system checks the languages it knows.
 */
async function setupSpelling() {
  const dir = path.join(dataDir, 'Dictionaries');
  await fs.mkdir(dir, { recursive: true });
  for (const name of ['de-DE-3-0.bdic', 'en-US-10-2.bdic']) {
    const from = path.join(here, 'dictionaries', name);
    const to = path.join(dir, name);
    const size = async (f) => (await fs.stat(f).catch(() => null))?.size;
    if (await size(to) !== await size(from)) await fs.copyFile(from, to); // also replaces a copy cut short
  }
  session.defaultSession.setSpellCheckerDictionaryDownloadURL('http://127.0.0.1:9/');
  session.defaultSession.setSpellCheckerLanguages(['de-DE', 'en-US']);
}

/** A note moved or renamed, also by its title: its spelling setting goes with it, before the window hears of the new path. */
function moveSpelling(from, to) {
  const map = settings.spellcheck;
  const keys = Object.keys(map).filter((k) => k === from || k.startsWith(`${from}/`));
  if (!keys.length) return;
  for (const k of keys) { delete map[k]; map[to + k.slice(from.length)] = true; }
  send({ type: 'spellcheck', map });
  saveSettings().catch(() => {});
}

const timeout = (ms) => new Promise((r) => setTimeout(r, ms));

async function quit() {
  if (quitting) return;
  quitting = true;
  try {
    if (win && !win.isDestroyed()) {
      settings.maximized = win.isMaximized();
      if (!settings.maximized) settings.bounds = win.getBounds();
      await Promise.race([saveSettings().catch(() => {}), timeout(500)]);
      await Promise.race([
        new Promise((r) => { ipcMain.once('flushed', r); win.webContents.send('flush'); }),
        timeout(1500),
      ]);
    }
    await Promise.race([store.shutdown(), timeout(3000)]); // a hanging drive must not block the exit: the journal has it
  } finally {
    app.exit(0);
  }
}

async function openPaths(argv) {
  for (const [i, p] of argv.entries()) {
    if (p.startsWith('-') || argv[i - 1] === '-r' || !existsSync(p)) continue; // -r: a preload for Node, not a document
    try {
      if ((await fs.stat(p)).isFile()) send({ type: 'opened', doc: await store.openExternal(p) });
    } catch (e) { send({ type: 'error', message: e.message }); }
  }
}

function search({ query, regex, caseSensitive }) {
  if (typeof query !== 'string' || !query) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(here, 'search-worker.js'), { workerData: { vault: settings.vault, query, regex: !!regex, caseSensitive: !!caseSensitive, language: language() } });
    // A pathological regex must not take the app down with it, so it runs in a thread that can be killed.
    const timer = setTimeout(() => { worker.terminate(); reject(new Error(t('Die Suche hat zu lange gedauert. Versuche einen einfacheren Ausdruck.'))); }, SEARCH_TIMEOUT_MS);
    worker.once('message', (m) => { clearTimeout(timer); worker.terminate(); if (m.error) reject(new Error(m.error)); else resolve(m.results); });
    worker.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

function registerIpc() {
  const handle = (name, fn) => ipcMain.handle(name, async (e, ...args) => {
    if (!e.senderFrame?.url.startsWith('mynotes://app/')) throw new Error(t('Nicht erlaubt.'));
    try { return { ok: true, value: await fn(...args) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  handle('docs', () => store.documents());
  handle('notices', () => store.takeNotices());
  handle('create', (o) => store.create(o));
  handle('openNote', (rel) => store.openNote(rel));
  handle('openPath', (p) => store.openExternal(p));
  handle('openFile', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
    return Promise.all(r.filePaths.map((p) => store.openExternal(p)));
  });
  handle('update', (id, text) => store.update(id, text));
  handle('commit', (id) => store.commit(id));
  handle('close', (id) => store.close(id));
  handle('setFormat', (id, f) => store.setFormat(id, f));
  handle('setExtension', (id, ext) => store.setExtension(id, ext));
  handle('tree', () => store.tree());
  handle('createFolder', (parent, name) => store.createFolder(parent, name));
  handle('createNote', (folder, name) => store.createNote(folder, name));
  handle('readForConvert', (rel) => store.readForConvert(rel));
  handle('createBelow', (rel, name, ext, bytes) => store.createBelow(rel, name, ext, bytes));
  handle('move', (rel, dest, name) => store.move(rel, dest, name));
  handle('setOrder', (folder, names) => store.setOrder(folder, names));
  handle('trash', (rel) => store.trash(rel));
  handle('listTrash', () => store.listTrash());
  handle('restoreTrash', (id) => store.restoreTrash(id));
  handle('emptyTrash', () => store.emptyTrash());
  handle('history', (ref) => store.history(ref));
  handle('readVersion', (ref, v) => store.readVersion(ref, v));
  handle('saveImage', (bytes, ext) => store.saveAsset(bytes, ext));
  handle('search', (q) => search(q));
  handle('reveal', (rel) => shell.showItemInFolder(path.join(settings.vault, ...checkRel(rel).split('/'))));
  handle('openLink', (url) => openLink(url));
  handle('session', async () => { try { return JSON.parse(await fs.readFile(sessionFile, 'utf8')); } catch { return null; } });
  handle('saveSession', (s) => atomicWrite(sessionFile, Buffer.from(JSON.stringify(s))));

  handle('settings', () => settings);
  handle('setSpellcheck', async (key, on) => {
    if (typeof key !== 'string' || !key) throw new Error(t('Nicht erlaubt.'));
    if (on) settings.spellcheck[key] = true;
    else delete settings.spellcheck[key];
    await saveSettings();
    return settings.spellcheck;
  });
  handle('replaceMisspelling', (word) => win.webContents.replaceMisspelling(String(word)));
  handle('addToDictionary', (word) => { session.defaultSession.addWordToSpellCheckerDictionary(String(word)); });
  handle('version', () => app.getVersion());
  handle('setSettings', async (patch) => {
    for (const k of ['theme', 'contrast', 'transparency', 'motion', 'glass', 'fontSize', 'wrap', 'fullWidth', 'jsonIndent', 'sidebarWidth', 'sidebarHidden', 'language']) {
      if (k in patch) settings[k] = patch[k];
    }
    applyLanguage();
    if (process.platform === 'win32') win?.setBackgroundColor(windowBackground());
    await saveSettings();
    return settings;
  });
  handle('chooseFolder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.filePaths[0] ?? null;
  });
  handle('changeVault', async (dir) => {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error(t('Wähle einen vollständigen Ordnerpfad.'));
    await store.changeVault(dir);
    settings.vault = store.vault;
    await saveSettings();
    watchVault();
    return settings;
  });
  handle('setBackup', async (dir) => {
    if (dir !== null) {
      if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error(t('Wähle einen vollständigen Ordnerpfad.'));
      const within = (a, b) => { const r = path.relative(a, b); return !r || (!r.startsWith('..') && !path.isAbsolute(r)); };
      // Inside each other the backup would copy itself again on every run.
      if (within(settings.vault, dir) || within(dir, settings.vault)) throw new Error(t('Der Sicherungsort darf nicht im Notizordner liegen. Wähle ein anderes Laufwerk oder einen anderen Ordner.'));
    }
    settings.backup = dir;
    await saveSettings();
    store.setBackup(dir);
    return settings;
  });

  // Synchronous: the window's modules need it before their first line runs.
  ipcMain.on('language', (e) => { e.returnValue = language(); });
  ipcMain.on('win', (_e, what) => {
    if (what === 'reload') win?.webContents.reload(); // a new language: the journal and session.json bring every tab back
    else if (what === 'minimize') win?.minimize();
    else if (what === 'maximize') toggleMaximize();
    else if (what === 'close') win?.close();
  });
}

function registerProtocol() {
  const appRoot = path.join(app.getAppPath(), 'dist');
  protocol.handle('mynotes', async (req) => {
    const url = new URL(req.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const inside = (root, p) => { const r = path.relative(root, p); return r && !r.startsWith('..') && !path.isAbsolute(r); };
    const notFound = new Response('', { status: 404 });
    if (url.host === 'app') {
      const file = path.join(appRoot, rel);
      return inside(appRoot, file) ? net.fetch(pathToFileURL(file).toString()) : notFound;
    }
    if (url.host === 'asset') {
      const file = path.join(settings.vault, rel);
      return inside(settings.vault, file) && IMAGE_EXT.test(file) ? net.fetch(pathToFileURL(file).toString()) : notFound;
    }
    return notFound;
  });
}

app.on('second-instance', (_e, argv) => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  openPaths(argv.slice(1));
});
app.on('before-quit', (e) => { if (!quitting) { e.preventDefault(); quit(); } });
app.on('window-all-closed', () => quit());

await app.whenReady();
await loadSettings();
store = new Store({ dataDir, vault: settings.vault, backup: settings.backup, onEvent: (e) => (e.type === 'moved' ? moveSpelling(e.from, e.to) : send(e)) });
await store.start();
Menu.setApplicationMenu(null); // the default menu's accelerators (Ctrl+R reload, Ctrl+W close) would act behind our back
registerProtocol();
registerIpc();
await setupSpelling().catch((e) => console.error('spelling:', e)); // without it the notes still open
createWindow();
watchVault();
store.syncBackup();
if (process.platform === 'win32' && app.isPackaged) fixPinnedIcons(path.join(app.getPath('appData'), 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar'), process.execPath);
win.webContents.once('did-finish-load', () => openPaths(process.argv.slice(app.isPackaged ? 1 : 2)));
