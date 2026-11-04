// JSON pretty print and minify that only touch whitespace. JSON.stringify(JSON.parse(x)) is deliberately not
// used: it rounds big numbers, turns 1.0 into 1, drops duplicate keys and reorders numeric keys.

export class JsonError extends Error {
  constructor(message, line, column) {
    super(line ? `${message} (Zeile ${line}, Spalte ${column})` : message);
    this.line = line;
    this.column = column;
  }
}

function validate(src) {
  try {
    JSON.parse(src);
  } catch (e) {
    const pos = /position (\d+)/.exec(e.message)?.[1];
    if (pos === undefined) throw new JsonError('Das ist kein gültiges JSON.');
    const before = src.slice(0, Number(pos)).split('\n');
    throw new JsonError('Das ist kein gültiges JSON.', before.length, before.at(-1).length + 1);
  }
}

function reflow(src, indent) {
  const nl = (depth) => (indent === null ? '' : '\n' + indent.repeat(depth));
  const isSpace = (c) => c === ' ' || c === '\n' || c === '\r' || c === '\t';
  let out = '';
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (isSpace(c)) continue;
    if (c === '"') {
      let j = i + 1;
      while (src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j;
    } else if (c === '{' || c === '[') {
      let k = i + 1;
      while (isSpace(src[k])) k++;
      if (src[k] === '}' || src[k] === ']') { out += c + src[k]; i = k; continue; }
      out += c + nl(++depth);
    } else if (c === '}' || c === ']') {
      out += nl(--depth) + c;
    } else if (c === ',') {
      out += c + nl(depth);
    } else if (c === ':') {
      out += indent === null ? ':' : ': ';
    } else {
      out += c;
    }
  }
  return out;
}

const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

export function prettyJson(src, indent = '  ') {
  const s = stripBom(src);
  validate(s);
  return reflow(s, indent);
}

export function minifyJson(src) {
  const s = stripBom(src);
  validate(s);
  return reflow(s, null);
}

export function isJson(src) {
  const s = stripBom(src).trim();
  if (s[0] !== '{' && s[0] !== '[') return false;
  try { JSON.parse(s); return true; } catch { return false; }
}
