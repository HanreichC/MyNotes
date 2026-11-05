// The window: tabs, tree, commands. Text only ever reaches the disk through window.api.update (see store.js).
import { JsonError, minifyJson, prettyJson } from '../shared/json.js';
import { nameFromText } from '../shared/text.js';
import { createCodeEditor, lineCommands } from './code-editor.js';
import { icon } from './icons.js';
import { createMdEditor, isFaithful } from './md-editor.js';
import { alertDialog, el, menu, pick, promptDialog, row, section, sheet } from './ui.js';

const api = window.api;
const $ = (id) => document.getElementById(id);
const RICH_LIMIT = 2 * 1024 * 1024; // above this the WYSIWYG view gets slow: open the source instead
const isMd = (doc) => /^\.(md|markdown)$/i.test(doc.ext);

const state = {
  tabs: [], activeId: null, split: null /* [left id, right id], one of them the active tab */, tree: { items: [], online: true }, expanded: new Set(), filter: '', settings: null,
  closed: [], sessionReady: false, seenBackupHint: false, focusPath: null, drag: null,
};

const activeTab = () => state.tabs.find((t) => t.id === state.activeId) ?? null;

// ---------------------------------------------------------------- messages

function banner({ kind = 'info', text, action, sticky = false, key }) {
  if (key && $('banner').querySelector(`[data-key="${key}"]`)) return null;
  const box = el('div', { class: `inline-msg inline-msg--${kind}`, 'data-key': key ?? '', html: icon({ warning: 'warning', error: 'error', ok: 'check' }[kind] ?? 'info') });
  box.append(el('span', { class: 'ms-callout inline-msg__text' }, text));
  if (action) box.append(el('button', { class: 'ms-button', onclick: () => { box.remove(); paintBanner(); action.run(); } }, action.label));
  if (!sticky) box.append(el('button', { class: 'round-btn round-btn--s', 'aria-label': 'Meldung schließen', title: 'Meldung schließen', html: icon('close'), onclick: () => { box.remove(); paintBanner(); } }));
  $('banner').append(box);
  paintBanner();
  return box;
}
const paintBanner = () => { $('banner').hidden = !$('banner').children.length; };
const clearBanner = (key) => { $('banner').querySelector(`[data-key="${key}"]`)?.remove(); paintBanner(); };
const failed = (e) => banner({ kind: 'warning', text: e.message });

async function pullNotices() {
  for (const n of await api.notices()) banner(n);
}

// ---------------------------------------------------------------- saving

/** Sends the editor's text to the journal. Called debounced while typing and at once before anything risky. */
function send(tab) {
  clearTimeout(tab.timer);
  tab.timer = null;
  if (!tab.editor) return Promise.resolve();
  const text = tab.editor.getText();
  if (text === tab.lastSent) return tab.inflight ?? Promise.resolve();
  tab.lastSent = text;
  tab.doc.text = text;
  if (tab.doc.autoTitle && !tab.doc.external) {
    const title = nameFromText(text, tab.doc.ext);
    if (title !== tab.title) { tab.title = title; paintTabs(); }
  }
  const stuck = setTimeout(() => setSaveState(tab, 'pending'), 500);
  tab.inflight = api.update(tab.id, text).then((r) => {
    clearTimeout(stuck);
    if (r.ok) setSaveState(tab, 'durable');
    return r;
  }).catch((e) => {
    clearTimeout(stuck);
    setSaveState(tab, 'journal-error', e.message);
  });
  return tab.inflight;
}

const flushAll = () => Promise.all(state.tabs.map(send));

function changed(tab) {
  if (tab.silent) return;
  // Not restarted by the next key: whoever types without a pause is still saved every 150 ms.
  tab.timer ??= setTimeout(() => send(tab), tab.doc.text.length > 1_000_000 ? 1000 : 150);
  paintPosition();
  saveSessionSoon();
}

const SAVE_TEXT = {
  pending: ['info', 'Sichert …'],
  durable: ['check', 'Gesichert'],
  committed: ['check', 'Gespeichert'],
  recovered: ['check', 'Gespeichert'],
  'vault-error': ['warning', 'Nicht im Notizordner, aber im Journal gesichert'],
  'journal-error': ['error', 'Sichern fehlgeschlagen'],
};

function setSaveState(tab, saveState, detail) {
  // A failure stays visible until a commit proves otherwise: "durable" alone does not mean the folder is back.
  if (saveState === 'durable' && (tab.saveState === 'vault-error')) return paintSave();
  const warns = (s) => s === 'vault-error' || s === 'journal-error';
  const repaint = warns(tab.saveState) !== warns(saveState);
  tab.saveState = saveState;
  tab.saveDetail = detail;
  if (saveState === 'journal-error') {
    banner({ kind: 'error', key: 'journal', sticky: true, text: `Der Text konnte nicht auf die Platte geschrieben werden (${detail}). Lass das Fenster offen, die App versucht es weiter.` });
  } else if (saveState === 'durable' || saveState === 'committed') {
    clearBanner('journal');
  }
  if (repaint) paintTabs(); // not on every keystroke: it would interrupt dragging a tab
  return paintSave();
}

function paintSave() {
  const tab = activeTab();
  const [ic, text] = SAVE_TEXT[tab?.saveState ?? 'durable'] ?? SAVE_TEXT.durable;
  const node = $('st-save');
  node.innerHTML = icon(ic);
  node.append(tab?.saveDetail && tab.saveState === 'vault-error' ? `${text}: ${tab.saveDetail}` : text);
  node.dataset.state = tab?.saveState ?? 'durable';
  if (state.backupError) node.append(` · Sicherungsort nicht erreichbar`);
}

// ---------------------------------------------------------------- tabs

function displayName(tab) {
  if (tab.doc.autoTitle && !tab.doc.external && tab.title) return tab.title;
  return tab.doc.name.replace(/\.(md|markdown)$/i, '');
}

function addTab(doc) {
  const existing = state.tabs.find((t) => t.id === doc.id);
  if (existing) return existing;
  const tab = {
    id: doc.id, doc, editor: null, pane: null, mode: isMd(doc) ? 'rich' : 'code', timer: null, inflight: null,
    lastSent: doc.text, silent: false, saveState: 'durable', title: doc.autoTitle ? nameFromText(doc.text, doc.ext) : null, cursor: null,
  };
  state.tabs.push(tab);
  return tab;
}

function ensureEditor(tab) {
  if (tab.editor) return;
  tab.pane = el('div', { class: 'pane', 'data-doc': tab.id });
  tab.pane.addEventListener('focusin', () => { if (tab.id !== state.activeId && state.split?.includes(tab.id)) activate(tab.id, false); });
  $('editors').append(tab.pane);
  const onChange = () => changed(tab);
  const onCursor = () => { if (tab.id === state.activeId) paintPosition(); saveSessionSoon(); };
  const code = () => createCodeEditor({
    parent: tab.pane, text: tab.doc.text, name: tab.doc.name, wrap: state.settings.wrap, onChange, onCursor,
  });
  if (tab.mode === 'rich' && tab.doc.text.length > RICH_LIMIT) tab.mode = 'code';
  if (tab.mode === 'rich') {
    // Whatever goes wrong in the live editor must never keep a note from opening: the source view always works.
    let faithful = false;
    try {
      tab.silent = true;
      tab.editor = createMdEditor({
        parent: tab.pane, text: tab.doc.text, onChange, onCursor, onImageError: (m) => banner({ kind: 'warning', text: m }),
        onJsonIntoEmpty: (text) => becomeJson(tab, text),
      });
      faithful = tab.forceRich || isFaithful(tab.doc.text, tab.editor.getText());
    } catch (e) {
      console.error(e);
    } finally {
      tab.silent = false;
    }
    if (!faithful) {
      try { tab.editor?.destroy(); } catch { /* it failed to build in the first place */ }
      tab.pane.replaceChildren();
      tab.mode = 'code';
      tab.editor = code();
      banner({
        kind: 'info', key: `src-${tab.id}`,
        text: `„${displayName(tab)}“ enthält Inhalte, die der Live-Editor verändern würde. Sie ist deshalb in der Quelltextansicht geöffnet.`,
        action: { label: 'Trotzdem live bearbeiten', run: () => { tab.forceRich = true; switchMode(tab, 'rich'); } },
      });
    }
  } else {
    tab.editor = code();
  }
  if (tab.cursor) tab.editor.setCursor(tab.cursor);
}

async function switchMode(tab, mode) {
  await send(tab);
  tab.cursor = null;
  tab.editor?.destroy();
  tab.pane?.remove();
  tab.editor = null;
  tab.pane = null;
  tab.mode = mode;
  if (tab.id === state.activeId) activate(tab.id);
  else layoutPanes();
}

/** JSON pasted into an empty note: from now on it is a JSON file in the code editor. */
async function becomeJson(tab, text) {
  try {
    tab.doc = await api.setExtension(tab.id, '.json');
    tab.doc.text = text;
    tab.lastSent = '';
    tab.editor.destroy();
    tab.pane.remove();
    tab.editor = null;
    tab.pane = null;
    tab.mode = 'code';
    activate(tab.id);
    tab.editor.setText(text);
    await send(tab);
  } catch (e) { failed(e); }
}

function activate(id, focus = true) {
  const prev = activeTab();
  if (prev && prev.id !== id) {
    send(prev);
    if (prev.pane) prev.cursor = prev.editor?.getCursor();
    // Side by side, another tab takes the place of the side being worked in.
    if (state.split && !state.split.includes(id)) state.split[state.split.indexOf(prev.id)] = id;
  }
  state.activeId = id;
  const tab = activeTab();
  if (!tab) return;
  layoutPanes();
  paintTabs();
  paintTree();
  paintStatus();
  if (focus) tab.editor.focus();
  saveSessionSoon();
}

/** Shows the active tab, or both tabs side by side. */
function layoutPanes() {
  const [left, right] = state.split ?? [];
  for (const t of state.tabs) {
    const shown = state.split ? state.split.includes(t.id) : t.id === state.activeId;
    if (shown) ensureEditor(t);
    if (!t.pane) continue;
    t.pane.hidden = !shown;
    t.pane.classList.toggle('pane--left', t.id === left);
    t.pane.classList.toggle('pane--right', t.id === right);
  }
}

/** Puts a tab on one side (0 left, 1 right). The other side keeps what is there, or shows the active tab or a neighbour. */
function placeBeside(id, side) {
  const at = state.tabs.findIndex((t) => t.id === id);
  let other = state.split?.[1 - side] ?? (id !== state.activeId ? state.activeId : (state.tabs[at + 1] ?? state.tabs[at - 1]).id);
  if (other === id) other = state.split[side]; // moved to the other side: the two swap places
  state.split = side ? [other, id] : [id, other];
  activate(id);
}

/** A tab of the pair is gone or hidden: returns the other one, which gets the whole card. */
function leaveSplit(id) {
  if (!state.split?.includes(id)) return null;
  const other = state.split.find((x) => x !== id);
  state.split = null;
  return other;
}

function paintSplitHead() {
  const head = $('split-head');
  head.hidden = !state.split;
  head.replaceChildren(...(state.split ?? []).map((id) => {
    const name = displayName(state.tabs.find((t) => t.id === id));
    return el('div', { class: `split-side${id === state.activeId ? ' is-active' : ''}` },
      el('span', { class: 'tab-name ms-callout' }, name),
      el('button', {
        class: 'round-btn round-btn--s', 'aria-label': `${name} ausblenden`, title: 'Ausblenden, der Tab bleibt offen', html: icon('close'),
        onclick: () => activate(leaveSplit(id)),
      }));
  }));
}

function endTabDrag() {
  state.dragTab = null;
  $('split-drop').hidden = true;
  for (const zone of $('split-drop').children) zone.classList.remove('is-over');
  if (state.tabsStale) { state.tabsStale = false; paintTabs(); }
}

async function newTab(opts) {
  try {
    const tab = addTab(await api.create(opts));
    activate(tab.id);
    return tab;
  } catch (e) { failed(e); return null; }
}

/** Opening something replaces an empty, untouched tab, as Notepad++ does with its "new 1". */
function show(doc) {
  const previous = activeTab();
  const tab = addTab(doc);
  activate(tab.id);
  if (previous && previous !== tab && !previous.doc.path && !previous.doc.external && !previous.doc.text) closeTab(previous.id);
  return tab;
}

async function openNote(path, then) {
  try {
    const tab = show(await api.openNote(path));
    then?.(tab);
  } catch (e) { failed(e); }
}

async function closeTab(id) {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return;
  await send(tab);
  const at = state.tabs.indexOf(tab);
  state.tabs.splice(at, 1);
  tab.editor?.destroy();
  tab.pane?.remove();
  if (tab.doc.path) state.closed.push(tab.doc.path);
  const partner = leaveSplit(id);
  if (partner) activate(partner);
  else if (state.activeId === id) {
    state.activeId = null;
    const next = state.tabs[Math.min(at, state.tabs.length - 1)];
    if (next) activate(next.id);
    else await newTab();
  }
  paintTabs();
  api.close(id).catch(failed);
  saveSessionSoon();
}

function dropTab(id) { // the document is already gone in the store
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return;
  clearTimeout(tab.timer);
  const at = state.tabs.indexOf(tab);
  state.tabs.splice(at, 1);
  tab.editor?.destroy();
  tab.pane?.remove();
  const partner = leaveSplit(id);
  if (partner) activate(partner);
  else if (state.activeId === id) {
    state.activeId = null;
    const next = state.tabs[Math.min(at, state.tabs.length - 1)];
    if (next) activate(next.id);
    else newTab();
  }
  paintTabs();
}

function cycleTab(delta) {
  if (state.tabs.length < 2) return;
  const i = state.tabs.findIndex((t) => t.id === state.activeId);
  activate(state.tabs[(i + delta + state.tabs.length) % state.tabs.length].id);
}

function paintTabs() {
  if (state.dragTab) { state.tabsStale = true; return; }
  const list = $('tab-list');
  list.replaceChildren(...state.tabs.map((tab) => {
    const active = tab.id === state.activeId;
    const warn = tab.saveState === 'vault-error' || tab.saveState === 'journal-error';
    const node = el('div', {
      class: `tab${active ? ' is-active' : ''}${!active && state.split?.includes(tab.id) ? ' is-paired' : ''}`, role: 'tab', 'aria-selected': String(active), tabIndex: active ? 0 : -1,
      draggable: true, title: tab.doc.external ?? tab.doc.path ?? 'Noch nicht benannt',
      onclick: () => activate(tab.id),
      onauxclick: (e) => { if (e.button === 1) closeTab(tab.id); },
      onkeydown: (e) => {
        if (e.key === 'ArrowRight') { e.preventDefault(); cycleTab(1); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); cycleTab(-1); }
      },
      oncontextmenu: (e) => { e.preventDefault(); tabMenu(tab, { x: e.clientX, y: e.clientY }); },
      ondragstart: (e) => { state.dragTab = tab.id; e.dataTransfer.effectAllowed = 'move'; $('split-drop').hidden = state.tabs.length < 2; },
      ondragend: endTabDrag,
      ondragover: (e) => { if (state.dragTab) { e.preventDefault(); e.stopPropagation(); } },
      ondrop: (e) => {
        if (!state.dragTab) return;
        e.preventDefault();
        e.stopPropagation();
        const from = state.tabs.findIndex((t) => t.id === state.dragTab);
        const to = state.tabs.indexOf(tab);
        state.tabs.splice(to, 0, state.tabs.splice(from, 1)[0]);
        endTabDrag();
        paintTabs();
        saveSessionSoon();
      },
    },
    warn ? el('span', { class: 'tab-warn', html: icon('warning'), title: 'Nicht im Notizordner gespeichert' }) : null,
    el('span', { class: 'tab-name ms-callout' }, displayName(tab)),
    el('button', {
      class: 'tab-close', 'aria-label': `${displayName(tab)} schließen`, title: 'Schließen (Strg+W)', tabIndex: -1, html: icon('close'),
      onclick: (e) => { e.stopPropagation(); closeTab(tab.id); },
    }));
    return node;
  }));
  // Into view when the active tab changes or while typing, but a repaint must not pull the list away from someone looking for another tab.
  if (state.activeId !== state.tabInView || !list.matches(':hover')) list.querySelector('.is-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  state.tabInView = state.activeId;
  paintSplitHead();
}

function tabMenu(tab, at) {
  menu(at, [
    { label: 'Schließen', run: () => closeTab(tab.id) },
    { label: 'Andere schließen', run: () => state.tabs.filter((t) => t !== tab).forEach((t) => closeTab(t.id)) },
    { separator: true },
    ...(state.tabs.length > 1 ? [{ label: 'Rechts daneben anzeigen', run: () => placeBeside(tab.id, 1) }] : []),
    ...(state.split?.includes(tab.id) ? [{ label: 'Nebeneinander beenden', run: () => { state.split = null; activate(tab.id); } }] : []),
    { separator: true },
    ...(tab.doc.path ? [
      { label: 'Umbenennen …', run: () => renameItem(tab.doc.path, tab.doc.name) },
      { label: 'Im Dateimanager zeigen', run: () => api.reveal(tab.doc.path) },
    ] : []),
    { label: 'Verlauf anzeigen …', run: () => showHistory({ id: tab.id }, displayName(tab)) },
  ]);
}

// ---------------------------------------------------------------- status bar

function paintPosition() {
  $('st-pos').textContent = activeTab()?.editor?.position() ?? '';
}

function paintStatus() {
  const tab = activeTab();
  paintSave();
  paintPosition();
  if (!tab) return;
  const md = isMd(tab.doc);
  $('st-mode').textContent = md ? (tab.mode === 'rich' ? 'Live' : 'Quelltext') : (tab.doc.ext.slice(1).toUpperCase() || 'Text');
  $('st-mode').disabled = !md;
  $('st-mode').title = md ? 'Zwischen Live-Ansicht und Quelltext wechseln (Strg+/)' : '';
  const enc = { 'utf-8': 'UTF-8', 'utf-16le': 'UTF-16 LE', 'utf-16be': 'UTF-16 BE', 'windows-1252': 'Windows-1252' }[tab.doc.encoding];
  $('st-enc').textContent = tab.doc.bom ? `${enc} BOM` : enc;
  $('st-eol').textContent = { '\n': 'LF', '\r\n': 'CRLF', '\r': 'CR' }[tab.doc.eol];
}

async function changeFormat(fmt) {
  const tab = activeTab();
  try {
    await send(tab);
    tab.doc = await api.setFormat(tab.id, fmt);
    paintStatus();
  } catch (e) { failed(e); }
}

// ---------------------------------------------------------------- tree

const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

function flat(items, out = []) {
  for (const i of items) { out.push(i); if (i.children) flat(i.children, out); }
  return out;
}

async function refreshTree() {
  clearTimeout(state.treeTimer);
  try {
    state.tree = await api.tree();
    if (!state.tree.online) banner({ kind: 'warning', key: 'offline', sticky: true, text: `Der Notizordner ${state.tree.vault} ist nicht erreichbar. Dein Text bleibt im Journal, bis er wieder da ist.` });
    else clearBanner('offline');
    paintTree();
  } catch (e) { failed(e); }
}
const refreshTreeSoon = () => { clearTimeout(state.treeTimer); state.treeTimer = setTimeout(refreshTree, 120); };

function visibleRows() {
  const q = state.filter.toLowerCase();
  const rows = [];
  const walk = (items, depth) => {
    for (const it of items) {
      if (it.type === 'folder') {
        const matches = q ? flat(it.children).some((c) => c.name.toLowerCase().includes(q)) : false;
        if (q && !matches && !it.name.toLowerCase().includes(q)) continue;
        rows.push({ it, depth });
        if (q ? matches : state.expanded.has(it.path)) walk(it.children, depth + 1);
      } else if (!q || it.name.toLowerCase().includes(q)) {
        rows.push({ it, depth });
      }
    }
  };
  walk(state.tree.items, 0);
  return rows;
}

function paintTree() {
  if (state.drag) { state.treeStale = true; return; } // autosave must not pull the dragged row out from under the mouse
  const tree = $('tree');
  const active = activeTab()?.doc.path;
  const rows = visibleRows();
  if (!rows.length) {
    tree.replaceChildren(el('p', { class: 'tree-empty ms-callout ms-secondary' }, state.filter ? 'Nichts gefunden.' : 'Noch keine Notizen. Tippe einfach los.'));
    return;
  }
  const focus = state.focusPath ?? active ?? rows[0].it.path;
  tree.replaceChildren(...rows.map(({ it, depth }) => {
    const isFolder = it.type === 'folder';
    const open = isFolder && (state.expanded.has(it.path) || !!state.filter);
    const isActive = !isFolder && it.path === active;
    const name = isFolder ? it.name : it.name.replace(/\.(md|markdown)$/i, '');
    const node = el('button', {
      class: `tree-row${isActive ? ' is-active' : ''}`, role: 'treeitem', style: `--depth:${depth}`, 'data-path': it.path, 'data-type': it.type,
      'aria-level': String(depth + 1), 'aria-selected': String(isActive), 'aria-expanded': isFolder ? String(open) : undefined,
      tabIndex: it.path === focus ? 0 : -1, draggable: true, title: it.path,
      onclick: () => { state.focusPath = it.path; if (isFolder) toggleFolder(it.path); else openNote(it.path); },
      oncontextmenu: (e) => { e.preventDefault(); itemMenu(it, { x: e.clientX, y: e.clientY }); },
      onkeydown: (e) => treeKey(e, it),
      ondragstart: (e) => { state.drag = it.path; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', it.name); e.stopPropagation(); },
      ondragend: clearDrop,
      ondragover: (e) => treeDragOver(e, it, node),
      ondragleave: () => node.classList.remove('drop-before', 'drop-after', 'drop-into'),
      ondrop: (e) => treeDrop(e, it, node),
    },
    el('span', { class: 'tree-chev', html: isFolder ? icon(open ? 'chevronDown' : 'chevronRight') : '' }),
    el('span', { class: 'tree-glyph', html: icon(isFolder ? 'folder' : /\.(md|markdown|txt)$/i.test(it.name) ? 'file' : 'fileCode') }),
    el('span', { class: 'tree-name' }, name));
    return node;
  }));
}

function toggleFolder(path, open = !state.expanded.has(path)) {
  if (open) state.expanded.add(path);
  else state.expanded.delete(path);
  paintTree();
  saveSessionSoon();
}

function treeKey(e, it) {
  const nodes = [...$('tree').querySelectorAll('.tree-row')];
  const i = nodes.indexOf(e.currentTarget);
  const go = (n) => { if (n) { e.preventDefault(); state.focusPath = n.dataset.path; nodes.forEach((x) => { x.tabIndex = x === n ? 0 : -1; }); n.focus(); } };
  if (e.key === 'ArrowDown') go(nodes[i + 1]);
  else if (e.key === 'ArrowUp') go(nodes[i - 1]);
  else if (e.key === 'ArrowRight' && it.type === 'folder') { e.preventDefault(); if (!state.expanded.has(it.path)) toggleFolder(it.path, true); else go(nodes[i + 1]); $('tree').querySelector(`[data-path="${CSS.escape(it.path)}"]`)?.focus(); }
  else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    if (it.type === 'folder' && state.expanded.has(it.path)) { toggleFolder(it.path, false); $('tree').querySelector(`[data-path="${CSS.escape(it.path)}"]`)?.focus(); }
    else go(nodes.find((n) => n.dataset.path === parentOf(it.path)));
  } else if (e.key === 'F2') { e.preventDefault(); renameItem(it.path, it.name); }
  else if (e.key === 'Delete') { e.preventDefault(); trashItem(it); }
  else if (e.key === 'ContextMenu') { e.preventDefault(); itemMenu(it, e.currentTarget); }
}

function clearDrop() {
  state.drag = null;
  document.querySelectorAll('.drop-before, .drop-after, .drop-into, .drop-root').forEach((n) => n.classList.remove('drop-before', 'drop-after', 'drop-into', 'drop-root'));
  if (state.treeStale) { state.treeStale = false; paintTree(); }
}

function dropZone(e, it, node) {
  const r = node.getBoundingClientRect();
  const y = (e.clientY - r.top) / r.height;
  if (it.type === 'folder') return y < 0.25 ? 'before' : y > 0.75 ? 'after' : 'into';
  return y < 0.5 ? 'before' : 'after';
}

function treeDragOver(e, it, node) {
  if (!state.drag || state.drag === it.path || it.path.startsWith(`${state.drag}/`)) return;
  e.preventDefault();
  e.stopPropagation();
  node.classList.remove('drop-before', 'drop-after', 'drop-into');
  node.classList.add(`drop-${dropZone(e, it, node)}`);
}

async function treeDrop(e, it, node) {
  const from = state.drag;
  if (!from || from === it.path || it.path.startsWith(`${from}/`)) return;
  e.preventDefault();
  e.stopPropagation();
  const zone = dropZone(e, it, node);
  clearDrop();
  try {
    if (zone === 'into') {
      await api.move(from, it.path);
      state.expanded.add(it.path);
    } else {
      const folder = parentOf(it.path);
      const moved = parentOf(from) === folder ? from : await api.move(from, folder);
      const siblings = (await api.tree()).items;
      const list = (folder ? flat(siblings).find((x) => x.path === folder)?.children ?? [] : siblings).map((x) => x.name);
      const name = moved.slice(moved.lastIndexOf('/') + 1);
      const without = list.filter((n) => n !== name);
      without.splice(without.indexOf(it.name) + (zone === 'after' ? 1 : 0), 0, name);
      await api.setOrder(folder, without);
    }
    refreshTree();
  } catch (err) { failed(err); }
}

function itemMenu(it, at) {
  const common = [
    { label: 'Umbenennen …', run: () => renameItem(it.path, it.name) },
    { label: 'Verschieben nach …', run: () => moveItem(it) },
    { label: 'Im Dateimanager zeigen', run: () => api.reveal(it.path) },
  ];
  const del = [{ separator: true }, { label: 'In den Papierkorb legen', danger: true, run: () => trashItem(it) }];
  if (it.type === 'folder') {
    menu(at, [
      { label: 'Neue Notiz …', run: () => createNoteIn(it.path) },
      { label: 'Neuer Ordner …', run: () => createFolderIn(it.path) },
      { separator: true }, ...common, ...del,
    ]);
  } else {
    menu(at, [
      { label: 'Öffnen', run: () => openNote(it.path) }, { separator: true }, ...common,
      { label: 'Verlauf anzeigen …', run: () => showHistory({ path: it.path }, it.name) }, ...del,
    ]);
  }
}

async function renameItem(path, name) {
  const next = await promptDialog({ title: 'Umbenennen', value: name, action: 'Umbenennen' });
  if (!next) return;
  try { await api.move(path, parentOf(path), next); refreshTree(); } catch (e) { failed(e); }
}

function moveItem(it) {
  const folders = [{ path: '', label: 'Oberste Ebene' }, ...flat(state.tree.items).filter((x) => x.type === 'folder').map((x) => ({ path: x.path, label: x.path }))]
    .filter((f) => f.path !== it.path && !f.path.startsWith(`${it.path}/`) && f.path !== parentOf(it.path));
  pick({
    title: `„${it.name}“ verschieben nach …`,
    items: folders.map((f) => ({ label: f.label, run: async () => { try { await api.move(it.path, f.path); refreshTree(); } catch (e) { failed(e); } } })),
  });
}

async function trashItem(it) {
  try {
    await flushAll();
    await api.trash(it.path);
    refreshTree();
  } catch (e) { failed(e); }
}

async function createFolderIn(parent) {
  const name = await promptDialog({ title: 'Neuer Ordner', placeholder: 'Name', action: 'Anlegen' });
  if (!name) return;
  try {
    const rel = await api.createFolder(parent, name);
    if (parent) state.expanded.add(parent);
    state.expanded.add(rel);
    refreshTree();
  } catch (e) { failed(e); }
}

async function createNoteIn(folder) {
  const name = await promptDialog({ title: 'Neue Notiz', placeholder: 'Name', action: 'Anlegen' });
  if (!name) return;
  try {
    const rel = await api.createNote(folder, name);
    state.expanded.add(folder);
    await refreshTree();
    await openNote(rel);
  } catch (e) { failed(e); }
}

// ---------------------------------------------------------------- JSON and other text tools

function jsonTool(fn) {
  const tab = activeTab();
  if (!tab) return;
  const indent = { 2: '  ', 4: '    ', tab: '\t' }[state.settings.jsonIndent] ?? '  ';
  try {
    tab.editor.transform((s) => fn(s, indent));
    send(tab);
  } catch (e) {
    banner({ kind: 'warning', text: e.message });
    if (e instanceof JsonError && e.line && tab.editor.goTo) tab.editor.goTo(e.line, e.column);
  }
}

const inCode = (fn) => () => {
  const tab = activeTab();
  if (tab?.editor.kind === 'code') fn(tab.editor);
  else banner({ kind: 'info', text: 'Das geht in Code-Dateien und in der Quelltextansicht (Strg+/).' });
};

/** What opens something new: the menu on the plus button, and the top of the command list. */
const openCommands = () => [
  { label: 'Neuer Tab', hint: 'Strg+T', run: () => newTab() },
  { label: 'Neue JSON-Datei', run: () => newTab({ ext: '.json' }) },
  { label: 'Datei öffnen …', hint: 'Strg+O', run: openFiles },
  { label: 'Notiz öffnen …', hint: 'Strg+P', run: quickOpen },
  { label: 'Geschlossenen Tab zurückholen', hint: 'Strg+Umschalt+T', run: reopenClosed, disabled: !state.closed.length },
];

const showCommands = () => pick({ title: 'Befehl …', items: commands() });

function commands() {
  const tab = activeTab();
  const md = tab && isMd(tab.doc);
  return [
    ...openCommands(),
    { label: 'In allen Notizen suchen …', hint: 'Strg+Umschalt+F', run: showSearch },
    { label: 'Suchen und Ersetzen', hint: 'Strg+F', run: () => tab?.editor.find() },
    { label: 'JSON formatieren (Pretty Print)', hint: 'Strg+Alt+J', run: () => jsonTool(prettyJson) },
    { label: 'JSON komprimieren (Minify)', hint: 'Strg+Alt+Umschalt+J', run: () => jsonTool((s) => minifyJson(s)) },
    ...(md ? [{ label: tab.mode === 'rich' ? 'Quelltext anzeigen' : 'Live-Ansicht anzeigen', hint: 'Strg+/', run: () => switchMode(tab, tab.mode === 'rich' ? 'code' : 'rich') }] : []),
    { label: 'Zeilen sortieren (aufsteigend)', run: inCode((e) => e.changeLines(lineCommands.sortAsc)) },
    { label: 'Zeilen sortieren (absteigend)', run: inCode((e) => e.changeLines(lineCommands.sortDesc)) },
    { label: 'Doppelte Zeilen entfernen', run: inCode((e) => e.changeLines(lineCommands.unique)) },
    { label: 'Leerzeilen entfernen', run: inCode((e) => e.changeLines(lineCommands.dropEmpty)) },
    { label: 'Leerzeichen am Zeilenende entfernen', run: inCode((e) => e.changeLines(lineCommands.trimEnd)) },
    { label: 'GROSSBUCHSTABEN', run: inCode((e) => e.transformCase((s) => s.toUpperCase())) },
    { label: 'kleinbuchstaben', run: inCode((e) => e.transformCase((s) => s.toLowerCase())) },
    { label: 'Verlauf anzeigen …', run: () => tab && showHistory({ id: tab.id }, displayName(tab)) },
    { label: 'Papierkorb öffnen …', run: showTrash },
    { label: 'Zeilenumbruch umschalten', run: () => setSetting('wrap', !state.settings.wrap) },
    { label: 'Einstellungen …', hint: 'Strg+,', run: showSettings },
  ];
}

function quickOpen() {
  pick({
    title: 'Notiz öffnen …',
    items: flat(state.tree.items).filter((x) => x.type === 'file').map((x) => ({ label: x.path, run: () => openNote(x.path) })),
  });
}

async function openFiles() {
  try { for (const doc of await api.openFile()) show(doc); } catch (e) { failed(e); }
}

async function reopenClosed() {
  const path = state.closed.pop();
  if (path) await openNote(path);
}

// ---------------------------------------------------------------- sheets

async function showSearch() {
  const { body, close } = sheet('In allen Notizen suchen', { wide: true });
  const query = el('input', { class: 'ms-field wide', type: 'search', placeholder: 'Suchbegriff', 'aria-label': 'Suchbegriff' });
  const regex = el('input', { type: 'checkbox', class: 'ms-checkbox' });
  const cased = el('input', { type: 'checkbox', class: 'ms-checkbox' });
  const results = el('div', { class: 'search-results', role: 'list' });
  const run = async () => {
    if (!query.value) { results.replaceChildren(); return; }
    results.replaceChildren(el('p', { class: 'ms-callout ms-secondary' }, 'Sucht …'));
    try {
      const hits = await api.search({ query: query.value, regex: regex.checked, caseSensitive: cased.checked });
      if (!hits.length) { results.replaceChildren(el('p', { class: 'ms-callout ms-secondary' }, 'Kein Treffer.')); return; }
      results.replaceChildren(...hits.map((h) => el('button', {
        class: 'search-hit', role: 'listitem',
        onclick: () => {
          const q = query.value;
          close();
          openNote(h.path, (tab) => { if (tab.editor.goTo) tab.editor.goTo(h.line, h.column); else tab.editor.find(q); });
        },
      }, el('span', { class: 'ms-caption ms-secondary ms-num' }, `${h.path} · Zeile ${h.line}`), el('span', { class: 'search-text' }, h.text))));
    } catch (e) { results.replaceChildren(el('p', { class: 'ms-callout field-error' }, e.message)); }
  };
  let t;
  query.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 250); });
  for (const c of [regex, cased]) c.addEventListener('change', run);
  body.append(query, el('div', { class: 'search-options' },
    el('label', { class: 'ms-check-label ms-callout' }, regex, 'Regulärer Ausdruck'),
    el('label', { class: 'ms-check-label ms-callout' }, cased, 'Groß/klein beachten')), results);
  query.focus();
}

async function showTrash() {
  const { body } = sheet('Papierkorb');
  const paint = async () => {
    const items = await api.listTrash();
    body.replaceChildren();
    if (!items.length) { body.append(el('p', { class: 'empty ms-secondary' }, 'Der Papierkorb ist leer.')); return; }
    body.append(...section(`${items.length} ${items.length === 1 ? 'Eintrag' : 'Einträge'}`, ...items.map((it) => row({
      label: it.rel, hint: new Date(it.deletedAt).toLocaleString('de-DE'),
      end: el('button', { class: 'ms-button', onclick: async () => { try { await api.restoreTrash(it.id); paint(); refreshTree(); } catch (e) { failed(e); } } }, 'Wiederherstellen'),
    }))));
    body.append(el('div', { class: 'sheet-actions' }, el('button', {
      class: 'ms-button ms-button--destructive',
      onclick: async () => {
        const yes = await alertDialog({
          title: 'Papierkorb endgültig leeren?', text: 'Die Dateien werden von der Platte gelöscht. Frühere Versionen bleiben im Verlauf.',
          actions: [{ label: 'Abbrechen', primary: true }, { label: 'Endgültig löschen', danger: true, value: true }],
        });
        if (yes) { await api.emptyTrash(); paint(); }
      },
    }, 'Papierkorb leeren')));
  };
  await paint();
}

async function showHistory(ref, name) {
  const { body, close } = sheet(`Verlauf von ${name}`, { wide: true });
  let versions = [];
  try { versions = await api.history(ref); } catch (e) { body.append(el('p', { class: 'field-error' }, e.message)); return; }
  if (!versions.length) { body.append(el('p', { class: 'empty ms-secondary' }, 'Noch keine früheren Versionen. Sie entstehen beim Bearbeiten.')); return; }
  const preview = el('pre', { class: 'history-preview ms-scroll', tabIndex: 0, 'aria-label': 'Vorschau' });
  const restore = el('button', { class: 'ms-button ms-button--prominent' }, 'Diese Version wiederherstellen');
  let current = '';
  const list = el('div', { class: 'history-list ms-scroll', role: 'listbox', 'aria-label': 'Versionen' }, ...versions.map((v, i) => el('button', {
    class: `history-row ms-num${i === 0 ? ' is-active' : ''}`, role: 'option',
    onclick: async (e) => {
      list.querySelectorAll('.is-active').forEach((n) => n.classList.remove('is-active'));
      e.currentTarget.classList.add('is-active');
      await show(v);
    },
  }, new Date(v.date).toLocaleString('de-DE'))));
  const show = async (v) => { current = await api.readVersion(ref, v.version); preview.textContent = current; };
  restore.addEventListener('click', async () => {
    const apply = async (tab) => {
      await send(tab);
      tab.silent = true;
      tab.editor.setText(current);
      tab.silent = false;
      tab.lastSent = current;
      tab.doc.text = current;
      await api.update(tab.id, current); // the raw version, not what the editor would regenerate from it
      await api.commit(tab.id);
      close();
      banner({ kind: 'ok', text: 'Version wiederhergestellt. Der vorherige Stand bleibt im Verlauf.' });
    };
    try {
      const tab = ref.id ? state.tabs.find((t) => t.id === ref.id) : null;
      if (tab) await apply(tab);
      else await openNote(ref.path, apply);
    } catch (e) { failed(e); }
  });
  body.append(el('div', { class: 'history' }, list, preview), el('div', { class: 'sheet-actions' }, restore));
  await show(versions[0]);
}

function picker(current, options, onPick) {
  const label = () => options.find((o) => o.value === current())?.label ?? '';
  const button = el('button', { class: 'ms-popup', onclick: () => menu(button, options.map((o) => ({ label: o.label, checked: o.value === current(), run: () => { onPick(o.value); paint(); } }))) });
  const paint = () => { button.innerHTML = icon('chevrons'); button.prepend(label()); };
  paint();
  return button;
}

const switchControl = (key, label) => el('input', {
  type: 'checkbox', class: 'ms-switch', role: 'switch', 'aria-label': label, checked: !!state.settings[key],
  onchange: (e) => setSetting(key, e.target.checked),
});

async function setSetting(key, value) {
  state.settings[key] = value;
  applySettings();
  try { state.settings = await api.setSettings({ [key]: value }); } catch (e) { failed(e); }
}

function applySettings() {
  const s = state.settings;
  const html = document.documentElement;
  if (s.theme === 'auto') delete html.dataset.theme; else html.dataset.theme = s.theme;
  if (s.contrast) html.dataset.contrast = 'more'; else delete html.dataset.contrast;
  if (s.transparency) html.dataset.transparency = 'reduce'; else delete html.dataset.transparency;
  if (s.motion) html.dataset.motion = 'reduce'; else delete html.dataset.motion;
  html.style.setProperty('--ms-glass-level', s.glass);
  html.style.setProperty('--editor-size', `${s.fontSize}px`);
  html.style.setProperty('--side-w', `${s.sidebarWidth}px`);
  for (const t of state.tabs) t.editor?.setWrap(s.wrap);
  placeBrand(s.sidebarHidden);
}

/** W-1: the app's name and the sidebar button live in the sidebar, or in a capsule of their own in the title row while it is away. */
function placeBrand(hidden) {
  const brand = $('brand');
  const button = $('side-toggle');
  const focused = document.activeElement === button; // moving a node takes the focus away from it
  document.documentElement.toggleAttribute('data-side-hidden', hidden);
  $('sidebar').hidden = hidden;
  brand.classList.toggle('ms-glass', hidden);
  brand.classList.toggle('ms-glass--capsule', hidden);
  if (hidden) $('tabs').after(brand); else $('sidebar').prepend(brand);
  const label = hidden ? 'Seitenleiste einblenden' : 'Seitenleiste ausblenden';
  button.setAttribute('aria-label', label);
  button.title = label;
  if (focused) button.focus();
}

function showSettings() {
  const { body, close } = sheet('Einstellungen');
  const s = state.settings;
  const vaultValue = el('span', { class: 'path-value ms-caption ms-secondary' }, s.vault);
  const backupValue = el('span', { class: 'path-value ms-caption ms-secondary' }, s.backup ?? 'Nicht eingerichtet');
  const glass = el('input', {
    type: 'range', class: 'ms-slider', min: 0, max: 1, step: 0.01, value: s.glass, 'aria-label': 'Liquid Glass', style: `--_v:${s.glass * 100}%`,
    oninput: (e) => { e.target.style.setProperty('--_v', `${e.target.value * 100}%`); document.documentElement.style.setProperty('--ms-glass-level', e.target.value); },
    onchange: (e) => setSetting('glass', Number(e.target.value)),
  });
  const changeVault = async () => {
    const dir = await api.chooseFolder();
    if (!dir) return;
    const yes = await alertDialog({
      title: 'Notizordner wechseln?', text: `Alle Notizen werden nach ${dir} kopiert und geprüft. Der alte Ordner bleibt unverändert, gleichnamige Dateien werden nicht überschrieben.`,
      actions: [{ label: 'Abbrechen' }, { label: 'Kopieren und wechseln', primary: true, value: true }],
    });
    if (!yes) return;
    try {
      await flushAll();
      state.settings = await api.changeVault(dir);
      vaultValue.textContent = state.settings.vault;
      refreshTree();
    } catch (e) { failed(e); }
  };
  const setBackup = async (dir) => {
    try {
      state.settings = await api.setBackup(dir);
      backupValue.textContent = state.settings.backup ?? 'Nicht eingerichtet';
      if (dir) banner({ kind: 'ok', text: 'Sicherungsort eingerichtet. Notizen und Verlauf werden dorthin kopiert.' });
    } catch (e) { failed(e); }
  };
  body.append(
    ...section('Speicherort',
      row({ tile: 'folder', color: 'connection', label: 'Notizordner', hint: vaultValue, end: el('button', { class: 'ms-button', onclick: changeVault }, 'Ändern …') }),
      row({
        tile: 'history', color: 'detection', label: 'Zweiter Sicherungsort', hint: backupValue,
        end: el('span', { class: 'row-buttons' },
          el('button', { class: 'ms-button', onclick: async () => { const d = await api.chooseFolder(); if (d) setBackup(d); } }, 'Wählen …'),
          el('button', { class: 'ms-button', onclick: () => setBackup(null) }, 'Entfernen')),
      })),
    el('p', { class: 'ms-caption ms-secondary sheet-note' }, 'Der zweite Sicherungsort schützt vor einem Plattenausfall. Nimm dafür ein anderes Laufwerk oder ein NAS. Dort wird nie etwas gelöscht.'),
    ...section('Darstellung',
      row({
        tile: 'theme', color: 'appearance', label: 'Erscheinungsbild',
        end: picker(() => state.settings.theme, [{ value: 'auto', label: 'Automatisch' }, { value: 'light', label: 'Hell' }, { value: 'dark', label: 'Dunkel' }], (v) => setSetting('theme', v)),
      }),
      row({ tile: 'glass', color: 'appearance', label: 'Liquid Glass', end: el('span', { class: 'slider-labels ms-caption ms-secondary' }, 'Klar', glass, 'Getönt') }),
      row({ tile: 'contrast', color: 'appearance', label: 'Kontrast erhöhen', end: switchControl('contrast', 'Kontrast erhöhen') }),
      row({ tile: 'transparency', color: 'appearance', label: 'Transparenz reduzieren', end: switchControl('transparency', 'Transparenz reduzieren') }),
      row({ tile: 'motion', color: 'appearance', label: 'Bewegung reduzieren', end: switchControl('motion', 'Bewegung reduzieren') })),
    ...section('Editor',
      row({
        tile: 'file', color: 'controls', label: 'Schriftgröße',
        end: picker(() => state.settings.fontSize, [12, 13, 14, 15, 16, 18, 20].map((n) => ({ value: n, label: `${n} px` })), (v) => setSetting('fontSize', v)),
      }),
      row({ tile: 'file', color: 'controls', label: 'Lange Zeilen umbrechen', end: switchControl('wrap', 'Lange Zeilen umbrechen') }),
      row({
        tile: 'code', color: 'controls', label: 'Einzug für JSON',
        end: picker(() => state.settings.jsonIndent, [{ value: 2, label: '2 Leerzeichen' }, { value: 4, label: '4 Leerzeichen' }, { value: 'tab', label: 'Tabulator' }], (v) => setSetting('jsonIndent', v)),
      })),
  );
  return close;
}

// ---------------------------------------------------------------- session

let sessionTimer;
function saveSessionSoon() {
  if (!state.sessionReady) return;
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(saveSession, 800);
}

function saveSession() {
  const cursors = {};
  for (const t of state.tabs) {
    const c = t.editor?.getCursor() ?? t.cursor;
    if (c) cursors[t.id] = c;
  }
  // Only comfort lives here. If this file is lost, the journals still bring back every tab.
  return api.saveSession({
    order: state.tabs.map((t) => t.id), active: state.activeId, split: state.split, cursors, expanded: [...state.expanded],
    closed: state.closed.slice(-30), seenBackupHint: state.seenBackupHint,
  }).catch(() => {});
}

// ---------------------------------------------------------------- events

api.onEvent((e) => {
  if (e.type === 'status') {
    const tab = state.tabs.find((t) => t.id === e.id);
    if (!tab) return;
    if (e.state === 'committed' || e.state === 'recovered' || e.state === 'vault-error' || e.state === 'journal-error') setSaveState(tab, e.state, e.error);
    else if (e.state === 'durable') setSaveState(tab, 'durable');
  } else if (e.type === 'tree') refreshTreeSoon();
  else if (e.type === 'notices') pullNotices();
  else if (e.type === 'closed') dropTab(e.id);
  else if (e.type === 'meta') {
    const tab = state.tabs.find((t) => t.id === e.doc.id);
    if (!tab) return;
    const wasMd = isMd(tab.doc);
    const text = tab.doc.text;
    tab.doc = { ...e.doc, text };
    tab.editor?.setRename?.(e.doc.name);
    if (wasMd !== isMd(tab.doc)) switchMode(tab, isMd(tab.doc) ? 'rich' : 'code');
    paintTabs();
    paintTree();
    if (tab.id === state.activeId) paintStatus();
  } else if (e.type === 'reload') {
    const tab = state.tabs.find((t) => t.id === e.doc.id);
    if (!tab) return;
    tab.doc = e.doc;
    tab.lastSent = e.doc.text;
    if (tab.editor) {
      tab.silent = true;
      tab.editor.setText(e.doc.text);
      tab.silent = false;
    }
    if (tab.doc.autoTitle) tab.title = nameFromText(tab.doc.text, tab.doc.ext);
    paintTabs();
    banner({ kind: 'info', text: `„${displayName(tab)}“ wurde außerhalb geändert und neu geladen. Der vorige Stand liegt im Verlauf.` });
  } else if (e.type === 'opened') show(e.doc);
  else if (e.type === 'error') banner({ kind: 'warning', text: e.message });
  else if (e.type === 'window') {
    const html = document.documentElement;
    html.toggleAttribute('data-maximized', e.maximized);
    html.toggleAttribute('data-unfocused', !e.focused);
    $('win-max').innerHTML = icon(e.maximized ? 'restore' : 'maximize');
  } else if (e.type === 'backup-error') { state.backupError = e.error; paintSave(); }
  else if (e.type === 'backup-ok') { state.backupError = null; paintSave(); }
});

api.onFlush(async () => {
  await flushAll();
  await saveSession();
});

// ---------------------------------------------------------------- keyboard and pointer

window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (document.querySelector('#layer .overlay')) return;
  const k = e.key.toLowerCase();
  const tab = activeTab();
  const take = (fn) => { e.preventDefault(); e.stopPropagation(); fn(); };
  if (e.altKey && k === 'j') return take(() => jsonTool(e.shiftKey ? (s) => minifyJson(s) : prettyJson));
  if (e.altKey) return undefined;
  if (e.shiftKey) {
    if (k === 't') return take(reopenClosed);
    if (k === 'p') return take(showCommands);
    if (k === 'f') return take(showSearch);
    if (k === 'tab') return take(() => cycleTab(-1));
    return undefined;
  }
  if (k === 'n' || k === 't') return take(() => newTab());
  if (k === 'w') return take(() => tab && closeTab(tab.id));
  if (k === 's') return take(async () => { if (tab) { await send(tab); api.commit(tab.id).catch(() => {}); } });
  if (k === 'o') return take(openFiles);
  if (k === 'p') return take(quickOpen);
  if (k === ',') return take(showSettings);
  if (k === 'tab' || k === 'pagedown') return take(() => cycleTab(1));
  if (k === 'pageup') return take(() => cycleTab(-1));
  if ((k === 'f' || k === 'h') && tab) return take(() => tab.editor.find());
  if (k === '/' && tab && isMd(tab.doc)) return take(() => { tab.forceRich = tab.mode === 'code'; switchMode(tab, tab.mode === 'rich' ? 'code' : 'rich'); });
  return undefined;
}, true);

document.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
document.addEventListener('drop', async (e) => {
  const files = [...(e.dataTransfer?.files ?? [])];
  if (!files.length) return;
  e.preventDefault();
  for (const f of files) {
    try { show(await api.openPath(api.pathOfFile(f))); } catch (err) { failed(err); }
  }
});

function wire() {
  const iconize = (id, name) => { $(id).innerHTML = icon(name); };
  iconize('new-folder', 'folderPlus');
  iconize('new-note', 'plus');
  iconize('tab-new', 'plus');
  iconize('win-min', 'minus');
  iconize('win-max', 'maximize');
  iconize('win-close', 'close');
  iconize('side-toggle', 'sidebar');
  $('side-toggle').addEventListener('click', () => setSetting('sidebarHidden', !state.settings.sidebarHidden));
  const sideLink = (id, name, label, run) => { const b = $(id); b.innerHTML = icon(name); b.append(label); b.addEventListener('click', run); };
  sideLink('btn-search', 'search', 'In allen Notizen suchen', showSearch);
  sideLink('btn-trash', 'trash', 'Papierkorb', showTrash);
  sideLink('btn-settings', 'settings', 'Einstellungen', showSettings);

  $('new-note').addEventListener('click', () => newTab());
  $('tab-new').addEventListener('click', () => newTab());
  $('tab-new').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    menu(e.currentTarget, [...openCommands(), { separator: true }, { label: 'Alle Befehle …', run: showCommands }]);
  });
  // A mouse wheel only scrolls vertically and this list shows no scrollbar: without this, tabs that moved out of view stay out of reach.
  $('tab-list').addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    e.preventDefault();
    e.currentTarget.scrollLeft += e.deltaY;
  }, { passive: false });
  // A narrower list (window, sidebar width) must not push the active tab out of view. Scrolling with the wheel doesn't change the width, so it stays free.
  new ResizeObserver(() => $('tab-list').querySelector('.is-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })).observe($('tab-list'));
  for (const zone of $('split-drop').children) {
    zone.addEventListener('dragover', (e) => { if (state.dragTab) { e.preventDefault(); zone.classList.add('is-over'); } });
    zone.addEventListener('dragleave', () => zone.classList.remove('is-over'));
    zone.addEventListener('drop', (e) => {
      if (!state.dragTab) return;
      e.preventDefault();
      const id = state.dragTab;
      endTabDrag();
      placeBeside(id, Number(zone.dataset.side));
    });
  }
  $('new-folder').addEventListener('click', () => createFolderIn(''));
  $('filter').addEventListener('input', (e) => { state.filter = e.target.value; paintTree(); });
  $('win-min').addEventListener('click', () => api.win('minimize'));
  $('win-max').addEventListener('click', () => api.win('maximize'));
  $('win-close').addEventListener('click', () => api.win('close'));

  const tree = $('tree');
  tree.addEventListener('contextmenu', (e) => {
    if (e.target !== tree) return;
    e.preventDefault();
    menu({ x: e.clientX, y: e.clientY }, [{ label: 'Neue Notiz …', run: () => createNoteIn('') }, { label: 'Neuer Ordner …', run: () => createFolderIn('') }]);
  });
  tree.addEventListener('dragover', (e) => { if (state.drag && e.target === tree) { e.preventDefault(); tree.classList.add('drop-root'); } });
  tree.addEventListener('dragleave', () => tree.classList.remove('drop-root'));
  tree.addEventListener('drop', async (e) => {
    if (!state.drag || e.target !== tree) return;
    e.preventDefault();
    const from = state.drag;
    clearDrop();
    try { await api.move(from, ''); refreshTree(); } catch (err) { failed(err); }
  });

  $('st-mode').addEventListener('click', () => {
    const tab = activeTab();
    if (tab && isMd(tab.doc)) { tab.forceRich = tab.mode === 'code'; switchMode(tab, tab.mode === 'rich' ? 'code' : 'rich'); }
  });
  $('st-enc').addEventListener('click', (e) => {
    const d = activeTab()?.doc;
    if (!d) return;
    menu(e.currentTarget, [
      ['UTF-8', 'utf-8', false], ['UTF-8 mit BOM', 'utf-8', true], ['UTF-16 LE', 'utf-16le', true], ['UTF-16 BE', 'utf-16be', true], ['Windows-1252', 'windows-1252', false],
    ].map(([label, encoding, bom]) => ({ label, checked: d.encoding === encoding && d.bom === bom, run: () => changeFormat({ encoding, bom }) })));
  });
  $('st-eol').addEventListener('click', (e) => {
    const d = activeTab()?.doc;
    if (!d) return;
    menu(e.currentTarget, [['LF (Linux)', '\n'], ['CRLF (Windows)', '\r\n'], ['CR (altes macOS)', '\r']].map(([label, eol]) => ({ label, checked: d.eol === eol, run: () => changeFormat({ eol }) })));
  });

  // Sidebar width: drag, or arrow keys for the keyboard.
  const handle = $('side-resize');
  const setWidth = (w) => {
    const width = Math.round(Math.max(180, Math.min(w, 520)));
    state.settings.sidebarWidth = width;
    document.documentElement.style.setProperty('--side-w', `${width}px`);
  };
  handle.addEventListener('pointerdown', (e) => {
    handle.setPointerCapture(e.pointerId);
    const left = $('sidebar').getBoundingClientRect().left;
    const move = (ev) => setWidth(ev.clientX - left);
    const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); setSetting('sidebarWidth', state.settings.sidebarWidth); };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
  handle.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setWidth(state.settings.sidebarWidth + (e.key === 'ArrowRight' ? 16 : -16));
    setSetting('sidebarWidth', state.settings.sidebarWidth);
  });
}

// ---------------------------------------------------------------- start

async function start() {
  wire();
  state.settings = await api.settings();
  applySettings();
  $('version').textContent = `MyNotes ${await api.version()}`;
  const session = await api.session();
  state.expanded = new Set(session?.expanded ?? ['Eingang']);
  state.closed = session?.closed ?? [];
  state.seenBackupHint = !!session?.seenBackupHint;

  const docs = await api.docs();
  const order = new Map((session?.order ?? []).map((id, i) => [id, i]));
  docs.sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
  for (const d of docs) {
    const tab = addTab(d);
    tab.cursor = session?.cursors?.[d.id] ?? null;
  }
  await refreshTree();
  const split = session?.split;
  if (split?.length === 2 && split.includes(session.active) && split.every((id) => state.tabs.some((t) => t.id === id))) state.split = split;
  if (!state.tabs.length) await newTab();
  else activate(state.tabs.some((t) => t.id === session?.active) ? session.active : state.tabs[0].id);
  state.sessionReady = true;
  await pullNotices();
  if (!state.settings.backup && !state.seenBackupHint) {
    state.seenBackupHint = true;
    banner({
      kind: 'info', text: 'Richte einen zweiten Sicherungsort ein, damit deine Notizen auch einen Plattenausfall überstehen.',
      action: { label: 'Einstellungen öffnen', run: showSettings },
    });
    saveSessionSoon();
  }
}

start().catch((e) => banner({ kind: 'error', sticky: true, text: `Start fehlgeschlagen: ${e.message}` }));
