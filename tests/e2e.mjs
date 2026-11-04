// The real app in a real window: type, kill the process hard, start again, and everything has to be there.
// Screenshots land in the folder given by MYNOTES_SHOTS, if set.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mynotes-e2e-'));
const vault = path.join(root, 'vault');
const data = path.join(root, 'data');
await fs.mkdir(vault);
const shots = process.env.MYNOTES_SHOTS;
if (shots) await fs.mkdir(shots, { recursive: true });

const env = { ...process.env, MYNOTES_DATA: data, MYNOTES_VAULT: vault, MYNOTES_INACTIVE: '1' };
delete env.ELECTRON_RUN_AS_NODE; // set by VS Code's extension host; Electron would start as plain Node

async function launch() {
  const exe = process.env.MYNOTES_EXE; // the packaged app instead of the source tree
  const args = exe ? [] : ['.'];
  if (process.platform === 'linux' && (process.env.CI || process.getuid?.() === 0)) args.push('--no-sandbox');
  const app = await electron.launch({ args, env, timeout: 30_000, ...(exe ? { executablePath: exe } : {}) });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => { console.error('page error:', e.message); errors.push(e.message); });
  page.on('console', (m) => { if (m.type() === 'error') console.error('console error:', m.text()); });
  try {
    await page.waitForSelector('.tab', { timeout: 15_000 });
  } catch (e) {
    console.error('window never got a tab:', page.url(), '\n', (await page.content()).slice(0, 800));
    await shot(page, 'no-tab').catch(() => {});
    await app.close().catch(() => {});
    throw e;
  }
  return { app, page };
}

const errors = [];
const step = (name) => console.log(`  ok ${name}`);
const shot = async (page, name) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
const read = (rel) => fs.readFile(path.join(vault, ...rel.split('/')), 'utf8');
const until = async (fn, what, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch (e) { if (Date.now() > end) throw e; }
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};
const saved = (page) => page.waitForFunction(() => document.querySelector('#st-save')?.dataset.state === 'durable' || document.querySelector('#st-save')?.dataset.state === 'committed');
const kill = async (app) => {
  const pid = await app.evaluate(() => process.pid); // app.process() can be a launcher stub on Windows, the app itself lives on
  process.kill(pid, 'SIGKILL');
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 'process gone');
  await new Promise((r) => setTimeout(r, 300));
};
const tabNames = (page) => page.$$eval('.tab-name', (n) => n.map((x) => x.textContent));
/** Ctrl+T, then wait for the new tab itself: its title alone can also be the title of the tab before. */
const newTab = async (page) => {
  const before = await page.$eval('.pane:not([hidden])', (n) => n.dataset.doc);
  await page.keyboard.press('Control+t');
  await page.waitForFunction((id) => document.querySelector('.pane:not([hidden])')?.dataset.doc !== id, before);
};

let { app, page } = await launch();
try {
  // ---------- title bar: across the whole window without a grip; #app-name must follow #tabs in the DOM, or a scrolled tab list takes its drag area away
  const bar = await page.evaluate(() => {
    const r = document.querySelector('#topbar').getBoundingClientRect();
    const [tabs, name] = ['#tabs', '#app-name'].map((s) => document.querySelector(s));
    return { left: r.left, right: innerWidth - r.right, grip: !!document.querySelector('#win-grip'), nameAfterTabs: !!(tabs.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING) };
  });
  assert.deepEqual(bar, { left: bar.right, right: bar.left, grip: false, nameAfterTabs: true });
  step('title bar across the window');

  // ---------- the plus button: a click opens a tab at once, a right click offers the rest; the three dots are gone
  assert.equal(await page.$('#win-menu'), null);
  await page.click('#tab-new', { button: 'right' });
  await page.waitForSelector('.float-menu');
  const offered = await page.$$eval('.float-menu button', (n) => n.map((x) => x.textContent));
  assert.deepEqual(offered, ['Neuer Tab', 'Neue JSON-Datei', 'Datei öffnen …', 'Notiz öffnen …', 'Geschlossenen Tab zurückholen', 'Alle Befehle …']);
  await shot(page, '0-plus-menu');
  await page.click('.float-menu button:last-child');
  await page.waitForSelector('.float-menu', { state: 'detached' });
  await page.keyboard.press('Escape');
  await until(async () => !(await page.$('#layer .overlay')), 'command list closed');
  step('plus button: menu on right click, command list behind it');

  // ---------- WYSIWYG: typing Markdown shortcuts formats live, the file holds Markdown
  await page.click('.prose');
  await page.keyboard.type('# Projektplan\nErster **fetter** Absatz\n');
  await page.keyboard.type('- [ ] Aufgabe eins\n');
  await until(async () => (await page.$$eval('.prose h1', (n) => n.length)) === 1, 'heading rendered');
  await until(async () => (await page.$$eval('.prose strong', (n) => n.length)) === 1, 'bold rendered');
  await until(async () => (await page.$$eval('.prose ul[data-type="taskList"]', (n) => n.length)) === 1, 'task list rendered');
  await shot(page, '1-wysiwyg');
  await saved(page);
  await until(async () => (await read('Eingang/Projektplan.md')).includes('# Projektplan'), 'note in folder');
  const md = await read('Eingang/Projektplan.md');
  assert.match(md, /^# Projektplan\n/);
  assert.match(md, /\*\*fetter\*\*/);
  assert.match(md, /- \[ \] Aufgabe eins/);
  assert.deepEqual(await tabNames(page), ['Projektplan']);
  step('live Markdown, file holds Markdown, title follows the first line');

  // ---------- the promise: kill hard right after typing, nothing is lost
  await page.click('.prose');
  await page.keyboard.press('Control+End');
  await page.keyboard.type('Unmittelbar vor dem Absturz');
  await page.waitForFunction(() => document.querySelector('#st-save')?.dataset.state !== 'pending');
  await new Promise((r) => setTimeout(r, 350)); // debounce plus journal ack, deliberately far below the 1.5 s commit
  await kill(app);
  ({ app, page } = await launch());
  assert.deepEqual(await tabNames(page), ['Projektplan']);
  assert.match(await page.textContent('.prose'), /Unmittelbar vor dem Absturz/);
  await until(async () => (await read('Eingang/Projektplan.md')).includes('Unmittelbar vor dem Absturz'), 'recovered text reached the folder');
  step('text typed right before a hard kill is back, in the tab and in the file');

  // ---------- JSON: paste into empty tab becomes a JSON file; pretty print keeps the data
  await page.keyboard.press('Control+t');
  await until(async () => (await tabNames(page)).length === 2, 'second tab');
  const json = '{"big":12345678901234567890,"f":1.0,"nested":{"a":[1,2,{"b":null}]}}';
  await page.evaluate((text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    document.querySelector('.pane:not([hidden]) .prose').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, json);
  await page.waitForSelector('.pane:not([hidden]) .cm-editor');
  await page.keyboard.press('Control+Alt+j');
  await until(async () => (await page.textContent('.pane:not([hidden]) .cm-content')).includes('"big": 12345678901234567890'), 'pretty printed');
  await shot(page, '2-json');
  await page.keyboard.press('Control+s');
  await until(async () => {
    const f = (await fs.readdir(path.join(vault, 'Eingang'))).find((n) => n.endsWith('.json'));
    return f && (await read(`Eingang/${f}`)).includes('"f": 1.0');
  }, 'pretty JSON on disk');
  step('JSON paste makes a .json file, pretty print keeps big numbers and 1.0');

  // ---------- invalid JSON changes nothing and says where
  await page.keyboard.press('Control+t');
  await until(async () => (await tabNames(page)).length === 3, 'third tab');
  await page.keyboard.type('kein json');
  await page.keyboard.press('Control+/');
  await page.waitForSelector('.pane:not([hidden]) .cm-editor');
  await page.keyboard.press('Control+Alt+j');
  await page.waitForSelector('.inline-msg--warning');
  assert.equal(await page.textContent('.pane:not([hidden]) .cm-content'), 'kein json');
  await page.click('.inline-msg--warning .round-btn');
  step('invalid JSON is reported and not touched');

  // ---------- close and start normally: every tab is back, no dialog
  const before = await tabNames(page);
  await app.close();
  ({ app, page } = await launch());
  assert.deepEqual(await tabNames(page), before);
  step('all tabs come back after closing without saving');

  // ---------- content the live editor would change opens as source, and the file stays untouched
  const raw = 'Text mit <span style="color:red">HTML</span>\n\n<div>Block</div>\n';
  await fs.writeFile(path.join(vault, 'html.md'), raw);
  await page.waitForSelector('[data-path="html.md"]');
  await page.click('[data-path="html.md"]');
  await page.waitForSelector('.pane:not([hidden]) .cm-editor');
  await until(async () => (await page.textContent('#st-mode')) === 'Quelltext', 'opened as source');
  assert.equal(await read('html.md'), raw);
  await page.click('#banner .round-btn');
  step('Markdown the live editor would change opens as source, file untouched');

  // ---------- plain Markdown round trip: opening changes nothing, formats survive
  const corpus = [
    '# Titel\n\n## Unter\n\nAbsatz mit **fett**, *kursiv*, ~~weg~~, `code` und [Link](https://example.com).\n',
    '- eins\n- zwei\n  - tief\n\n1. a\n2. b\n',
    '- [x] fertig\n- [ ] offen\n',
    '> Zitat\n\n---\n\nEnde\n',
    '```json\n{"a": 1}\n```\n',
    '| A | B |\n| --- | --- |\n| 1 | 2 |\n',
    '5 * 3 = 15 und a_b_c\n',
    '- [x] Erledigt\n- [ ] Offen\n- Normaler Punkt\n',
    '* eins\n* zwei\n',
    '- a\n  - b\n    - c\n- d\n',
    '3. a\n4. b\n',
    'Zeile eins  \nZeile zwei\n',
    'Titel\n=====\n',
    'Das ist _kursiv_ und __fett__\n',
    'A &amp; B und 5 > 3\n',
    '---\ntitle: x\n---\n\nText\n',
  ];
  for (const [i, text] of corpus.entries()) {
    const name = `korpus${i}.md`;
    await fs.writeFile(path.join(vault, name), text);
    await page.waitForSelector(`[data-path="${name}"]`);
    await page.click(`[data-path="${name}"]`);
    await until(async () => (await page.getAttribute(`[data-path="${name}"]`, 'aria-selected')) === 'true', `open ${name}`);
    assert.equal(await page.textContent('#st-mode'), 'Live', `${name} must open live`);
    assert.equal(await read(name), text, `${name} changed by opening`);
  }
  await shot(page, '3-table');
  step(`${corpus.length} Markdown samples open live and unchanged`);

  // ---------- blank lines come back after a reload, and the file does not grow with every save
  await newTab(page);
  await page.keyboard.type('Zeile eins\n\n\nZeile zwei\n\n\n');
  const paragraphs = () => page.$$eval('.pane:not([hidden]) .prose > p', (n) => n.map((p) => p.textContent));
  const typed = (await paragraphs()).slice(0, 4);
  assert.deepEqual(typed, ['Zeile eins', '', '', 'Zeile zwei']);
  await until(async () => (await read('Eingang/Zeile eins.md').catch(() => '')).includes('Zeile zwei'), 'blank line note on disk');
  await page.keyboard.press('Control+/');
  await page.waitForSelector('.pane:not([hidden]) .cm-editor');
  await page.keyboard.press('Control+/');
  await page.waitForSelector('.pane:not([hidden]) .prose');
  assert.deepEqual(await paragraphs(), typed, 'blank lines survive a reload of the note');
  const firstSave = await read('Eingang/Zeile eins.md');
  assert.ok(!firstSave.trimEnd().endsWith('&nbsp;'), `blanks at the end of the file: ${JSON.stringify(firstSave)}`);
  await page.click('.pane:not([hidden]) .prose p:first-child');
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('x');
  await page.keyboard.press('Backspace');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await paragraphs()).length, typed.length, 'editing does not add blank lines');
  step('blank lines survive reloading and do not accumulate');

  // ---------- typing without a pause still reaches the journal while it happens
  await newTab(page);
  const docId = await page.$eval('.pane:not([hidden])', (n) => n.dataset.doc);
  const typing = page.keyboard.type('Ohne Pause getippt und trotzdem laufend gesichert', { delay: 40 });
  await new Promise((r) => setTimeout(r, 900));
  const midway = (await fs.readFile(path.join(data, 'journal', `${docId}.log`), 'utf8')).split('\n').filter((l) => l.includes('"t":"d"')).length;
  await typing;
  assert.ok(midway >= 2, `only ${midway} journal records after 900 ms of steady typing`); // a restarted timer would give 0
  step(`steady typing reaches the journal while it happens (${midway} records in 900 ms)`);

  // ---------- find and replace in the live editor
  await page.keyboard.press('Control+f');
  const findBar = '.pane:not([hidden]) .find-bar';
  await page.waitForSelector(`${findBar}:not([hidden])`);
  await page.keyboard.type('getippt');
  await page.waitForSelector('.pane:not([hidden]) .find-hit--on');
  await page.fill(`${findBar} input[aria-label="Ersetzen"]`, 'geschrieben');
  await page.click(`${findBar} >> text=Alle ersetzen`);
  await until(async () => (await page.textContent('.pane:not([hidden]) .prose')).includes('Ohne Pause geschrieben'), 'replaced');
  await page.keyboard.press('Escape');
  step('find and replace in the live editor');

  // ---------- a pasted image lands in the notes folder, shows up and stays in the Markdown
  await page.click('.pane:not([hidden]) .prose');
  await page.keyboard.press('Control+End');
  await page.evaluate(async () => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 8, height: 8 });
    canvas.getContext('2d').fillRect(0, 0, 8, 8);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    const data = new DataTransfer();
    data.items.add(new File([blob], 'punkt.png', { type: 'image/png' }));
    document.querySelector('.pane:not([hidden]) .prose').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await page.waitForSelector('.pane:not([hidden]) .prose img');
  await page.waitForFunction(() => document.querySelector('.pane:not([hidden]) .prose img').naturalWidth === 8);
  await page.keyboard.press('Control+s');
  await until(async () => (await read('Eingang/Ohne Pause geschrieben und trotzdem.md').catch(() => '')).includes('.mynotes/assets/'), 'image in the Markdown');
  assert.equal((await fs.readdir(path.join(vault, '.mynotes', 'assets'))).length, 1);
  assert.equal(await page.$eval('.pane:not([hidden]) .prose-host', (n) => n.classList.contains('is-empty')), false, 'placeholder over a note with content');
  step('pasted image is stored, displayed and kept in the Markdown');

  // ---------- code editor: Notepad++ keys and several cursors
  await newTab(page);
  await page.keyboard.press('Control+/');
  await page.waitForSelector('.pane:not([hidden]) .cm-editor');
  await page.keyboard.type('alpha');
  await page.keyboard.press('Control+d');
  await until(async () => (await page.$$eval('.pane:not([hidden]) .cm-line', (n) => n.map((l) => l.textContent))).join() === 'alpha,alpha', 'line duplicated');
  await page.click('.pane:not([hidden]) .cm-line:first-child', { modifiers: ['Control'] });
  await until(async () => (await page.textContent('#st-pos')).includes('2 Cursor'), 'second cursor');
  await page.keyboard.press('Escape');
  step('Ctrl+D duplicates a line, Ctrl+click adds a cursor');

  // ---------- slash menu and floating toolbar
  await newTab(page);
  await page.keyboard.type('Plan fürs Team\n/Tabe');
  await page.waitForSelector('.slash-menu:not([hidden])');
  await shot(page, '9-slash');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.pane:not([hidden]) .prose table');
  await page.keyboard.type('Kopf');
  await shot(page, '10-table');
  await until(async () => (await read('Eingang/Plan fürs Team.md').catch(() => '')).includes('Kopf'), 'table on disk');
  assert.match(await read('Eingang/Plan fürs Team.md'), /\| Kopf/);
  await page.keyboard.press('Control+End');
  await page.click('.pane:not([hidden]) .prose h1, .pane:not([hidden]) .prose p', { clickCount: 3 });
  await page.waitForSelector('.toolbar:not([hidden])');
  await page.click('.toolbar:not([hidden]) [aria-label="Fett"]');
  await until(async () => (await read('Eingang/Plan fürs Team.md')).includes('**Plan fürs Team**'), 'bold from the toolbar');
  step('slash menu inserts a table, the toolbar formats the selection');

  // ---------- folders: create, drag a note in, rename; the file follows and the open tab with it
  await page.click('#new-folder');
  await page.keyboard.type('Projekte');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-path="Projekte"]');
  await page.dragAndDrop('[data-path="Eingang/Plan fürs Team.md"]', '[data-path="Projekte"]');
  await until(async () => read('Projekte/Plan fürs Team.md').catch(() => false), 'dragged into the folder');
  await page.waitForSelector('[data-path="Projekte/Plan fürs Team.md"]');
  await page.focus('[data-path="Projekte/Plan fürs Team.md"]');
  await page.keyboard.press('F2');
  await page.keyboard.type('Teamplan');
  await page.keyboard.press('Enter');
  await until(async () => read('Projekte/Teamplan.md').catch(() => false), 'renamed');
  await until(async () => (await page.textContent('.tab.is-active .tab-name')) === 'Teamplan', 'tab follows');
  await page.click('.pane:not([hidden]) .prose');
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' Nachtrag');
  await until(async () => (await read('Projekte/Teamplan.md')).includes('Nachtrag'), 'edit after the move lands in the moved file');
  await shot(page, '11-tree');
  step('folder, drag and drop, rename: the note and its open tab follow');

  // ---------- history: an old version comes back, the current one stays in the history
  await page.click('[data-path="Projekte/Teamplan.md"]', { button: 'right' });
  await page.click('text=Verlauf anzeigen');
  await page.waitForSelector('.history-row');
  await page.click('.history-row:last-child');
  await until(async () => !(await page.textContent('.history-preview')).includes('Nachtrag'), 'old version shown');
  await new Promise((r) => setTimeout(r, 400));
  await shot(page, '12-history');
  await page.click('text=Diese Version wiederherstellen');
  await until(async () => !(await read('Projekte/Teamplan.md')).includes('Nachtrag'), 'old version restored');
  step('history restores an old version');

  // ---------- a crashed window comes back with everything
  const tabsBefore = await tabNames(page);
  await page.click('.pane:not([hidden]) .prose');
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' Vor dem Fensterabsturz');
  await page.waitForFunction(() => ['durable', 'committed'].includes(document.querySelector('#st-save')?.dataset.state));
  await new Promise((r) => setTimeout(r, 350));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
  // Playwright gives up on a page once it crashed, so ask the main process what the reloaded window shows.
  const inWindow = (js) => app.evaluate(({ BrowserWindow }, code) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(code), js);
  await until(async () => (await inWindow("document.querySelectorAll('.tab').length").catch(() => 0)) === tabsBefore.length, 'window came back', 15_000);
  await until(async () => (await inWindow("document.querySelector('.pane:not([hidden]) .prose')?.textContent ?? ''")).includes('Vor dem Fensterabsturz'), 'text is back');
  step('a crashed window reloads with all tabs and the last text');
  await app.close();
  ({ app, page } = await launch());

  // ---------- keyboard: closing a tab, bringing it back, without touching the window
  const count = (await tabNames(page)).length;
  await page.keyboard.press('Control+w');
  await until(async () => (await tabNames(page)).length === count - 1, 'tab closed');
  await page.keyboard.press('Control+Shift+t');
  await until(async () => (await tabNames(page)).length === count, 'tab reopened');
  assert.equal(await page.textContent('.tab.is-active .tab-name'), 'Teamplan');
  step('Ctrl+W and Ctrl+Shift+T');

  // ---------- many tabs: the wheel reaches the first one, and a repaint from typing does not pull the list back
  const tabScroll = () => page.$eval('#tab-list', (n) => n.scrollLeft);
  const tabsBox = await page.locator('#tab-list').boundingBox();
  await page.mouse.move(tabsBox.x + tabsBox.width / 2, tabsBox.y + tabsBox.height / 2);
  await newTab(page);
  await page.keyboard.type('Neu');
  assert.ok((await tabScroll()) > 0, 'the tabs should not fit, or this proves nothing');
  await page.mouse.wheel(0, -100000);
  await until(async () => (await tabScroll()) === 0, 'wheel reached the first tab');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(await tabScroll(), 0);
  await page.keyboard.press('Control+w');
  await until(async () => (await tabNames(page)).length === count, 'tab closed');
  step('the wheel reaches the first tab and the list stays there');

  // ---------- trash and restore
  await page.click('[data-path="korpus0.md"]', { button: 'right' });
  await page.click('text=In den Papierkorb legen');
  await until(async () => !(await fs.readdir(vault)).includes('korpus0.md'), 'moved to trash');
  await page.click('#btn-trash');
  await page.click('text=Wiederherstellen');
  await until(async () => (await fs.readdir(vault)).includes('korpus0.md'), 'restored');
  await page.keyboard.press('Escape');
  step('trash and restore');

  // ---------- full-text search
  await page.keyboard.press('Control+Shift+f');
  await page.fill('input[aria-label="Suchbegriff"]', 'Zitat');
  await page.waitForSelector('.search-hit');
  const ringRoom = await page.$eval('input[aria-label="Suchbegriff"]', (f) => f.getBoundingClientRect().top - f.closest('.sheet-body').getBoundingClientRect().top);
  assert.ok(ringRoom >= 2, `the scroller clips the focus ring (${ringRoom}px of room)`);
  await shot(page, '4-search');
  await page.keyboard.press('Escape');
  step('search across notes');

  // ---------- settings and the look in every mode
  await page.keyboard.press('Control+,');
  await page.waitForSelector('.sheet');
  await new Promise((r) => setTimeout(r, 400)); // the sheet's spring animation
  await shot(page, '5-settings');
  await page.keyboard.press('Escape');
  for (const [name, attr, value] of [['6-dark', 'theme', 'dark'], ['7-contrast', 'contrast', 'more'], ['8-transparency', 'transparency', 'reduce']]) {
    await page.evaluate(([a, v]) => { document.documentElement.dataset[a] = v; }, [attr, value]);
    await new Promise((r) => setTimeout(r, 150));
    await shot(page, name);
  }
  step('settings and display modes');

  assert.deepEqual(errors, [], 'no uncaught errors in the window');
  await app.close();
  console.log('e2e passed');
} catch (e) {
  await shot(page, 'failure').catch(() => {});
  await app.close().catch(() => {});
  console.error(e);
  process.exit(1);
}
