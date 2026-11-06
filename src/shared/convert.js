// Turning a note into another format. Nothing here touches a file: it takes bytes and gives back the name, type and bytes of a new note.
// Numbers are copied as text wherever JSON is involved, as in json.js: 12345678901234567890 and 1.0 stay what they are.
import { Marked } from 'marked';
import { t } from './i18n.js';
import { prettyJson } from './json.js';
import { decode } from './text.js';

const textOf = (bytes) => { try { return decode(bytes).text; } catch { return null; } }; // null: not text, so only the byte conversions apply
const utf8 = (text) => new TextEncoder().encode(text);
const isUtf8 = (bytes) => { try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return !bytes.includes(0); } catch { return false; } };

// ---------------------------------------------------------------- CSV

/** RFC 4180: quotes may hold delimiters, line breaks and doubled quotes. Returns rows, or null if a quote never closes. */
export function parseCsv(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') cell += c;
      else if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === delimiter) { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (quoted) return null;
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** A table: several rows and columns, every row as wide as the first. Semicolons are what Excel writes in Germany. */
function csvTable(text) {
  for (const delimiter of [',', ';', '\t']) {
    const rows = parseCsv(text, delimiter);
    if (rows && rows.length > 1 && rows[0].length > 1 && rows.every((r) => r.length === rows[0].length)) return rows;
  }
  return null;
}

/** Numbers and true/false stay what they are. "00123" is not a number here: it would lose its zeros. */
const jsonValue = (cell) => (/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$|^(true|false)$/.test(cell) ? cell : JSON.stringify(cell));

function tableToJson([head, ...rows], indent) {
  const keys = head.map((k) => JSON.stringify(k.trim()));
  return prettyJson(`[${rows.map((r) => `{${r.map((cell, i) => `${keys[i]}:${jsonValue(cell)}`).join(',')}}`).join(',')}]`, indent);
}

const csvCell = (s) => (/[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);

/** An array of objects as a table, with every key that occurs anywhere. Returns null for any other JSON. */
export function jsonToCsv(text) {
  let data;
  try { data = JSON.parse(text, (_k, v, context) => (typeof v === 'number' ? JSON.rawJSON(context.source) : v)); } catch { return null; }
  const isRow = (o) => o !== null && typeof o === 'object' && !Array.isArray(o) && !JSON.isRawJSON(o);
  if (!Array.isArray(data) || !data.length || !data.every(isRow)) return null;
  const keys = [...new Set(data.flatMap(Object.keys))];
  const cell = (v) => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v));
  return `${[keys.map(csvCell).join(','), ...data.map((o) => keys.map((k) => csvCell(cell(o[k]))).join(','))].join('\n')}\n`;
}

// ---------------------------------------------------------------- plain text to JSON

/** A table, or `key: value` lines, or else one entry per line: some JSON that says what the text says. */
export function textToJson(text, indent = '  ') {
  const table = csvTable(text);
  if (table) return tableToJson(table, indent);
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const pairs = lines.map((l) => /^([\w.-]+)\s*[:=]\s*(.*)$/.exec(l));
  if (lines.length && pairs.every(Boolean)) return prettyJson(`{${pairs.map((m) => `${JSON.stringify(m[1])}:${jsonValue(m[2])}`).join(',')}}`, indent);
  return prettyJson(JSON.stringify(lines), indent);
}

// ---------------------------------------------------------------- bytes

export function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** @returns the bytes, or null if this is no Base64 */
export function fromBase64(text) {
  const clean = text.replace(/\s/g, '');
  if (!clean || clean.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) return null;
  return Uint8Array.from(atob(clean), (c) => c.charCodeAt(0));
}

export const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** @returns the bytes, or null if this is no hex */
export function fromHex(text) {
  const clean = text.replace(/\s/g, '');
  if (!clean || clean.length % 2 || !/^[0-9a-fA-F]+$/.test(clean)) return null;
  return Uint8Array.from(clean.match(/../g), (h) => parseInt(h, 16));
}

/** A word like "test" is valid Base64 by accident: decoded it must read as text, or be long enough to be meant as data. */
const meantAsData = (decoded, encoded) => decoded && (isUtf8(decoded) || encoded.trim().length >= 64);

const safeUrlDecode = (text) => { try { return decodeURIComponent(text); } catch { return null; } };

// ---------------------------------------------------------------- Markdown to HTML

const marked = new Marked({ gfm: true, async: false });
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** A whole page with its charset: without one, a browser shows umlauts in a local file as garbage. */
export const markdownToHtml = (text, title) => `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
</head>
<body>
${marked.parse(text)}</body>
</html>
`;

// ---------------------------------------------------------------- what can be done with a given file

/**
 * What this file can become, and only that: each entry works for it.
 * @returns {{label: string, make: () => {name: string, ext: string, bytes: Uint8Array}}[]}
 */
export function conversionsFor(fileName, bytes, indent = '  ') {
  const dot = fileName.lastIndexOf('.');
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot).toLowerCase() : '';
  const text = textOf(bytes);
  const out = [];
  const add = (label, make) => out.push({ label, make });
  const asText = (suffix, newExt, content) => ({ name: suffix ? `${stem} (${suffix})` : stem, ext: newExt, bytes: utf8(content) });
  /** Decoded bytes may be anything. decode() would read most of them as Windows-1252, so only real UTF-8 counts as text here. */
  const decoded = (data) => ({ name: `${stem} (${t('dekodiert')})`, ext: isUtf8(data) ? '.txt' : '.bin', bytes: data });

  if (text !== null && text.trim()) {
    let json = false;
    try { JSON.parse(text); json = true; } catch { /* not JSON */ }
    if (json) {
      const csv = jsonToCsv(text);
      if (csv) add(t('Zu CSV'), () => asText('', '.csv', csv));
    } else {
      add(t('Zu JSON'), () => asText('', '.json', textToJson(text, indent)));
    }
    if (ext === '.md' || ext === '.markdown') add(t('Zu HTML'), () => asText('', '.html', markdownToHtml(text, stem)));
  }
  if (bytes.length) add(t('Zu Base64'), () => asText('Base64', '.txt', toBase64(bytes)));
  if (bytes.length) add(t('Zu Hex'), () => asText('Hex', '.txt', toHex(bytes)));
  if (text !== null && text.trim()) {
    const base64 = fromBase64(text);
    if (meantAsData(base64, text)) add(t('Aus Base64'), () => decoded(base64));
    const hex = fromHex(text);
    if (meantAsData(hex, text)) add(t('Aus Hex'), () => decoded(hex));
    add(t('URL-kodieren'), () => asText('URL', '.txt', encodeURIComponent(text.trim())));
    const url = /%[0-9a-fA-F]{2}/.test(text) ? safeUrlDecode(text.trim()) : null;
    if (url !== null) add(t('URL-dekodieren'), () => asText(t('dekodiert'), '.txt', url));
  }
  return out;
}
