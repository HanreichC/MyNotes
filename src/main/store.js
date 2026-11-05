// The storage core: nothing typed may ever be lost. No Electron in here, so the tests can kill it for real.
//
// Every open document has an append-only journal on the local disk. A change is only acknowledged after its
// record is fsynced. The note in the notes folder follows atomically a moment later. See docs/PLAN.md § 3.

import { randomUUID, createHash } from 'node:crypto';
import { constants as fsc } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { crc32, gunzip as gunzipCb, gzip as gzipCb } from 'node:zlib';
import { decode, encode, nameFromText, safeName } from '../shared/text.js';

const gzip = promisify(gzipCb);
const gunzip = promisify(gunzipCb);

export const INBOX = 'Eingang';
const TRASH = '.trash';
const META = '.mynotes';
const TMP_SUFFIX = '.mynotes-tmp';
const FILE_EXT = /^\.[a-zA-Z][\w-]{0,11}$/; // "Notiz v1.2" has no extension, "notiz.json" does
const COMMIT_IDLE_MS = 1500;
const COMMIT_MAX_MS = 10_000;
const RETRY_MS = 5000;
const SNAPSHOT_EVERY_MS = 5 * 60_000;
const COMPACT_MIN_BYTES = 256 * 1024;
const BACKUP_TRIES = 10;
// ponytail: a file above this is refused rather than opened; lifting it needs a paged editor and a delta-only journal.
export const MAX_OPEN_BYTES = 128 * 1024 * 1024;

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const crcOf = (text) => crc32(text).toString(16).padStart(8, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One journal line: checksum, space, JSON. JSON never contains a raw newline. */
export function frame(rec) {
  const json = JSON.stringify(rec);
  return `${crcOf(json)} ${json}\n`;
}

/** Replays a journal up to the last intact record. A torn tail from a crash simply ends the replay. */
export function replay(buf) {
  let state = null;
  let at = 0;
  while (at < buf.length) {
    const end = buf.indexOf(10, at);
    if (end < 0) break;
    const line = buf.toString('utf8', at, end);
    if (line[8] !== ' ' || crcOf(line.slice(9)) !== line.slice(0, 8)) break;
    let rec;
    try { rec = JSON.parse(line.slice(9)); } catch { break; }
    if (rec.t === 'base') {
      state = rec;
    } else if (!state) {
      break;
    } else if (rec.t === 'd') {
      if (rec.s !== state.seq + 1) break;
      const text = state.text.slice(0, rec.p) + rec.i + state.text.slice(rec.p + rec.n);
      if (crcOf(text) !== rec.c) break;
      state.text = text;
      state.seq = rec.s;
    } else if (rec.t === 'c') {
      state.committedSeq = rec.s;
      state.diskHash = rec.h;
    } else if (rec.t === 'm') {
      Object.assign(state, rec.m);
    } else {
      break;
    }
    at = end + 1;
  }
  return { state, validBytes: at, torn: at < buf.length };
}

function delta(from, to) {
  const max = Math.min(from.length, to.length);
  let p = 0;
  while (p < max && from.charCodeAt(p) === to.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && from.charCodeAt(from.length - 1 - s) === to.charCodeAt(to.length - 1 - s)) s++;
  return { p, n: from.length - p - s, i: to.slice(p, to.length - s) };
}

async function syncDir(dir) {
  if (process.platform === 'win32') return; // Windows cannot open a directory for flushing; NTFS logs the rename itself
  const fh = await fs.open(dir, fsc.O_RDONLY);
  try { await fh.sync(); } finally { await fh.close(); }
}

/** Virus scanners and sync tools hold files open on Windows for a moment, so retry before giving up. */
async function renameRetry(from, to) {
  for (let wait = 50; ; wait *= 2) {
    try { return await fs.rename(from, to); }
    catch (e) {
      if (wait > 1600 || !['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(e.code)) throw e;
      await sleep(wait);
    }
  }
}

/** Old file stays whole until the new one is complete on disk. */
export async function atomicWrite(file, bytes, mode) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${randomUUID()}${TMP_SUFFIX}`);
  const fh = await fs.open(tmp, 'wx');
  try {
    let done = 0;
    while (done < bytes.length) done += (await fh.write(bytes, done, bytes.length - done)).bytesWritten;
    if (mode !== undefined && process.platform !== 'win32') await fh.chmod(mode);
    await fh.sync();
  } catch (e) {
    await fh.close().catch(() => {});
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
  await fh.close();
  try { await renameRetry(tmp, file); }
  catch (e) { await fs.rm(tmp, { force: true }).catch(() => {}); throw e; }
  await syncDir(dir);
}

async function readIfExists(file) {
  try { return await fs.readFile(file); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

const exists = (p) => fs.access(p).then(() => true, () => false);
const stamp = (d = new Date()) => d.toISOString().replace(/[-:.]/g, '').replace('T', '-').slice(0, 18); // yyyymmdd-HHMMSSmmm, sorts by time
const humanStamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`;
};

/** Paths from the renderer are a trust boundary: relative, no way out of the notes folder, no internal folders. */
export function checkRel(rel, { allowEmpty = false } = {}) {
  if (typeof rel !== 'string' || rel.includes('\0') || rel.includes('\\')) throw new Error('Ungültiger Pfad.');
  if (rel === '') { if (allowEmpty) return rel; throw new Error('Ungültiger Pfad.'); }
  if (path.posix.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) throw new Error('Ungültiger Pfad.');
  const parts = rel.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..' || p === TRASH || p === META || p.endsWith(TMP_SUFFIX))) throw new Error('Ungültiger Pfad.');
  return rel;
}

const splitExt = (name) => {
  const ext = path.posix.extname(name);
  return [ext ? name.slice(0, -ext.length) : name, ext];
};

export class Store {
  /** @param {{dataDir: string, vault: string, backup?: string, onEvent?: (e: object) => void}} opts */
  constructor({ dataDir, vault, backup = null, onEvent = () => {} }) {
    this.dataDir = dataDir;
    this.vault = vault;
    this.backup = backup;
    this.emit = onEvent;
    this.journalDir = path.join(dataDir, 'journal');
    this.historyDir = path.join(dataDir, 'history');
    this.docs = new Map();
    this.notices = [];
    // ponytail: one queue for everything touching the notes folder keeps moves, commits and external checks
    // from racing. A hanging network share stalls this queue but never the journal, which is what keeps typing safe.
    this.queue = Promise.resolve();
    this.backupOpsFile = path.join(dataDir, 'backup-pending.json');
    this.backupQ = [];
    this.backupSaved = '[]';
    this.backupTail = Promise.resolve();
  }

  #vault(fn) {
    const p = this.queue.then(fn);
    this.queue = p.catch(() => {});
    return p;
  }

  #journal(doc, fn) {
    const p = doc.jq.then(fn);
    doc.jq = p.catch(() => {});
    return p;
  }

  #abs(rel) { return path.join(this.vault, ...rel.split('/')); }
  #target(doc) { return doc.external ?? (doc.path ? this.#abs(doc.path) : null); }
  #name(doc) { return doc.external ? path.basename(doc.external) : doc.path ? path.posix.basename(doc.path) : `${nameFromText(doc.latest, doc.ext)}${doc.ext}`; }
  #historyOf(doc) {
    return doc.external
      ? path.join(this.historyDir, 'external', sha(doc.external).slice(0, 32))
      : path.join(this.historyDir, 'notes', ...doc.path.split('/'));
  }

  async #vaultOnline() {
    try { return (await fs.stat(this.vault)).isDirectory(); } catch { return false; }
  }

  // ---------------------------------------------------------------- lifecycle

  /** Reads back every journal. Call once before anything else. */
  async start() {
    await fs.mkdir(this.journalDir, { recursive: true });
    await fs.mkdir(this.historyDir, { recursive: true });
    try {
      this.backupQ = JSON.parse(await fs.readFile(this.backupOpsFile, 'utf8'));
      this.backupSaved = JSON.stringify(this.backupQ);
    } catch { /* nothing owed to the backup */ }
    for (const f of await fs.readdir(this.journalDir)) {
      if (!f.endsWith('.log')) continue;
      const jpath = path.join(this.journalDir, f);
      const { state, torn } = replay(await fs.readFile(jpath));
      if (!state) {
        // Never delete what we cannot read: it stays for a human to look at.
        await fs.mkdir(path.join(this.journalDir, 'unreadable'), { recursive: true });
        await fs.rename(jpath, path.join(this.journalDir, 'unreadable', f));
        this.notices.push({ kind: 'warning', text: `Ein Journal war nicht lesbar und liegt jetzt in ${path.join(this.journalDir, 'unreadable')}.` });
        continue;
      }
      const doc = this.#fromState(state, jpath);
      await this.#openJournal(doc);
      if (torn) await this.#compact(doc);
      await this.#recover(doc);
    }
  }

  #fromState(s, jpath) {
    return {
      id: s.id, path: s.path ?? null, external: s.external ?? null, ext: s.ext ?? '.md',
      encoding: s.encoding ?? 'utf-8', bom: !!s.bom, eol: s.eol ?? '\n', autoTitle: !!s.autoTitle,
      diskHash: s.diskHash ?? null, mode: s.mode, text: s.text, latest: s.text, seq: s.seq, committedSeq: s.committedSeq,
      jpath, fh: null, jsize: 0, jq: Promise.resolve(), jtorn: false, jfailed: false, flushing: null,
      timer: null, firstDirtyAt: 0, lastSnapshotAt: 0, snapHash: null, closing: false, commitError: null,
    };
  }

  #toBase(doc) {
    return {
      t: 'base', id: doc.id, path: doc.path, external: doc.external, ext: doc.ext, encoding: doc.encoding, bom: doc.bom,
      eol: doc.eol, autoTitle: doc.autoTitle, diskHash: doc.diskHash, mode: doc.mode,
      text: doc.text, seq: doc.seq, committedSeq: doc.committedSeq,
    };
  }

  async #openJournal(doc) {
    doc.fh = await fs.open(doc.jpath, 'r+');
    doc.jsize = (await doc.fh.stat()).size;
  }

  async #newDoc(fields) {
    const id = randomUUID();
    const doc = this.#fromState({ id, seq: 0, committedSeq: 0, text: '', ...fields }, path.join(this.journalDir, `${id}.log`));
    await atomicWrite(doc.jpath, Buffer.from(frame(this.#toBase(doc))));
    await this.#openJournal(doc);
    this.docs.set(id, doc);
    return doc;
  }

  async #recover(doc) {
    this.docs.set(doc.id, doc);
    const target = this.#target(doc);
    const pending = doc.seq > doc.committedSeq;
    if (!target) { if (pending) this.#schedule(doc, 0); return; }
    if (!doc.external && !(await this.#vaultOnline())) { // USB stick gone: the journal keeps everything until it returns
      if (pending) this.#schedule(doc, 0);
      return;
    }
    let disk;
    try { disk = await readIfExists(target); }
    catch { if (pending) this.#schedule(doc, 0); return; }

    const same = disk && sha(disk) === doc.diskHash;
    if (same) {
      if (pending) {
        this.#schedule(doc, 0);
        this.notices.push({ kind: 'info', text: `„${this.#name(doc)}“ wurde nach einem unerwarteten Ende wiederhergestellt.` });
      }
    } else if (!disk && !pending) {
      await this.#saveDeletedElsewhere(doc);
    } else if (!disk) {
      doc.diskHash = null;
      this.#schedule(doc, 0);
      this.notices.push({ kind: 'info', text: `„${this.#name(doc)}“ fehlte im Notizordner und wurde wiederhergestellt.` });
    } else if (pending) {
      const copy = await this.#conflictCopy(target, encode(doc.text, doc) ?? Buffer.from(doc.text), 'Konflikt');
      await this.#reloadFrom(doc, disk);
      this.notices.push({ kind: 'warning', text: `„${this.#name(doc)}“ wurde außerhalb geändert. Dein Stand liegt daneben als „${path.basename(copy)}“.` });
    } else {
      await this.#snapshot(doc, encode(doc.text, doc) ?? Buffer.from(doc.text));
      await this.#reloadFrom(doc, disk);
    }
  }

  /** A file vanished while we were not running: its last state goes to the trash, where it can be found again. */
  async #saveDeletedElsewhere(doc) {
    const bytes = encode(doc.text, doc) ?? Buffer.from(doc.text);
    await this.#snapshot(doc, bytes);
    if (doc.path) {
      const id = `${stamp()}-${randomUUID().slice(0, 6)}`;
      const dir = path.join(this.vault, TRASH, id);
      const name = path.posix.basename(doc.path);
      const meta = { rel: doc.path, name, isDir: false, deletedAt: Date.now() };
      await atomicWrite(path.join(dir, name), bytes);
      await atomicWrite(path.join(dir, 'meta.json'), Buffer.from(JSON.stringify(meta)));
      this.#toBackup({ op: 'trash', id, meta });
    }
    this.notices.push({ kind: 'warning', text: `„${this.#name(doc)}“ wurde außerhalb der App gelöscht. Der letzte Stand liegt im Papierkorb.` });
    await this.#dropJournal(doc);
  }

  async #dropJournal(doc) {
    clearTimeout(doc.timer);
    this.docs.delete(doc.id);
    await this.#journal(doc, async () => {
      await doc.fh?.close().catch(() => {});
      doc.fh = null;
      await fs.rm(doc.jpath, { force: true });
    });
  }

  /** Finishes pending writes. The journal already holds everything, so a timeout here loses nothing. */
  async shutdown() {
    const docs = [...this.docs.values()];
    for (const d of docs) clearTimeout(d.timer);
    await Promise.all(docs.map((d) => d.jq));
    await this.#vault(async () => {
      for (const d of docs) await this.#commitNow(d).catch(() => {});
    });
    await Promise.all(docs.map((d) => this.#journal(d, async () => {
      await d.fh?.close().catch(() => {});
      d.fh = null;
    })));
    await this.backupTail;
  }

  // ---------------------------------------------------------------- documents

  /** All open documents, for the window to rebuild its tabs from. */
  documents() { return [...this.docs.values()].filter((d) => !d.closing).map((d) => this.#public(d)); }

  #public(doc) {
    return {
      id: doc.id, path: doc.path, external: doc.external, ext: doc.ext, name: this.#name(doc), text: doc.latest,
      encoding: doc.encoding, bom: doc.bom, eol: doc.eol, autoTitle: doc.autoTitle,
    };
  }

  takeNotices() { const n = this.notices; this.notices = []; return n; }

  /** A new tab. It only becomes a file with its first character. */
  async create({ ext = '.md' } = {}) {
    return this.#public(await this.#newDoc({ ext, autoTitle: true }));
  }

  async openNote(rel) {
    checkRel(rel);
    for (const d of this.docs.values()) if (d.path === rel) { d.closing = false; return this.#public(d); }
    return this.#vault(() => this.#openFile({ path: rel, ext: path.posix.extname(rel) }, this.#abs(rel)));
  }

  /** Files outside the notes folder. Only the main process decides which paths land here. */
  async openExternal(abs) {
    const real = await fs.realpath(abs); // a symlink must stay a symlink when we rename over the target
    for (const d of this.docs.values()) if (d.external === real) { d.closing = false; return this.#public(d); }
    return this.#vault(() => this.#openFile({ external: real, ext: path.extname(real) }, real));
  }

  async #openFile(fields, file) {
    const st = await fs.stat(file);
    if (st.size > MAX_OPEN_BYTES) throw new Error('Die Datei ist größer als 128 MB und kann nicht geöffnet werden.');
    const bytes = await fs.readFile(file);
    const dec = decode(bytes);
    const doc = await this.#newDoc({
      ...fields, text: dec.text, encoding: dec.encoding, bom: dec.bom, eol: dec.eol,
      diskHash: sha(bytes), mode: st.mode,
    });
    return { ...this.#public(doc), mixedEol: dec.mixedEol };
  }

  /** Text from the editor. Resolves with ok: true once it is durable on disk. */
  update(id, text) {
    const doc = this.#doc(id);
    if (typeof text !== 'string') throw new Error('Ungültiger Text.');
    doc.latest = text;
    this.#schedule(doc);
    doc.flushing ??= this.#journal(doc, async () => {
      doc.flushing = null;
      return this.#persist(doc);
    });
    return doc.flushing;
  }

  #doc(id) {
    const doc = this.docs.get(id);
    if (!doc) throw new Error('Dieses Dokument ist nicht geöffnet.');
    return doc;
  }

  async #persist(doc) {
    const next = doc.latest;
    if (next !== doc.text) {
      try {
        await this.#append(doc, { t: 'd', s: doc.seq + 1, ...delta(doc.text, next), c: crcOf(next) });
      } catch (e) {
        doc.jfailed = true;
        this.emit({ type: 'status', id: doc.id, state: 'journal-error', error: e.message });
        setTimeout(() => { if (this.docs.has(doc.id)) this.update(doc.id, doc.latest); }, 2000);
        return { ok: false, error: e.message };
      }
      doc.text = next;
      doc.seq += 1;
      doc.jfailed = false;
      if (doc.jsize > Math.max(COMPACT_MIN_BYTES, doc.text.length * 3)) await this.#compact(doc).catch(() => {});
    }
    this.emit({ type: 'status', id: doc.id, state: 'durable', seq: doc.seq });
    return { ok: true, seq: doc.seq };
  }

  async #append(doc, rec) {
    const buf = Buffer.from(frame(rec));
    try {
      if (doc.jtorn) { await doc.fh.truncate(doc.jsize); doc.jtorn = false; }
      let done = 0;
      while (done < buf.length) {
        done += (await doc.fh.write(buf, done, buf.length - done, doc.jsize + done)).bytesWritten;
      }
      await doc.fh.sync();
      doc.jsize += buf.length;
    } catch (e) {
      doc.jtorn = true; // a half-written record must not stay in front of the next one
      throw e;
    }
  }

  /** The journal is rewritten as one record, atomically, so a crash here leaves the old one intact. */
  async #compact(doc) {
    await doc.fh.close();
    doc.fh = null;
    try { await atomicWrite(doc.jpath, Buffer.from(frame(this.#toBase(doc)))); }
    finally {
      await this.#openJournal(doc);
      doc.jtorn = false;
    }
  }

  #schedule(doc, delay = COMMIT_IDLE_MS) {
    clearTimeout(doc.timer);
    const now = Date.now();
    doc.firstDirtyAt ||= now;
    const wait = Math.min(delay, Math.max(0, doc.firstDirtyAt + COMMIT_MAX_MS - now));
    doc.timer = setTimeout(() => this.commit(doc.id).catch(() => {}), wait);
  }

  /** Writes to the notes folder now. Failures are reported and retried; the journal still has everything. */
  commit(id) {
    const doc = this.#doc(id);
    clearTimeout(doc.timer);
    return this.#vault(async () => {
      try {
        await this.#commitNow(doc);
        if (doc.commitError) this.emit({ type: 'status', id: doc.id, state: 'recovered' });
        doc.commitError = null;
        if (doc.closing) await this.#finishClose(doc);
      } catch (e) {
        doc.commitError = e.message;
        this.emit({ type: 'status', id: doc.id, state: 'vault-error', error: e.message });
        this.#schedule(doc, RETRY_MS);
        throw e;
      }
    });
  }

  async #commitNow(doc) {
    await doc.jq;
    if (doc.flushing) await doc.flushing;
    // If the journal is broken the editor's text is still the truth, so the file gets it anyway.
    const text = doc.jfailed ? doc.latest : doc.text;
    const seq = doc.seq;
    if (!doc.jfailed && seq === doc.committedSeq && this.#target(doc)) { doc.firstDirtyAt = 0; return; }
    if (!doc.external && !(await this.#vaultOnline())) throw new Error('Der Notizordner ist nicht erreichbar.');
    if (!this.#target(doc)) {
      if (!text) return;
      doc.path = await this.#freeRel(INBOX, nameFromText(text, doc.ext), doc.ext);
      await this.#journal(doc, () => this.#append(doc, { t: 'm', m: { path: doc.path } }));
      this.emit({ type: 'meta', doc: this.#public(doc) });
      this.emit({ type: 'tree' });
    }

    let bytes = encode(text, doc);
    if (!bytes) { // typed something this encoding cannot hold: change the encoding rather than lose the character
      doc.encoding = 'utf-8';
      doc.bom = false;
      bytes = encode(text, doc);
      await this.#journal(doc, () => this.#append(doc, { t: 'm', m: { encoding: 'utf-8', bom: false } }));
      this.notices.push({ kind: 'info', text: `„${this.#name(doc)}“ wird jetzt als UTF-8 gespeichert, weil sie Zeichen enthält, die das alte Encoding nicht kennt.` });
      this.emit({ type: 'notices' });
      this.emit({ type: 'meta', doc: this.#public(doc) });
    }
    const hash = sha(bytes);
    const target = this.#target(doc);
    const disk = await readIfExists(target);
    if (disk) {
      const diskHash = sha(disk);
      if (diskHash !== hash) {
        if (diskHash !== doc.diskHash) {
          const copy = await this.#conflictCopy(target, disk, 'extern geändert');
          this.notices.push({ kind: 'warning', text: `„${this.#name(doc)}“ wurde außerhalb geändert. Die fremde Fassung liegt daneben als „${path.basename(copy)}“.` });
          this.emit({ type: 'notices' });
          this.emit({ type: 'tree' });
        }
        await this.#snapshot(doc, disk); // includes the untouched original before our first write
      }
    }
    if (!disk || sha(disk) !== hash) await atomicWrite(target, bytes, doc.mode);
    doc.diskHash = hash;
    doc.committedSeq = seq;
    doc.firstDirtyAt = 0;
    await this.#journal(doc, () => this.#append(doc, { t: 'c', s: seq, h: hash })).catch(() => {});
    if (!disk) this.emit({ type: 'tree' });
    if (Date.now() - doc.lastSnapshotAt > SNAPSHOT_EVERY_MS) await this.#snapshot(doc, bytes);
    if (doc.autoTitle && doc.path) await this.#autoRename(doc, text);
    this.#mirrorNote(doc, bytes); // after the rename, or the backup collects every name the title went through
    this.emit({ type: 'status', id: doc.id, state: 'committed', seq });
  }

  async #autoRename(doc, text) {
    const [stem, ext] = splitExt(path.posix.basename(doc.path));
    const wanted = nameFromText(text, ext);
    if (wanted === stem || wanted === stem.replace(/ \d+$/, '')) return;
    const folder = path.posix.dirname(doc.path);
    const rel = await this.#freeRel(folder === '.' ? '' : folder, wanted, ext);
    await this.#renameInVault(doc.path, rel).catch(() => {}); // the name is a nicety, never a reason to fail the save
  }

  /** Closes a tab. The journal only goes away once the note is safely in the folder. */
  async close(id) {
    const doc = this.#doc(id);
    doc.closing = true;
    if (doc.flushing) await doc.flushing;
    if (!doc.path && !doc.external && !doc.latest) return this.#dropJournal(doc); // an untouched empty tab leaves nothing behind
    // Typed and erased again: no note worth a file. The trash and the history still have what it was.
    if (doc.path && doc.autoTitle && !doc.latest.trim()) return this.trash(doc.path).catch(() => this.commit(id).catch(() => {}));
    await this.commit(id).catch(() => {}); // keeps retrying; the note comes back as a tab if the app ends first
  }

  async #finishClose(doc) {
    if (this.#target(doc)) {
      const bytes = encode(doc.text, doc);
      if (bytes) await this.#snapshot(doc, bytes).catch(() => {});
    }
    if (!doc.closing) return; // reopened while that was written: the tab is using this document again
    await this.#dropJournal(doc);
  }

  /** A reversible change of how the text is stored: encoding, line ending. */
  async setFormat(id, { encoding, eol, bom }) {
    const doc = this.#doc(id);
    const m = {};
    if (['utf-8', 'utf-16le', 'utf-16be', 'windows-1252'].includes(encoding)) m.encoding = encoding;
    if (['\n', '\r\n', '\r'].includes(eol)) m.eol = eol;
    if (typeof bom === 'boolean') m.bom = bom;
    const probe = { encoding: doc.encoding, bom: doc.bom, eol: doc.eol, ...m };
    if (!encode(doc.latest, probe)) throw new Error('Dieses Encoding kann nicht alle Zeichen der Datei darstellen.');
    Object.assign(doc, m);
    await this.#journal(doc, () => this.#append(doc, { t: 'm', m }));
    doc.committedSeq = -1; // the bytes change even though the text does not
    await this.commit(id);
    return this.#public(doc);
  }

  /** Reads a file at the same spot again, ignoring the editor, for "the disk changed" checks. */
  async checkExternal() {
    return this.#vault(async () => {
      for (const doc of [...this.docs.values()]) {
        const target = this.#target(doc);
        if (!target || doc.closing) continue;
        if (!doc.external && !(await this.#vaultOnline())) continue;
        let disk;
        try { disk = await readIfExists(target); } catch { continue; } // locked: look again next time
        const clean = doc.latest === doc.text && doc.seq === doc.committedSeq;
        if (!disk) {
          if (clean && doc.diskHash) {
            await this.#saveDeletedElsewhere(doc);
            this.emit({ type: 'closed', id: doc.id });
            this.emit({ type: 'notices' });
            this.emit({ type: 'tree' });
          }
          continue;
        }
        const hash = sha(disk);
        if (hash === doc.diskHash) continue;
        if (clean) {
          await this.#snapshot(doc, encode(doc.text, doc) ?? Buffer.from(doc.text));
          await this.#reloadFrom(doc, disk);
          this.emit({ type: 'reload', doc: this.#public(doc) });
        } else {
          const copy = await this.#conflictCopy(target, disk, 'extern geändert');
          await this.#snapshot(doc, disk);
          doc.diskHash = hash;
          this.notices.push({ kind: 'warning', text: `„${this.#name(doc)}“ wurde außerhalb geändert. Die fremde Fassung liegt daneben als „${path.basename(copy)}“.` });
          this.emit({ type: 'notices' });
          this.emit({ type: 'tree' });
        }
      }
    });
  }

  async #reloadFrom(doc, disk) {
    let dec;
    try { dec = decode(disk); }
    catch {
      doc.diskHash = sha(disk); // it turned binary: leave the file alone, keep our text in the tab
      return;
    }
    doc.latest = dec.text;
    doc.encoding = dec.encoding;
    doc.bom = dec.bom;
    doc.eol = dec.eol;
    doc.diskHash = sha(disk);
    await this.#journal(doc, async () => {
      doc.text = dec.text;
      doc.seq += 1;
      doc.committedSeq = doc.seq;
      await this.#compact(doc);
    });
  }

  async #conflictCopy(target, bytes, label) {
    const dir = path.dirname(target);
    const [stem, ext] = splitExt(path.basename(target));
    let file = path.join(dir, `${stem} (${label} ${humanStamp()})${ext}`);
    for (let n = 2; await exists(file); n++) file = path.join(dir, `${stem} (${label} ${humanStamp()} ${n})${ext}`);
    await atomicWrite(file, bytes);
    return file;
  }

  // ---------------------------------------------------------------- history

  async #snapshot(doc, bytes) {
    if (!this.#target(doc)) return;
    const hash = sha(bytes).slice(0, 12);
    doc.lastSnapshotAt = Date.now();
    if (hash === doc.snapHash) return;
    const dir = this.#historyOf(doc);
    await fs.mkdir(dir, { recursive: true });
    const names = (await fs.readdir(dir)).sort();
    doc.snapHash = hash;
    if (names.at(-1)?.endsWith(`-${hash}.gz`)) return;
    const file = path.join(dir, `${stamp()}-${randomUUID().slice(0, 4)}-${hash}.gz`);
    const gz = await gzip(bytes);
    await atomicWrite(file, gz);
    this.#toBackup({ copy: path.join('verlauf', path.relative(this.historyDir, file)), bytes: gz });
  }

  /** @returns {{version: string, date: number, size: number}[]} newest first */
  async history(ref) {
    if (ref.id && !this.#target(this.#doc(ref.id))) return []; // a tab that has no file yet has no versions yet
    const dir = this.#historyDirFor(ref);
    let names;
    try { names = await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
    const out = [];
    for (const n of names) {
      const m = n.isFile() && /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\d{3}-.*\.gz$/.exec(n.name);
      if (!m) continue;
      const { size } = await fs.stat(path.join(dir, n.name));
      out.push({ version: n.name, date: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]), size });
    }
    return out.sort((a, b) => b.version.localeCompare(a.version));
  }

  async readVersion(ref, version) {
    if (typeof version !== 'string' || !/^[\w-]+\.gz$/.test(version)) throw new Error('Ungültige Version.');
    const dir = this.#historyDirFor(ref);
    return decode(await gunzip(await fs.readFile(path.join(dir, version)))).text;
  }

  #historyDirFor(ref) {
    if (ref.id) return this.#historyOf(this.#doc(ref.id));
    return path.join(this.historyDir, 'notes', ...checkRel(ref.path).split('/'));
  }

  // ---------------------------------------------------------------- tree

  /** The notes folder as a tree. Hidden names, symlinks and our temp files are left out. */
  async tree() {
    const order = await this.#readOrder();
    const walk = async (rel) => {
      const entries = await fs.readdir(rel ? this.#abs(rel) : this.vault, { withFileTypes: true }).catch(() => []);
      const items = [];
      for (const e of entries) {
        if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) items.push({ type: 'folder', name: e.name, path: p, children: await walk(p) });
        else if (e.isFile()) items.push({ type: 'file', name: e.name, path: p });
      }
      const rank = new Map((order[rel] ?? []).map((n, i) => [n, i]));
      return items.sort((a, b) => {
        const ra = rank.get(a.name) ?? Infinity;
        const rb = rank.get(b.name) ?? Infinity;
        if (ra !== rb) return ra - rb;
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return a.name.localeCompare(b.name, 'de', { numeric: true, sensitivity: 'base' });
      });
    };
    return { online: await this.#vaultOnline(), vault: this.vault, items: await walk('') };
  }

  async #readOrder() {
    try { return JSON.parse(await fs.readFile(path.join(this.vault, META, 'order.json'), 'utf8')); }
    catch { return {}; }
  }

  /** The hand-made order of one folder, as in a wiki. */
  async setOrder(folder, names) {
    checkRel(folder, { allowEmpty: true });
    if (!Array.isArray(names) || names.some((n) => typeof n !== 'string')) throw new Error('Ungültige Reihenfolge.');
    return this.#vault(async () => {
      const order = await this.#readOrder();
      order[folder] = names;
      await atomicWrite(path.join(this.vault, META, 'order.json'), Buffer.from(JSON.stringify(order, null, 2)));
      this.emit({ type: 'tree' });
    });
  }

  /** Same-name check against the folder's listing, ignoring case, so a sync to Windows cannot collide later. */
  async #freeRel(folder, stem, ext) {
    const dir = folder ? this.#abs(folder) : this.vault;
    const taken = new Set((await fs.readdir(dir).catch(() => [])).map((n) => n.toLowerCase()));
    let name = `${stem}${ext}`;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${stem} ${n}${ext}`;
    return folder ? `${folder}/${name}` : name;
  }

  async createFolder(parent, name) {
    checkRel(parent, { allowEmpty: true });
    return this.#vault(async () => {
      if (!(await this.#vaultOnline())) throw new Error('Der Notizordner ist nicht erreichbar.');
      const rel = await this.#freeRel(parent, safeName(name, 'Neuer Ordner'), '');
      await fs.mkdir(this.#abs(rel), { recursive: true });
      this.emit({ type: 'tree' });
      return rel;
    });
  }

  /** A new empty note in a given folder, from the tree's context menu. */
  async createNote(folder, name) {
    checkRel(folder, { allowEmpty: true });
    return this.#vault(async () => {
      if (!(await this.#vaultOnline())) throw new Error('Der Notizordner ist nicht erreichbar.');
      const given = safeName(name);
      const [stem, ext] = splitExt(given);
      const rel = FILE_EXT.test(ext) ? await this.#freeRel(folder, stem, ext) : await this.#freeRel(folder, given, '.md');
      await atomicWrite(this.#abs(rel), Buffer.alloc(0));
      this.emit({ type: 'tree' });
      return rel;
    });
  }

  /** Move and rename in one. Never overwrites: a taken name gets a number. */
  async move(rel, destFolder, newName) {
    checkRel(rel);
    checkRel(destFolder, { allowEmpty: true });
    if (destFolder === rel || destFolder.startsWith(`${rel}/`)) throw new Error('Ein Ordner kann nicht in sich selbst verschoben werden.');
    return this.#vault(async () => {
      rel = await this.#flushUnder(rel);
      const oldName = path.posix.basename(rel);
      const st = await fs.stat(this.#abs(rel));
      const [oldStem, oldExt] = st.isDirectory() ? [oldName, ''] : splitExt(oldName);
      let stem = oldStem;
      let ext = oldExt;
      if (newName !== undefined) {
        const clean = safeName(newName);
        const [typedStem, typedExt] = splitExt(clean);
        if (!st.isDirectory() && FILE_EXT.test(typedExt)) { stem = typedStem; ext = typedExt; }
        else stem = clean;
      }
      const sameFolder = (path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel)) === destFolder;
      if (sameFolder && stem === oldStem && ext === oldExt) return rel;
      // Only the case changes: on Windows the name counts as taken by itself, which is not a collision.
      const dest = sameFolder && `${stem}${ext}`.toLowerCase() === oldName.toLowerCase()
        ? (destFolder ? `${destFolder}/` : '') + stem + ext
        : await this.#freeRel(destFolder, stem, ext);
      await this.#renameInVault(rel, dest);
      for (const d of this.docs.values()) {
        if (d.autoTitle && (d.path === dest || d.path?.startsWith(`${dest}/`))) {
          d.autoTitle = false; // named or filed by hand: the title no longer follows the first line
          await this.#journal(d, () => this.#append(d, { t: 'm', m: { autoTitle: false } })).catch(() => {});
          this.emit({ type: 'meta', doc: this.#public(d) });
        }
      }
      return dest;
    });
  }

  /** @returns where the note is now: the last words typed can change the name of a note that follows its title. */
  async #flushUnder(rel) {
    const self = [...this.docs.values()].find((d) => d.path === rel);
    for (const d of this.docs.values()) {
      if (d.path === rel || d.path?.startsWith(`${rel}/`)) await this.#commitNow(d);
    }
    return self?.path ?? rel;
  }

  /** Runs inside the queue. Journals and history follow the file. */
  async #renameInVault(rel, dest) {
    await fs.mkdir(path.dirname(this.#abs(dest)), { recursive: true });
    await renameRetry(this.#abs(rel), this.#abs(dest));
    await syncDir(path.dirname(this.#abs(dest)));

    const historyFrom = path.join(this.historyDir, 'notes', ...rel.split('/'));
    const historyTo = path.join(this.historyDir, 'notes', ...dest.split('/'));
    if (await exists(historyFrom)) {
      await fs.mkdir(path.dirname(historyTo), { recursive: true });
      await this.#mergeInto(historyFrom, historyTo).catch(() => {}); // old versions stay findable under the old name
    }
    for (const d of this.docs.values()) {
      if (d.path !== rel && !d.path?.startsWith(`${rel}/`)) continue;
      d.path = dest + d.path.slice(rel.length);
      d.ext = path.posix.extname(d.path);
      await this.#journal(d, () => this.#append(d, { t: 'm', m: { path: d.path, ext: d.ext } })).catch(() => {});
      this.emit({ type: 'meta', doc: this.#public(d) });
    }
    await this.#renameInOrder(rel, dest);
    this.#toBackup({ op: 'move', from: rel, to: dest });
    this.emit({ type: 'tree' });
  }

  async #mergeInto(from, to) {
    // Only the case changed: on Windows both names are this one folder, and merging would delete it.
    if (!(await exists(to)) || from.toLowerCase() === to.toLowerCase()) return renameRetry(from, to);
    for (const e of await fs.readdir(from, { withFileTypes: true })) {
      const f = path.join(from, e.name);
      const t = path.join(to, e.name);
      if (e.isDirectory()) await this.#mergeInto(f, t);
      else if (!(await exists(t))) await fs.rename(f, t);
    }
    await fs.rm(from, { recursive: true, force: true });
  }

  async #renameInOrder(rel, dest) {
    const order = await this.#readOrder();
    const folder = (p) => (path.posix.dirname(p) === '.' ? '' : path.posix.dirname(p));
    const list = order[folder(rel)];
    if (!list?.includes(path.posix.basename(rel)) || folder(rel) !== folder(dest)) return;
    list[list.indexOf(path.posix.basename(rel))] = path.posix.basename(dest);
    await atomicWrite(path.join(this.vault, META, 'order.json'), Buffer.from(JSON.stringify(order, null, 2))).catch(() => {});
  }

  /** The note type changed, e.g. JSON pasted into an empty note. */
  async setExtension(id, ext) {
    if (!/^\.[\w-]{1,12}$/.test(ext)) throw new Error('Ungültige Dateiendung.');
    const doc = this.#doc(id);
    return this.#vault(async () => {
      if (doc.external) return this.#public(doc);
      if (!doc.path) {
        doc.ext = ext;
        await this.#journal(doc, () => this.#append(doc, { t: 'm', m: { ext } }));
      } else {
        const [stem] = splitExt(path.posix.basename(doc.path));
        const dir = path.posix.dirname(doc.path);
        await this.#commitNow(doc);
        await this.#renameInVault(doc.path, await this.#freeRel(dir === '.' ? '' : dir, stem, ext));
      }
      return this.#public(doc);
    });
  }

  /** A pasted image. Named by content and addressed from the notes folder, so moving a note keeps its images. */
  async saveAsset(bytes, ext) {
    if (!/^(png|jpe?g|gif|webp|bmp)$/i.test(ext) || !(bytes instanceof Uint8Array)) throw new Error('Dieses Bildformat wird nicht unterstützt.');
    return this.#vault(async () => {
      if (!(await this.#vaultOnline())) throw new Error('Der Notizordner ist nicht erreichbar.');
      const rel = `${META}/assets/${sha(bytes).slice(0, 24)}.${ext.toLowerCase()}`;
      if (!(await exists(path.join(this.vault, ...rel.split('/'))))) await atomicWrite(path.join(this.vault, ...rel.split('/')), Buffer.from(bytes));
      return rel;
    });
  }

  // ---------------------------------------------------------------- trash

  /** Deleting is moving. Nothing leaves the disk until the trash is emptied by hand. */
  async trash(rel) {
    checkRel(rel);
    return this.#vault(async () => {
      rel = await this.#flushUnder(rel);
      const under = [...this.docs.values()].filter((d) => d.path === rel || d.path?.startsWith(`${rel}/`));
      for (const d of under) {
        const bytes = encode(d.text, d);
        if (bytes) await this.#snapshot(d, bytes).catch(() => {});
      }
      const abs = this.#abs(rel);
      const st = await fs.stat(abs);
      const name = path.posix.basename(rel);
      const id = `${stamp()}-${randomUUID().slice(0, 6)}`;
      const dir = path.join(this.vault, TRASH, id);
      const meta = { rel, name, isDir: st.isDirectory(), deletedAt: Date.now() };
      await fs.mkdir(dir, { recursive: true });
      await atomicWrite(path.join(dir, 'meta.json'), Buffer.from(JSON.stringify(meta)));
      await renameRetry(abs, path.join(dir, name));
      this.#toBackup({ op: 'trash', id, meta });
      for (const d of under) {
        await this.#dropJournal(d);
        this.emit({ type: 'closed', id: d.id });
      }
      this.emit({ type: 'tree' });
    });
  }

  async listTrash() {
    const root = path.join(this.vault, TRASH);
    const out = [];
    for (const id of await fs.readdir(root).catch(() => [])) {
      try { out.push({ id, ...JSON.parse(await fs.readFile(path.join(root, id, 'meta.json'), 'utf8')) }); }
      catch { /* not one of ours */ }
    }
    return out.sort((a, b) => b.deletedAt - a.deletedAt);
  }

  #trashEntry(id) {
    if (typeof id !== 'string' || !/^[\w-]+$/.test(id)) throw new Error('Ungültiger Eintrag.');
    return path.join(this.vault, TRASH, id);
  }

  /** Back to where it came from; a taken name gets a number instead of overwriting. */
  async restoreTrash(id) {
    const dir = this.#trashEntry(id);
    return this.#vault(async () => {
      const meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8'));
      checkRel(meta.rel);
      const parent = path.posix.dirname(meta.rel) === '.' ? '' : path.posix.dirname(meta.rel);
      const [stem, ext] = meta.isDir ? [meta.name, ''] : splitExt(meta.name);
      const dest = await this.#freeRel(parent, stem, ext);
      await fs.mkdir(path.dirname(this.#abs(dest)), { recursive: true });
      await renameRetry(path.join(dir, meta.name), this.#abs(dest));
      await fs.rm(dir, { recursive: true, force: true });
      this.#toBackup({ op: 'restore', id, name: meta.name, to: dest });
      this.emit({ type: 'tree' });
      return dest;
    });
  }

  /** The only real delete in the app, and only ever after the user confirmed it: the notes, their versions, and both in the backup. */
  async emptyTrash() {
    return this.#vault(async () => {
      if (!(await this.#vaultOnline())) throw new Error('Der Notizordner ist nicht erreichbar.');
      const entries = await this.listTrash();
      await fs.rm(path.join(this.vault, TRASH), { recursive: true, force: true });
      const history = [];
      for (const { rel } of entries) {
        try { checkRel(rel); } catch { continue; } // meta.json is only a file in a folder: it decides nothing about what gets deleted
        // ponytail: versions are filed by name, so a new note with the old name keeps the old versions too.
        if (await exists(this.#abs(rel))) continue;
        await fs.rm(path.join(this.historyDir, 'notes', ...rel.split('/')), { recursive: true, force: true });
        history.push(rel);
      }
      this.#toBackup({ op: 'empty', history });
    });
  }

  // ---------------------------------------------------------------- second backup location
  //
  // The backup follows what the user did, step by step. It never compares folders and deletes what is missing:
  // a dead drive or a sync tool gone wrong looks like "everything was deleted", and that is the moment the backup exists for.

  #mirrorFailed(e) { this.emit({ type: 'backup-error', error: e.message }); }

  #mirrorNote(doc, bytes) {
    if (doc.path) this.#toBackup({ copy: path.join('notizen', ...doc.path.split('/')), bytes, mode: doc.mode });
  }

  /**
   * One line for everything, in the order it happened, so a late copy cannot bring back a renamed or deleted file.
   * A step with `op` was the user's decision: it is kept on disk until the backup has done it. Copies can go, the next sync repeats them.
   * ponytail: a hanging network drive stalls this line and holds its copies in memory; a timeout per step would bound that.
   */
  #toBackup(item) {
    if (!this.backup) return Promise.resolve();
    this.backupQ.push(item);
    return (this.backupTail = this.backupTail.then(() => this.#drainBackup()));
  }

  async #saveBackupOps() {
    const json = JSON.stringify(this.backupQ.filter((i) => i.op));
    if (json === this.backupSaved) return;
    try {
      await atomicWrite(this.backupOpsFile, Buffer.from(json));
      this.backupSaved = json;
    } catch (e) { this.#mirrorFailed(e); }
  }

  async #drainBackup() {
    await this.#saveBackupOps();
    const halt = (e) => {
      this.backupQ = this.backupQ.filter((i) => i.op);
      this.#mirrorFailed(e);
    };
    while (this.backupQ.length) {
      const item = this.backupQ[0];
      // Never mkdir a missing backup: it may be an unplugged drive, and the copies would land where nobody looks for them.
      if (!(await exists(this.backup))) return halt(new Error('Der Sicherungsort ist nicht erreichbar.'));
      try {
        await this.#applyToBackup(item);
        this.emit({ type: 'backup-ok' });
      } catch (e) {
        // ponytail: a step that keeps failing is given up, which leaves a stray file. Better than a backup that stops getting copies.
        if (item.op && (item.tries = (item.tries ?? 0) + 1) < BACKUP_TRIES) return halt(e);
        this.#mirrorFailed(e);
      }
      if (this.backupQ[0] === item) this.backupQ.shift();
      if (item.op) await this.#saveBackupOps();
    }
  }

  async #applyToBackup(item) {
    if (item.copy) return atomicWrite(path.join(this.backup, item.copy), item.bytes, item.mode);
    if (item.sync) return this.#copyAllToBackup();
    const notes = (rel) => path.join(this.backup, 'notizen', ...rel.split('/'));
    const versions = (rel) => path.join(this.backup, 'verlauf', 'notes', ...rel.split('/'));
    const trashed = (id, name) => path.join(this.backup, 'notizen', TRASH, id, name);
    if (item.op === 'move') {
      await this.#moveInBackup(notes(item.from), notes(item.to));
      await this.#moveInBackup(versions(item.from), versions(item.to));
    } else if (item.op === 'trash') {
      if (await this.#moveInBackup(notes(item.meta.rel), trashed(item.id, item.meta.name))) {
        await atomicWrite(trashed(item.id, 'meta.json'), Buffer.from(JSON.stringify(item.meta)));
      }
    } else if (item.op === 'restore') {
      await this.#moveInBackup(trashed(item.id, item.name), notes(item.to));
      await fs.rm(path.dirname(trashed(item.id, item.name)), { recursive: true, force: true });
    } else if (item.op === 'empty') {
      await fs.rm(path.join(this.backup, 'notizen', TRASH), { recursive: true, force: true });
      for (const rel of item.history) await fs.rm(versions(rel), { recursive: true, force: true });
    }
  }

  /** @returns whether there was something to move. A file that never got there, or moved on the last run, is fine. */
  async #moveInBackup(from, to) {
    const st = await fs.stat(from).catch(() => null);
    if (!st) return false;
    await fs.mkdir(path.dirname(to), { recursive: true });
    if (st.isDirectory()) await this.#mergeInto(from, to);
    else await renameRetry(from, to); // replaces what is there: that name was free in the notes folder, so it is a leftover
    return true;
  }

  /** A different folder starts fresh: what was still owed to the old one means nothing there. */
  setBackup(dir) {
    this.backup = dir;
    this.backupQ = [];
    return this.syncBackup();
  }

  /** Brings the backup up to date: first what was decided while it was unplugged, then copies of what changed. */
  syncBackup() { return this.#toBackup({ sync: true }); }

  async #copyAllToBackup() {
    const copyTree = async (from, to) => {
      for (const e of await fs.readdir(from, { withFileTypes: true }).catch(() => [])) {
        if (e.isSymbolicLink() || e.name.endsWith(TMP_SUFFIX)) continue;
        const f = path.join(from, e.name);
        const t = path.join(to, e.name);
        if (e.isDirectory()) { await copyTree(f, t); continue; }
        if (!e.isFile()) continue;
        const [sf, st] = await Promise.all([fs.stat(f), fs.stat(t).catch(() => null)]);
        if (st && st.size === sf.size && st.mtimeMs >= sf.mtimeMs) continue;
        await atomicWrite(t, await fs.readFile(f));
      }
    };
    await copyTree(this.vault, path.join(this.backup, 'notizen'));
    await copyTree(this.historyDir, path.join(this.backup, 'verlauf'));
  }

  // ---------------------------------------------------------------- changing the notes folder

  /** Copies into the new folder and checks every file. The old folder stays as it is. */
  async changeVault(newVault) {
    const from = path.resolve(this.vault);
    const to = path.resolve(newVault);
    if (from === to) return;
    const inside = (a, b) => { const r = path.relative(a, b); return r && !r.startsWith('..') && !path.isAbsolute(r); };
    if (inside(from, to) || inside(to, from)) throw new Error('Der neue Ordner darf nicht im alten liegen und umgekehrt.');
    return this.#vault(async () => {
      for (const d of this.docs.values()) await this.#commitNow(d);
      await fs.mkdir(to, { recursive: true });
      const copy = async (a, b) => {
        await fs.mkdir(b, { recursive: true });
        for (const e of await fs.readdir(a, { withFileTypes: true })) {
          if (e.isSymbolicLink() || e.name.endsWith(TMP_SUFFIX)) continue;
          const src = path.join(a, e.name);
          let dst = path.join(b, e.name);
          if (e.isDirectory()) { await copy(src, dst); continue; }
          if (!e.isFile()) continue;
          const bytes = await fs.readFile(src);
          const have = await readIfExists(dst);
          if (have && sha(have) === sha(bytes)) continue;
          if (have) dst = await this.#conflictCopy(dst, bytes, 'aus altem Ordner');
          else await atomicWrite(dst, bytes);
          if (sha(await fs.readFile(dst)) !== sha(bytes)) throw new Error(`Kopie von ${e.name} ist fehlerhaft, der alte Ordner bleibt aktiv.`);
        }
      };
      await copy(from, to);
      this.vault = to;
      for (const d of this.docs.values()) {
        const target = this.#target(d);
        if (d.path && target) d.diskHash = sha(await fs.readFile(target));
      }
      this.emit({ type: 'tree' });
    });
  }
}
