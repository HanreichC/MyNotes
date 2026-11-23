// Reading handwriting in scribbles: what is left of a recognized line once the model has read it. Ported 1:1 from the
// Qt-free part of MyCAD ScribbleRead.cpp; rendering and CTC decoding live elsewhere.
// A line is { text, chars: [{ c, x, confidence }], strokes: [indices] }: chars one per UTF-16 unit of text, same
// order, x the character's center on the sheet (like the strokes), confidence 0…1. Strokes as in scribble-tidy.js.

/** from this confidence on a read space separates words (words) */
export const SureSpace = 0.5;

/** characters of classes 1…111 (0 is the CTC blank), verbatim from htr/config.json */
export const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZäöüÄÖÜß0123456789 .,;:!?"\'()[]{}<>-–—_/\\@#%&*+=|€§°²³→←↑↓×÷';

/** Same numbers as MyCAD's ScribbleRead::InkEdit::Kind: where the ink lacks a character the correction added. */
export const InkEdit = Object.freeze({
  Slash: 0, // slash through the circle at x: o12 → Ø12; next: x of the digit after it, whose height the Ø takes
  Degree: 1, // degree sign after the digit at x: 2×45 → 2×45°
  Space: 2, // gap at x: 25mm → 25 mm
});

// like QChar::isUpper/isLower/isDigit (Unicode categories Lu, Ll, Nd)
const isUpper = (c) => /\p{Lu}/u.test(c);
const isLower = (c) => /\p{Ll}/u.test(c);
const isDigit = (c) => /\p{Nd}/u.test(c);

function box(s) {
  const b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  for (const p of s) {
    b.minX = Math.min(b.minX, p.x), b.maxX = Math.max(b.maxX, p.x);
    b.minY = Math.min(b.minY, p.y), b.maxY = Math.max(b.maxY, p.y);
  }
  return b;
}

/** Is the read line probably writing? The model also reads drawings (a house as "PoA)"), but less sure (synthetic
 *  writing 0.71…1.0, drawings 0.54…0.85) or as a block no wider than tall. Short readings (1–2 characters) always stay:
 *  a single digit is a dimension and as tall as wide.
 *  ponytail: thresholds from synthetic writing; small drawings read as 1–2 characters (cross in a circle: "et") stay
 *  text */
export function looksRead(line, strokes) {
  if (line.chars.length < 3) return line.chars.length > 0;
  let sure = 0;
  for (const c of line.chars) sure += c.confidence / line.chars.length;
  let x0 = 1e300, x1 = -1e300, y0 = 1e300, y1 = -1e300;
  for (const i of line.strokes) {
    for (const p of strokes[i]) {
      x0 = Math.min(x0, p.x), x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y), y1 = Math.max(y1, p.y);
    }
  }
  return sure >= 0.6 && x1 - x0 >= 1.2 * (y1 - y0);
}

/** Word number per stroke for the word option of tidy: surely read spaces, and capitals after small letters
 *  ("derPlan"), separate words even without a visible gap. -1 for strokes outside lines that look like writing, and
 *  for lines with a stroke across several word boundaries (underline): those tidy handles by gaps as before.
 *  ponytail: an underline under exactly two words belongs to the left one; change only if it bothers in daily use */
export function words(lines, strokes) {
  const out = new Array(strokes.length).fill(-1);
  let next = 0;
  for (const l of lines) {
    if (!looksRead(l, strokes)) continue;
    // word boundaries: sure spaces, and a capital after two small letters ("derPlan": in German a noun starts there;
    // "MyCAD", "kN" stay whole). Written tightly, the model reads no space (where it does, tidy already splits at the
    // gap), but it does read the capital
    // ponytail: two small words written tightly ("istder") stay one; splitting them needs a word list
    const spaces = [];
    l.chars.forEach((c, k) => {
      if (c.c === ' ' && c.confidence >= SureSpace) spaces.push(c.x);
      else if (k >= 2 && isUpper(c.c) && isLower(l.chars[k - 1].c) && isLower(l.chars[k - 2].c)) {
        spaces.push((l.chars[k - 1].x + c.x) / 2);
      }
    });
    let mine = [];
    for (const i of l.strokes) {
      let x0 = Infinity, x1 = -Infinity;
      for (const p of strokes[i]) x0 = Math.min(x0, p.x), x1 = Math.max(x1, p.x);
      if (spaces.filter((x) => x > x0 && x < x1).length > 1) {
        mine = [];
        break;
      }
      const cx = (x0 + x1) / 2;
      mine.push(next + spaces.filter((x) => x < cx).length);
    }
    mine.forEach((w, k) => {
      out[l.strokes[k]] = w;
    });
    next += spaces.length + 1;
  }
  return out;
}

/** CAD notation: corrects line.text (and chars) to Ø, ×, °, ±, unit with a space, digits instead of similar letters
 *  in numbers. Returns the InkEdits the ink needs for that: [{ kind, x, next }]. */
export function correct(line) {
  const edits = [];
  const c = line.chars.map((ch) => ({ ...ch }));
  const at = (i) => (i >= 0 && i < c.length ? c[i].c : ' ');
  const digit = (i) => isDigit(at(i));
  const insert = (i, ch, x) => c.splice(i, 0, { c: ch, x, confidence: 1 });
  const Dia = 'Ø', Times = '×', Deg = '°', PlusMinus = '±';

  const letters = 'AlISBZOo', digits = '41158200';
  // a circle at the start of a word before a digit is a diameter (the model does not know Ø): o12, O12, 012, b12,
  // ø12, and a struck-through circle often arrives as D12 or B12 (in notes D often stands for diameter anyway); the
  // first digit after it is often read as a similar letter: ol2, DA.5 (Ø4.5)
  for (let i = 0; i < c.length; i++) {
    const ch = at(i);
    const k = letters.indexOf(at(i + 1));
    const lookalike = k >= 0 && (digit(i + 2) || at(i + 2) === '.' || at(i + 2) === ',');
    if (at(i - 1) === ' ' && 'oO0bBdDøØ'.includes(ch) && (digit(i + 1) || lookalike)) {
      if (lookalike) c[i + 1].c = digits[k];
      if (ch !== Dia && ch !== 'ø') edits.push({ kind: InkEdit.Slash, x: c[i].x, next: c[i + 1].x });
      c[i].c = Dia;
    }
  }
  // o after a number at the end of a word is a degree sign: 45o → 45°
  for (let i = 1; i < c.length; i++) {
    if ((at(i) === 'o' || at(i) === 'O') && digit(i - 1) && at(i + 1) === ' ') c[i].c = Deg;
  }
  // similar letters in numbers are digits: 2xA5 → 2x45, l2 → 12, 4.S → 4.5
  for (let i = 0; i < c.length; i++) {
    const k = letters.indexOf(at(i));
    const afterDigit = digit(i - 1) || ((at(i - 1) === '.' || at(i - 1) === ',') && digit(i - 2));
    const numberBefore = afterDigit || ((at(i - 1).toLowerCase() === 'x' || at(i - 1) === Times) && digit(i - 2));
    const numberAfter = digit(i + 1) || at(i + 1) === Deg || at(i + 1) === ',' || at(i + 1) === '.';
    if (k >= 0 && numberBefore && (numberAfter || (at(i + 1) === ' ' && afterDigit))) c[i].c = digits[k];
  }
  // x between numbers is a times sign: 2x45 → 2×45
  for (let i = 1; i < c.length; i++) {
    if (at(i).toLowerCase() === 'x' && digit(i - 1) && digit(i + 1)) c[i].c = Times;
  }
  // chamfer: size × angle without a degree sign gets one. Chamfer means: the word is there ("Fase"), or a small size
  // times 30/45/60 (3×4 or 20×30 stay dimensions)
  const chamfer = /fase/iu.test(line.text); // like Qt::CaseInsensitive, which folds case
  for (let i = 1; i < c.length; i++) {
    if (at(i) !== Times || !digit(i - 1) || !digit(i + 1)) continue;
    let start = i - 1, end = i + 1;
    while (digit(start - 1) || at(start - 1) === ',' || at(start - 1) === '.') --start;
    let size = '', angle = '';
    for (let k = start; k < i; k++) size += at(k) === ',' ? '.' : at(k);
    while (digit(end)) angle += at(end++);
    const a = Number(angle) || 0; // QString::toInt/toDouble give 0 when they fail
    const typical = (a === 30 || a === 45 || a === 60) && (Number(size) || 0) <= 10;
    if (at(end) !== Deg && a > 0 && a <= 90 && (chamfer || typical)) {
      edits.push({ kind: InkEdit.Degree, x: c[end - 1].x, next: 0 });
      insert(end, Deg, c[end - 1].x);
    }
  }
  // unit with a space: 25mm → 25 mm
  for (let i = 1; i < c.length; i++) {
    const unit = (at(i) === 'm' && (at(i + 1) === 'm' || at(i + 1) === ' ')) || (at(i) === 'c' && at(i + 1) === 'm');
    if (unit && digit(i - 1)) {
      const x = (c[i - 1].x + c[i].x) / 2;
      edits.push({ kind: InkEdit.Space, x, next: 0 });
      insert(i, ' ', x);
    }
  }
  // +- and +/- are ±
  for (let i = 0; i + 1 < c.length; i++) {
    if (at(i) === '+' && (at(i + 1) === '-' || (at(i + 1) === '/' && at(i + 2) === '-'))) {
      c[i].c = PlusMinus;
      c.splice(i + 1, at(i + 1) === '/' ? 2 : 1);
    }
  }
  line.chars = c;
  line.text = c.map((ch) => ch.c).join('');
  return edits;
}

/** Adds to the ink of the line (sheet coordinates, y up) what the edits need: new strokes appended to strokes, gaps
 *  move strokes. Mutates strokes. Returns per new stroke the stroke it inherits pen, color and width from. */
export function applyInk(strokes, line, edits) {
  const cx = (b) => (b.minX + b.maxX) / 2;
  const boxOf = (i) => box(strokes[i]);
  const mine = [...line.strokes]; // the line and what is added here
  const heights = mine.map((i) => boxOf(i).maxY - boxOf(i).minY).sort((a, b) => a - b);
  const typical = heights.length ? heights[Math.floor(heights.length / 2)] : 0;
  if (typical <= 0) return [];
  /** the stroke whose center is closest to x (dots and crossbars do not count) */
  const nearest = (x) => {
    let best = mine[0], d = Infinity;
    for (const i of line.strokes) {
      const b = boxOf(i);
      if (b.maxY - b.minY > 0.4 * typical && Math.abs(cx(b) - x) < d) {
        d = Math.abs(cx(b) - x);
        best = i;
      }
    }
    return best;
  };
  const width = (i) => {
    const w = strokes[i].map((p) => p.w).sort((a, b) => a - b);
    return w[Math.floor(w.length / 2)];
  };
  const origins = [];
  // right to left: a gap only moves what is already done
  const sorted = [...edits].sort((a, b) => b.x - a.x);
  for (const e of sorted) {
    if (e.kind === InkEdit.Space) {
      for (const i of mine) {
        if (cx(boxOf(i)) > e.x) for (const p of strokes[i]) p.x += 0.45 * typical;
      }
      continue;
    }
    const ref = nearest(e.x);
    let b = boxOf(ref);
    const s = [];
    if (e.kind === InkEdit.Slash) {
      // already a stroke in the circle: the Ø has its slash, only the model does not know it
      const slashed = line.strokes.some((i) => {
        const o = boxOf(i);
        return i !== ref && cx(o) > b.minX && cx(o) < b.maxX && (o.minY + o.maxY) / 2 > b.minY && (o.minY + o.maxY) / 2 < b.maxY;
      });
      if (slashed) continue;
      // a small o becomes as tall as the digit after it, else it would look like ø. It grows to the right (the word
      // gap on the left stays), the digits move on by the extra width and the overhang of the slash.
      const digit = boxOf(nearest(e.next));
      const f = Math.min(Math.max((digit.maxY - digit.minY) / Math.max(b.maxY - b.minY, 1e-9), 1), 2);
      const left = b.minX, bottom = b.minY, fx = 1 + (f - 1) * 0.4; // grow narrower: Ø is oval
      for (const p of strokes[ref]) {
        p.x = left + (p.x - left) * fx;
        p.y = bottom + (p.y - bottom) * f;
      }
      const extra = (b.maxX - b.minX) * (fx - 1) + 0.05 * (b.maxX - b.minX) * fx;
      for (const i of mine) {
        if (i !== ref && cx(boxOf(i)) > cx(b)) for (const p of strokes[i]) p.x += extra;
      }
      b = boxOf(ref);
    }
    const w = b.maxX - b.minX, h = b.maxY - b.minY;
    if (e.kind === InkEdit.Slash) {
      for (let k = 0; k <= 12; k++) {
        const t = k / 12;
        s.push({ x: b.minX - 0.05 * w + t * 1.1 * w, y: b.minY - 0.1 * h + t * 1.2 * h, w: width(ref) });
      }
    } else { // degree sign: small circle top right next to the digit
      const r = 0.15 * h;
      const c = { x: b.maxX + 0.15 * h + r, y: b.maxY - r, w: width(ref) };
      for (let k = 0; k <= 16; k++) {
        const t = (2 * Math.PI * k) / 16 + Math.PI / 2;
        s.push({ x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t), w: c.w });
      }
    }
    strokes.push(s);
    mine.push(strokes.length - 1);
    origins.push(ref);
  }
  return origins;
}
