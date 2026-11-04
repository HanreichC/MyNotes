// Bytes <-> text without losing anything, and file names that stay valid on both Windows and Linux.

const cp1252Table = (() => {
  const dec = new TextDecoder('windows-1252');
  const map = new Map();
  for (let b = 0; b < 256; b++) map.set(dec.decode(Uint8Array.of(b)), b);
  return map;
})();

const startsWith = (bytes, ...sig) => sig.every((b, i) => bytes[i] === b);

/** Returns { text, encoding, bom, eol, mixedEol }, text always with \n. Throws if the bytes are not text. */
export function decode(bytes) {
  let encoding, bom = false, raw;
  if (startsWith(bytes, 0xef, 0xbb, 0xbf)) { encoding = 'utf-8'; bom = true; raw = bytes.subarray(3); }
  else if (startsWith(bytes, 0xff, 0xfe)) { encoding = 'utf-16le'; bom = true; raw = bytes.subarray(2); }
  else if (startsWith(bytes, 0xfe, 0xff)) { encoding = 'utf-16be'; bom = true; raw = bytes.subarray(2); }
  else {
    if (bytes.subarray(0, 8192).includes(0)) throw new Error('Das ist eine Binärdatei.');
    raw = bytes;
    try { new TextDecoder('utf-8', { fatal: true }).decode(raw); encoding = 'utf-8'; }
    catch { encoding = 'windows-1252'; }
  }
  let text;
  try { text = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(raw); }
  catch { throw new Error('Die Datei passt nicht zu ihrer Kennung und wird deshalb nicht geöffnet.'); }

  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lone = (text.match(/\r(?!\n)/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  const eol = crlf > lf && crlf >= lone ? '\r\n' : lone > lf ? '\r' : '\n';
  return { text: text.replace(/\r\n?/g, '\n'), encoding, bom, eol, mixedEol: [crlf, lone, lf].filter(Boolean).length > 1 };
}

/** Returns a Buffer, or null if this encoding cannot hold the text: the caller must not lose those characters. */
export function encode(text, { encoding = 'utf-8', bom = false, eol = '\n' } = {}) {
  const body = eol === '\n' ? text : text.replaceAll('\n', eol);
  if (encoding === 'windows-1252') {
    const out = [];
    for (const ch of body) {
      const b = cp1252Table.get(ch);
      if (b === undefined) return null;
      out.push(b);
    }
    return Buffer.from(out);
  }
  if (encoding === 'utf-16le' || encoding === 'utf-16be') {
    const buf = Buffer.from((bom ? '﻿' : '') + body, 'utf16le');
    return encoding === 'utf-16be' ? buf.swap16() : buf;
  }
  return Buffer.from((bom ? '﻿' : '') + body, 'utf8');
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** A file name stem that is valid on Windows and Linux, so a synced folder works on both. */
export function safeName(name, fallback = 'Unbenannt') {
  const s = String(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).replace(/[. ]+$/, '').trim();
  if (!/[\p{L}\p{N}]/u.test(s)) return fallback;
  return RESERVED.test(s) ? `_${s}` : s;
}

/** Prose is named after its first line. The first line of code or JSON says nothing, so those wait for a real name. */
export const nameFromText = (text, ext) => (/^\.(md|markdown|txt)$/i.test(ext) ? titleOf(text) : 'Unbenannt');

/** The note's title: the first line that has any text, without its Markdown markers. */
export function titleOf(text) {
  for (const line of text.split('\n', 50)) {
    const t = line.replace(/^\s*(#{1,6}\s+|>\s*|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)*/, '').replace(/[*_`~]/g, '').trim();
    if (/[\p{L}\p{N}]/u.test(t)) return safeName(t);
  }
  return 'Unbenannt';
}
