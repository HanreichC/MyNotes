import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkRel, frame, replay, Store } from '../src/main/store.js';

async function sandbox() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mynotes-'));
  const vault = path.join(root, 'vault');
  await fs.mkdir(vault);
  return { root, vault, dataDir: path.join(root, 'data') };
}

async function boot(s, extra = {}) {
  const events = [];
  const store = new Store({ dataDir: s.dataDir, vault: s.vault, onEvent: (e) => events.push(e), ...extra });
  await store.start();
  return { store, events };
}

/** The process died: no commit, no flush, just gone. Handles are closed so the next start can open the files. */
async function die(store) {
  for (const d of store.docs.values()) { clearTimeout(d.timer); await d.fh?.close(); d.fh = null; }
}

const read = (s, rel) => fs.readFile(path.join(s.vault, ...rel.split('/')), 'utf8');

test('replay stops at a torn or corrupt record and keeps everything before it', () => {
  const base = { t: 'base', id: 'a', text: '', seq: 0, committedSeq: 0 };
  const good = frame(base) + frame({ t: 'd', s: 1, p: 0, n: 0, i: 'hallo', c: 'x' });
  // wrong text checksum: the second record does not count
  assert.equal(replay(Buffer.from(good)).state.text, '');

  const crc = (t) => frame({ t: 'base', id: 'probe', text: t, seq: 0, committedSeq: 0 }); // only for shape
  assert.ok(crc('x').endsWith('\n'));

  const line = frame(base);
  const torn = Buffer.from(line + line.slice(0, 10));
  const r = replay(torn);
  assert.equal(r.torn, true);
  assert.equal(r.validBytes, Buffer.byteLength(line));

  const flipped = Buffer.from(line);
  flipped[20] ^= 1;
  assert.equal(replay(flipped).state, null);
});

test('text comes back after a crash before anything reached the notes folder', async () => {
  const s = await sandbox();
  const { store } = await boot(s);
  const doc = await store.create();
  await store.update(doc.id, 'Erste Zeile\nZweite Zeile äöü 😀');
  await die(store);

  const { store: again } = await boot(s);
  const [back] = again.documents();
  assert.equal(back.text, 'Erste Zeile\nZweite Zeile äöü 😀');
  await again.shutdown();
  assert.equal(await read(s, 'Eingang/Erste Zeile.md'), 'Erste Zeile\nZweite Zeile äöü 😀');
});

test('many small edits replay to the exact last state', async () => {
  const s = await sandbox();
  const { store } = await boot(s);
  const doc = await store.create();
  let text = '';
  for (let i = 0; i < 200; i++) {
    text = i % 7 === 0 ? `Anfang ${i}\n${text}` : `${text}Zeile ${i}\n`;
    await store.update(doc.id, text);
  }
  await die(store);
  const { store: again } = await boot(s);
  assert.equal(again.documents()[0].text, text);
  await again.shutdown();
});

test('a half-written last record is dropped, the rest survives', async () => {
  const s = await sandbox();
  const { store } = await boot(s);
  const doc = await store.create();
  await store.update(doc.id, 'bestätigt');
  const jpath = store.docs.get(doc.id).jpath;
  await die(store);
  await fs.appendFile(jpath, '12345678 {"t":"d","s":2,"p":0,"n":0,"i":"halb');
  const { store: again } = await boot(s);
  assert.equal(again.documents()[0].text, 'bestätigt');
  // the torn tail is gone, so the next record is readable
  await again.update(doc.id, 'bestätigt und weiter');
  await die(again);
  const { store: third } = await boot(s);
  assert.equal(third.documents()[0].text, 'bestätigt und weiter');
  await third.shutdown();
});

test('recovery: everything written, file unchanged', async () => {
  const s = await sandbox();
  const { store } = await boot(s);
  const doc = await store.create();
  await store.update(doc.id, 'Stand');
  await store.commit(doc.id);
  await die(store);
  const { store: again } = await boot(s);
  assert.deepEqual(again.takeNotices(), []);
  assert.equal(again.documents()[0].text, 'Stand');
  await again.shutdown();
});

test('recovery: pending text, file unchanged: the file gets it', async () => {
  const s = await sandbox();
  const { store } = await boot(s);
  const doc = await store.create();
  await store.update(doc.id, 'alt');
  await store.commit(doc.id);
  await store.update(doc.id, 'alt und neu');
  await die(store);
  const { store: again } = await boot(s);
  await again.shutdown();
  assert.equal(await read(s, 'Eingang/alt und neu.md'), 'alt und neu'); // the title follows the first line
});

test('recovery: pending text, file changed outside: both versions survive', async () => {
  const s = await sandbox();
  const { store } = await boot(s);
  const doc = await store.create();
  await store.update(doc.id, 'alt');
  await store.commit(doc.id);
  await store.update(doc.id, 'meine Änderung');
  await die(store);
  await fs.writeFile(path.join(s.vault, 'Eingang', 'alt.md'), 'fremde Änderung');
  const { store: again } = await boot(s);
  assert.equal(again.documents()[0].text, 'fremde Änderung');
  assert.equal(again.takeNotices()[0].kind, 'warning');
  const names = await fs.readdir(path.join(s.vault, 'Eingang'));
  const copy = names.find((n) => n.includes('Konflikt'));
  assert.ok(copy, names.join());
  assert.equal(await read(s, `Eingang/${copy}`), 'meine Änderung');
  await again.shutdown();
});

test('recovery: pending text, file gone: the file is created again', async () => {
  const s = await sandbox();
  const { store } = await boot(s);
  const doc = await store.create();
  await store.update(doc.id, 'alt');
  await store.commit(doc.id);
  await store.update(doc.id, 'noch da');
  await die(store);
  await fs.rm(path.join(s.vault, 'Eingang', 'alt.md'));
  const { store: again } = await boot(s);
  await again.shutdown();
  assert.equal(await read(s, 'Eingang/noch da.md'), 'noch da');
});

test('recovery: nothing pending, file deleted outside: last state lands in the trash', async () => {
  const s = await sandbox();
  const { store } = await boot(s);
  const doc = await store.create();
  await store.update(doc.id, 'gelöscht');
  await store.commit(doc.id);
  await die(store);
  await fs.rm(path.join(s.vault, 'Eingang', 'gelöscht.md'));
  const { store: again } = await boot(s);
  assert.equal(again.documents().length, 0);
  const [entry] = await again.listTrash();
  assert.equal(entry.rel, 'Eingang/gelöscht.md');
  assert.equal(await again.restoreTrash(entry.id), 'Eingang/gelöscht.md');
  assert.equal(await read(s, 'Eingang/gelöscht.md'), 'gelöscht');
});

test('a missing notes folder keeps the text and creates no phantom folder', async () => {
  const s = await sandbox();
  const { store, events } = await boot(s);
  const doc = await store.create();
  await store.update(doc.id, 'Text');
  await store.commit(doc.id);
  await store.update(doc.id, 'Text ohne Stick');
  await fs.rename(s.vault, `${s.vault}-weg`);
  await assert.rejects(store.commit(doc.id));
  assert.equal(await fs.access(s.vault).then(() => true, () => false), false);
  assert.ok(events.some((e) => e.state === 'vault-error'));
  await die(store);

  // restarted while the stick is out: the tab still has its text
  const { store: offline } = await boot(s);
  assert.equal(offline.documents()[0].text, 'Text ohne Stick');
  await die(offline);

  // stick is back
  await fs.rename(`${s.vault}-weg`, s.vault);
  const { store: again } = await boot(s);
  await again.shutdown();
  assert.equal(await read(s, 'Eingang/Text ohne Stick.md'), 'Text ohne Stick');
});

test('changed outside while there are unsaved edits: both survive, the tab keeps its text', async () => {
  const s = await sandbox();
  const { store, events } = await boot(s);
  const doc = await store.create();
  await store.update(doc.id, 'alt');
  await store.commit(doc.id);
  await store.update(doc.id, 'im Tab');
  await fs.writeFile(path.join(s.vault, 'Eingang', 'alt.md'), 'von außen');
  await store.checkExternal();
  await store.commit(doc.id);
  assert.equal(store.documents()[0].text, 'im Tab');
  const names = await fs.readdir(path.join(s.vault, 'Eingang'));
  const copy = names.find((n) => n.includes('extern geändert'));
  assert.equal(await read(s, `Eingang/${copy}`), 'von außen');
  assert.ok(events.some((e) => e.type === 'tree'));
  await store.shutdown();
});

test('changed outside with no edits: the tab reloads', async () => {
  const s = await sandbox();
  const { store, events } = await boot(s);
  const doc = await store.create();
  await store.update(doc.id, 'alt');
  await store.commit(doc.id);
  await fs.writeFile(path.join(s.vault, 'Eingang', 'alt.md'), 'von außen');
  await store.checkExternal();
  const reload = events.find((e) => e.type === 'reload');
  assert.equal(reload.doc.text, 'von außen');
  assert.ok((await store.history({ id: doc.id })).length >= 1);
  await store.shutdown();
});

test('opening reads and never writes; the original goes to history before the first write', async () => {
  const s = await sandbox();
  const original = '*  Liste mit   Abständen\r\n*  zweite\r\n';
  await fs.writeFile(path.join(s.vault, 'alt.md'), original);
  const { store } = await boot(s);
  const doc = await store.openNote('alt.md');
  assert.equal(doc.text, '*  Liste mit   Abständen\n*  zweite\n');
  await store.commit(doc.id);
  assert.equal(await read(s, 'alt.md'), original, 'no edit, no write');

  await store.update(doc.id, '- Liste\n- zweite\n');
  await store.commit(doc.id);
  assert.equal(await read(s, 'alt.md'), '- Liste\r\n- zweite\r\n', 'line endings are kept');
  const versions = await store.history({ path: 'alt.md' });
  assert.equal(await store.readVersion({ path: 'alt.md' }, versions.at(-1).version), '*  Liste mit   Abständen\n*  zweite\n');
  await store.shutdown();
});

test('an empty tab leaves nothing behind; a closed note keeps its text', async () => {
  const s = await sandbox();
  const { store } = await boot(s);
  const empty = await store.create();
  await store.close(empty.id);
  assert.deepEqual(await fs.readdir(s.vault), []);
  assert.equal(store.documents().length, 0);

  const doc = await store.create();
  await store.update(doc.id, 'Notiz');
  await store.close(doc.id);
  await store.queue;
  assert.equal(await read(s, 'Eingang/Notiz.md'), 'Notiz');
  assert.equal(store.documents().length, 0);
  assert.deepEqual((await fs.readdir(store.journalDir)).filter((f) => f.endsWith('.log')), []);
});

test('closing while the folder is gone keeps the journal, the note returns as a tab', async () => {
  const s = await sandbox();
  const { store } = await boot(s);
  const doc = await store.create();
  await store.update(doc.id, 'wichtig');
  await store.commit(doc.id);
  await store.update(doc.id, 'wichtig 2');
  await fs.rename(s.vault, `${s.vault}-weg`);
  await store.close(doc.id);
  assert.equal(store.docs.has(doc.id), true);
  await die(store);
  await fs.rename(`${s.vault}-weg`, s.vault);
  const { store: again } = await boot(s);
  assert.equal(again.documents()[0].text, 'wichtig 2');
  await again.shutdown();
});

test('titles follow the first line until the note is named by hand', async () => {
  const s = await sandbox();
  const { store } = await boot(s);
  const doc = await store.create();
  await store.update(doc.id, '# Projekt: Plan?\nText');
  await store.commit(doc.id);
  assert.equal(await read(s, 'Eingang/Projekt Plan.md'), '# Projekt: Plan?\nText');
  await store.update(doc.id, '# Anderer Titel\nText');
  await store.commit(doc.id);
  assert.ok(await read(s, 'Eingang/Anderer Titel.md'));

  await store.move('Eingang/Anderer Titel.md', '', 'Fest');
  await store.update(doc.id, '# Wieder anders\nText');
  await store.commit(doc.id);
  assert.ok(await read(s, 'Fest.md'));
  assert.equal(store.documents()[0].path, 'Fest.md');
  await store.shutdown();
});

test('moving never overwrites, and open notes and history follow', async () => {
  const s = await sandbox();
  await fs.writeFile(path.join(s.vault, 'a.md'), 'eins');
  await fs.mkdir(path.join(s.vault, 'Ordner'));
  await fs.writeFile(path.join(s.vault, 'Ordner', 'a.md'), 'zwei');
  const { store } = await boot(s);
  const doc = await store.openNote('a.md');
  await store.update(doc.id, 'eins geändert');
  await store.commit(doc.id);
  const dest = await store.move('a.md', 'Ordner');
  assert.equal(dest, 'Ordner/a 2.md');
  assert.equal(await read(s, 'Ordner/a.md'), 'zwei');
  assert.equal(await read(s, dest), 'eins geändert');
  assert.equal(store.documents()[0].path, dest);
  assert.ok((await store.history({ path: dest })).length >= 1);
  await assert.rejects(store.move('Ordner', 'Ordner/innen'));
  await store.update(doc.id, 'weiter');
  await store.shutdown();
  assert.equal(await read(s, dest), 'weiter');
});

test('renaming only the case of a name works', async () => {
  const s = await sandbox();
  await fs.writeFile(path.join(s.vault, 'notiz.md'), 'x');
  const { store } = await boot(s);
  assert.equal(await store.move('notiz.md', '', 'Notiz'), 'Notiz.md');
  assert.ok((await fs.readdir(s.vault)).includes('Notiz.md'));
});

test('trash moves, restores without overwriting, and open tabs are closed safely', async () => {
  const s = await sandbox();
  await fs.mkdir(path.join(s.vault, 'P'));
  await fs.writeFile(path.join(s.vault, 'P', 'n.md'), 'eins');
  const { store, events } = await boot(s);
  const doc = await store.openNote('P/n.md');
  await store.update(doc.id, 'eins und zwei');
  await store.trash('P');
  assert.equal(store.documents().length, 0);
  assert.ok(events.some((e) => e.type === 'closed' && e.id === doc.id));
  assert.deepEqual((await store.tree()).items, []);

  await fs.mkdir(path.join(s.vault, 'P'));
  const [entry] = await store.listTrash();
  assert.equal(entry.isDir, true);
  assert.equal(await store.restoreTrash(entry.id), 'P 2');
  assert.equal(await read(s, 'P 2/n.md'), 'eins und zwei');
});

test('tree hides internal files and follows the hand-made order', async () => {
  const s = await sandbox();
  for (const f of ['b.md', 'a.md', '.geheim', 'x.mynotes-tmp.md']) await fs.writeFile(path.join(s.vault, f), '');
  await fs.mkdir(path.join(s.vault, 'Z'));
  const { store } = await boot(s);
  const names = async () => (await store.tree()).items.map((i) => i.name);
  assert.deepEqual(await names(), ['Z', 'a.md', 'b.md', 'x.mynotes-tmp.md']);
  await store.setOrder('', ['b.md', 'Z']);
  assert.deepEqual(await names(), ['b.md', 'Z', 'a.md', 'x.mynotes-tmp.md']);
  await store.move('b.md', '', 'c');
  assert.deepEqual(await names(), ['c.md', 'Z', 'a.md', 'x.mynotes-tmp.md']);
});

test('paths from the window cannot leave the notes folder', async () => {
  for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:/x', 'a\\b', '', 'a//b', '.trash/x', 'a/.mynotes/order.json', 'a\0b', 5, null]) {
    assert.throws(() => checkRel(bad), undefined, String(bad));
  }
  assert.equal(checkRel('Projekte/MyCAD/Notiz.md'), 'Projekte/MyCAD/Notiz.md');
  assert.equal(checkRel('', { allowEmpty: true }), '');

  const s = await sandbox();
  const { store } = await boot(s);
  await assert.rejects(store.openNote('../geheim.txt'));
  await assert.rejects(store.trash('../vault'));
  await assert.rejects(store.history({ path: '../..' }));
  await assert.rejects(store.readVersion({ path: 'a.md' }, '../../journal/x.log'));
});

test('files that are not text are refused instead of damaged', async () => {
  const s = await sandbox();
  await fs.writeFile(path.join(s.vault, 'bild.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13]));
  const { store } = await boot(s);
  await assert.rejects(store.openNote('bild.png'), /Binärdatei/);
  assert.equal(store.documents().length, 0);
});

test('a character the encoding cannot hold changes the encoding, it is not dropped', async () => {
  const s = await sandbox();
  await fs.writeFile(path.join(s.vault, 'alt.txt'), Buffer.from([0x47, 0x72, 0xfc, 0xdf, 0x65])); // "Grüße" in cp1252 without the second e-byte
  const { store } = await boot(s);
  const doc = await store.openNote('alt.txt');
  assert.equal(doc.encoding, 'windows-1252');
  assert.equal(doc.text, 'Grüße');
  await store.update(doc.id, 'Grüße 😀');
  await store.commit(doc.id);
  assert.equal(await read(s, 'alt.txt'), 'Grüße 😀');
  assert.equal(store.documents()[0].encoding, 'utf-8');
  await store.shutdown();
});

test('history keeps versions and a backup folder mirrors notes and history', async () => {
  const s = await sandbox();
  const backup = path.join(s.root, 'backup');
  const { store } = await boot(s, { backup });
  const doc = await store.create();
  await store.update(doc.id, 'Version eins');
  await store.commit(doc.id);
  await store.update(doc.id, 'Version zwei');
  await store.commit(doc.id);
  await store.syncBackup();
  assert.equal(await fs.readFile(path.join(backup, 'notizen', 'Eingang', 'Version zwei.md'), 'utf8'), 'Version zwei');
  const versions = await store.history({ id: doc.id });
  assert.equal(await store.readVersion({ id: doc.id }, versions.at(-1).version), 'Version eins');
  await store.shutdown();
});

test('changing the notes folder copies and verifies, overwrites nothing, leaves the old one alone', async () => {
  const s = await sandbox();
  await fs.writeFile(path.join(s.vault, 'a.md'), 'alt');
  await fs.writeFile(path.join(s.vault, 'b.md'), 'nur alt');
  const next = path.join(s.root, 'neu');
  await fs.mkdir(next);
  await fs.writeFile(path.join(next, 'a.md'), 'schon im neuen');
  const { store } = await boot(s);
  const doc = await store.openNote('b.md');
  await store.update(doc.id, 'nur alt, bearbeitet');
  await store.changeVault(next);
  assert.equal(await fs.readFile(path.join(next, 'a.md'), 'utf8'), 'schon im neuen');
  assert.equal(await fs.readFile(path.join(next, 'b.md'), 'utf8'), 'nur alt, bearbeitet');
  assert.ok((await fs.readdir(next)).some((n) => n.includes('aus altem Ordner')));
  assert.equal(await read(s, 'a.md'), 'alt');
  await store.update(doc.id, 'im neuen weiter');
  await store.shutdown();
  assert.equal(await fs.readFile(path.join(next, 'b.md'), 'utf8'), 'im neuen weiter');
  await assert.rejects(store.changeVault(path.join(next, 'innen')));
});

test('a file outside the notes folder keeps its encoding and line endings, and no second tab', async () => {
  const s = await sandbox();
  const outside = path.join(s.root, 'log.txt');
  await fs.writeFile(outside, Buffer.from('﻿eins\r\nzwei\r\n', 'utf16le'));
  const { store } = await boot(s);
  const doc = await store.openExternal(outside);
  assert.equal(doc.text, 'eins\nzwei\n');
  assert.equal((await store.openExternal(outside)).id, doc.id);
  await store.update(doc.id, 'eins\nzwei\ndrei\n');
  await store.commit(doc.id);
  assert.deepEqual(await fs.readFile(outside), Buffer.from('﻿eins\r\nzwei\r\ndrei\r\n', 'utf16le'));
  assert.ok((await store.history({ id: doc.id })).length >= 1);
  await store.shutdown();
  assert.deepEqual(await fs.readdir(s.vault), []);
});

test('a journal nobody can read is kept, not deleted', async () => {
  const s = await sandbox();
  await fs.mkdir(path.join(s.dataDir, 'journal'), { recursive: true });
  await fs.writeFile(path.join(s.dataDir, 'journal', 'kaputt.log'), 'Müll\n');
  const { store } = await boot(s);
  assert.equal(store.takeNotices()[0].kind, 'warning');
  assert.equal(await fs.readFile(path.join(s.dataDir, 'journal', 'unreadable', 'kaputt.log'), 'utf8'), 'Müll\n');
});
