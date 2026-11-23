// The CAD notation cases 1:1 from MyCAD tests/scribble_read_check.cpp (checkNotation), plus small hand-made cases for
// looksRead, words and applyInk. The rest of that check reads synthetic handwriting with the real model: ported below
// with its generator, skipped until the model is there. Its red pen part is not ported (red pen is not in MyNotes).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ALPHABET, applyInk, correct, InkEdit, looksRead, words } from '../src/shared/scribble-read.js';
import { lines as tidyLines, tidy } from '../src/shared/scribble-tidy.js';
import * as ort from 'onnxruntime-web';
import { htrModel } from '../build.mjs';
import { read as readHtr } from '../src/shared/htr.js';
import { mt19937, write } from './handwriting.mjs';

/** CAD correction of a text; character x = position in the text */
function fixed(s) {
  const l = { text: s, chars: Array.from({ length: s.length }, (_, i) => ({ c: s[i], x: i, confidence: 1 })), strokes: [] };
  const edits = correct(l);
  assert.equal(l.chars.length, l.text.length);
  return { text: l.text, edits };
}

const has = (edits, kind) => edits.some((e) => e.kind === kind);

test('CAD notation: Ø, ×, °, ±, units and digits in numbers', () => {
  const expect = (input, out) => {
    const { text, edits } = fixed(input);
    assert.equal(text, out);
    return edits;
  };
  assert.ok(has(expect('Bohrung o12', 'Bohrung Ø12'), InkEdit.Slash));
  assert.ok(has(expect('Bohrung b12', 'Bohrung Ø12'), InkEdit.Slash));
  assert.ok(has(expect('012', 'Ø12'), InkEdit.Slash));
  assert.ok(has(expect('Bohrung ol2', 'Bohrung Ø12'), InkEdit.Slash));
  assert.ok(has(expect('D12', 'Ø12'), InkEdit.Slash)); // struck-through circle read as D (applyInk sees the stroke)
  assert.ok(has(expect('DA.5', 'Ø4.5'), InkEdit.Slash)); // Ø4.5: the 4 read as A
  assert.ok(has(expect('BA,5', 'Ø4,5'), InkEdit.Slash));
  assert.deepEqual(expect('Ø4.S', 'Ø4.5'), []); // the 5 after the dot read as S
  assert.ok(has(expect('DA,S', 'Ø4,5'), InkEdit.Slash));
  assert.deepEqual(expect('Bohrung Ø12', 'Bohrung Ø12'), []);
  assert.ok(has(expect('Fase 2xA5', 'Fase 2×45°'), InkEdit.Degree));
  assert.deepEqual(expect('Fase 2x45o', 'Fase 2×45°'), []); // ° was there already, read as o
  assert.deepEqual(expect('Fase 2×45°', 'Fase 2×45°'), []);
  assert.ok(has(expect('Welle 25mm', 'Welle 25 mm'), InkEdit.Space));
  assert.deepEqual(expect('Welle 25 mm', 'Welle 25 mm'), []);
  assert.deepEqual(expect('Toleranz +-0,1', 'Toleranz ±0,1'), []);
  assert.deepEqual(expect('Toleranz +/-0,1', 'Toleranz ±0,1'), []);
  assert.deepEqual(expect('Stift 0,5', 'Stift 0,5'), []);
  assert.deepEqual(expect('Welle', 'Welle'), []);
  assert.deepEqual(expect('Lager l2', 'Lager l2'), []); // at the start of a word a letter stays a letter
  assert.deepEqual(expect('Blech 1S', 'Blech 15'), []);
  assert.deepEqual(expect('Platte 3x4', 'Platte 3×4'), []); // a dimension, no chamfer
  assert.deepEqual(expect('Platte 20x30', 'Platte 20×30'), []);
  assert.ok(has(expect('Kante 1,5x45', 'Kante 1,5×45°'), InkEdit.Degree));
  assert.ok(has(expect('Fase 2x40', 'Fase 2×40°'), InkEdit.Degree));
});

test('the alphabet has the 111 classes of the model', () => {
  assert.equal(ALPHABET.length, 111);
  assert.equal(ALPHABET.slice(52, 69), 'äöüÄÖÜß0123456789');
  assert.ok(ALPHABET.endsWith(' .,;:!?"\'()[]{}<>-–—_/\\@#%&*+=|€§°²³→←↑↓×÷'));
});

// hand-made, not from the C++ check: strokes 1 tall at x = 0, 1, 2, …, chars at given x
const vertical = (x, y = 0, h = 1) => [{ x, y, w: 0.3 }, { x, y: y + h, w: 0.4 }];
const reading = (pairs, strokes, confidence = 0.9) => ({
  text: pairs.map(([c]) => c).join(''),
  chars: pairs.map(([c, x]) => ({ c, x, confidence })),
  strokes,
});
const spelled = (s, strokes, confidence) => reading([...s].map((c, i) => [c, i]), strokes, confidence);

test('looksRead: short readings stay, unsure ones and blocks do not', () => {
  const ink = [0, 1, 2, 3, 4].map((x) => vertical(x));
  assert.ok(looksRead(spelled('ab', [0], 0.1), ink));
  assert.ok(!looksRead(spelled('', [], 0.9), ink));
  assert.ok(looksRead(spelled('abcde', [0, 1, 2, 3, 4], 0.9), ink));
  assert.ok(!looksRead(spelled('abcde', [0, 1, 2, 3, 4], 0.5), ink));
  assert.ok(!looksRead(spelled('abc', [0, 1], 0.9), ink)); // no wider than tall
});

test('words: sure spaces and a capital after two small letters split, an underline gives up', () => {
  const ink = [0, 1, 2, 3, 4].map((x) => vertical(x));
  ink.push(vertical(9, 20)); // outside any line
  for (let x = 0; x < 5; x++) ink.push(vertical(x, -5)); // 6…10
  const first = reading([['ü', 0], ['ß', 1], ['Ä', 2], ['l', 3], [' ', 3.5], ['x', 4]], [0, 1, 2, 3, 4]);
  const second = spelled('MyCAD', [6, 7, 8, 9, 10]); // stays one word, like "kN"
  assert.deepEqual(words([first, second], ink), [0, 0, 1, 1, 2, -1, 3, 3, 3, 3, 3]);
  // an unsure space does not split
  first.chars[4].confidence = 0.4;
  assert.deepEqual(words([first], ink).slice(0, 5), [0, 0, 1, 1, 1]);
  // a stroke across two boundaries (underline): the whole line is left to the gaps
  first.chars[4].confidence = 0.9;
  ink.push([{ x: 0, y: -0.2, w: 0.3 }, { x: 4, y: -0.2, w: 0.3 }]); // 11
  first.strokes.push(11);
  assert.deepEqual(words([first, second], ink), [-1, -1, -1, -1, -1, -1, 3, 3, 3, 3, 3, -1]);
});

const circle = (cx, cy, r) => Array.from({ length: 41 }, (_, i) => {
  const t = (2 * Math.PI * i) / 40;
  return { x: cx + r * Math.cos(t), y: cy + r * Math.sin(t), w: 0.3 };
});

test('applyInk: a gap moves what follows, a degree sign and a slash are new strokes', () => {
  // 25mm → 25 mm
  let ink = [0, 1, 2, 3].map((x) => vertical(x));
  let line = spelled('25mm', [0, 1, 2, 3]);
  assert.deepEqual(applyInk(ink, line, correct(line)), []);
  assert.equal(line.text, '25 mm');
  assert.deepEqual(ink.map((s) => s[0].x), [0, 1, 2.45, 3.45]);

  // 2x45 → 2×45°: a small circle top right of the 5, inheriting from it
  ink = [0, 1, 2, 3].map((x) => vertical(x));
  line = spelled('2x45', [0, 1, 2, 3]);
  assert.deepEqual(applyInk(ink, line, correct(line)), [3]);
  assert.equal(line.text, '2×45°');
  assert.equal(ink.length, 5);
  assert.equal(ink[4].length, 17);
  assert.ok(Math.abs(ink[4][0].x - 3.3) < 1e-9 && Math.abs(ink[4][0].y - 1) < 1e-9 && ink[4][0].w === 0.4);

  // o12 → Ø12: the o grows to the height of the 1, the digits move right, a slash goes through it
  ink = [circle(0.3, 0.3, 0.3), vertical(1), vertical(2)];
  line = reading([['o', 0.3], ['1', 1], ['2', 2]], [0, 1, 2]);
  assert.deepEqual(applyInk(ink, line, correct(line)), [0]);
  assert.equal(line.text, 'Ø12');
  assert.equal(ink.length, 4);
  assert.equal(ink[3].length, 13);
  const ys = ink[0].map((p) => p.y);
  assert.ok(Math.abs(Math.max(...ys) - Math.min(...ys) - 1) < 1e-9);
  assert.ok(ink[1][0].x > 1.19 && ink[2][0].x > 2.19);

  // a written Ø already has its slash: no second one
  ink = [circle(0.3, 0.3, 0.3), vertical(1), vertical(2), [{ x: 0.1, y: 0.1, w: 0.3 }, { x: 0.5, y: 0.5, w: 0.3 }]];
  line = reading([['o', 0.3], ['1', 1], ['2', 2]], [0, 1, 2, 3]);
  assert.deepEqual(applyInk(ink, line, correct(line)), []);
  assert.equal(ink.length, 4);
});

/** share of wrong characters (Levenshtein / length) */
function cer(got, want) {
  const d = Array.from({ length: want.length + 1 }, (_, j) => j);
  for (let i = 1; i <= got.length; i++) {
    let diag = d[0];
    d[0] = i;
    for (let j = 1; j <= want.length; j++) {
      const up = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, diag + (got[i - 1] === want[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return d.at(-1) / Math.max(1, want.length);
}

/** The real model (build.mjs downloads it once); without it, offline, these tests are skipped. */
const model = await htrModel();
const session = model && await ort.InferenceSession.create(model);
const read = (ink) => readHtr(ort, session, ink);
const withModel = session ? test : test.skip;

test('the generator draws like MyCAD: std::mt19937, three lines of synthetic print', () => {
  const g = mt19937(5489);
  for (let k = 1; k < 10000; k++) g();
  assert.equal(g(), 4123659995); // the 10000th value the C++ standard requires
  const ink = write(['Welle 25 mm', 'Fase 2×45°', 'Bohrung Ø12'], 1, 1);
  assert.ok(ink.every((s) => s.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))));
  assert.equal(tidyLines(ink).length, 3);
});

withModel('synthetic print is read, left to right, as writing', async () => {
  // the model does not know Ø: there it is Ø again only after the CAD correction
  const text = ['Welle 25 mm', 'Fase 2×45°', 'Bohrung Ø12'];
  let total = 0, n = 0;
  for (const messy of [0.0, 0.6, 1.0]) {
    for (const seed of [1, 2, 3]) {
      const ink = write(text, messy, seed);
      const lines = await read(ink);
      assert.equal(lines.length, 3); // three lines found
      lines.forEach((l, i) => {
        assert.equal(l.chars.length, l.text.length);
        assert.ok(looksRead(l, ink)); // writing stays writing
        for (let c = 1; c < l.chars.length; c++) assert.ok(l.chars[c].x >= l.chars[c - 1].x); // characters left to right
        total += i < 2 ? cer(l.text, text[i]) : 0;
        n += i < 2 ? 1 : 0;
      });
    }
  }
  assert.ok(total / n < 0.25); // mean character error rate (without the Ø line)
});

withModel('drawings are read too, but do not count as writing', async () => {
  // house: "PoA)", small shapes: "III0n"
  const poly = (pts) => {
    const s = [];
    let prev = pts[0];
    for (const p of pts) {
      for (let k = 1; k <= 10; k++) {
        const t = k / 10;
        s.push({ x: prev[0] + t * (p[0] - prev[0]), y: prev[1] + t * (p[1] - prev[1]), w: 0.5 });
      }
      prev = p;
    }
    return s;
  };
  const ring = (cx, cy, r) => Array.from({ length: 61 }, (_, i) => (
    { x: cx + r * Math.cos(2 * Math.PI * i / 60), y: cy + r * Math.sin(2 * Math.PI * i / 60), w: 0.5 }));
  const drawings = [
    [poly([[0, 0], [40, 0], [40, 30], [0, 30], [0, 0]]), poly([[0, 30], [20, 50], [40, 30]]), ring(12, 18, 5),
      poly([[25, 0], [25, 18], [33, 18], [33, 0]])],
    [poly([[0, 0], [5, 0], [5, 5], [0, 5], [0, 0]]), poly([[10, 0], [15, 5]]), ring(25, 2.5, 2.5),
      poly([[30, 0], [35, 5], [40, 0]])],
  ];
  for (const d of drawings) for (const l of await read(d)) assert.ok(!looksRead(l, d));
});

withModel('o12 without a slash gets one in the ink, a written Ø no second one', async () => {
  let diameters = 0;
  for (const seed of [1, 2, 3]) {
    for (const slashed of [false, true]) {
      const ink = write([slashed ? 'Bohrung Ø12' : 'Bohrung o12'], 0.5, seed);
      const lines = await read(ink);
      assert.equal(lines.length, 1);
      const edits = correct(lines[0]);
      const before = ink.length;
      const origins = applyInk(ink, lines[0], edits);
      assert.equal(origins.length, ink.length - before);
      if (lines[0].text.includes('Ø12')) {
        diameters++;
        assert.equal(ink.length - before, slashed ? 0 : 1);
      }
    }
  }
  assert.ok(diameters >= 4);
});

withModel('a chamfer written without a degree sign gets one in the ink', async () => {
  let degrees = 0;
  for (const seed of [1, 2, 3]) {
    const ink = write(['Fase 2×45'], 0.3, seed);
    const lines = await read(ink);
    assert.equal(lines.length, 1);
    const edits = correct(lines[0]);
    const before = ink.length;
    applyInk(ink, lines[0], edits);
    if (lines[0].text.endsWith('×45°')) {
      degrees++;
      assert.equal(ink.length - before, 1);
    }
  }
  assert.ok(degrees >= 2);
});

withModel('tightly written words are split where the model reads a capital', async () => {
  // below a gap of 0.6 x-height tidy did not split the words. The model reads no space there ("WelleFormRahmen"), but
  // it does read the capital: a word starts there and gets the common word gap. Written normally it splits no word
  const wordGaps = (ink, word, n) => {
    const lo = new Array(n).fill(Infinity), hi = new Array(n).fill(-Infinity), gaps = [];
    ink.forEach((s, i) => {
      for (const p of s) {
        lo[word[i]] = Math.min(lo[word[i]], p.x);
        hi[word[i]] = Math.max(hi[word[i]], p.x);
      }
    });
    for (let k = 1; k < n; k++) gaps.push(lo[k] - hi[k - 1]);
    return gaps;
  };
  let found = 0, mergedBefore = 0;
  for (const gap of [0.55, 0.25, 0.1, 0.0]) {
    for (const seed of [1, 2, 3]) {
      const ink = write(['Welle Form Rahmen Bohrung'], 0.3, seed, gap);
      const word = words(await read(ink), ink);
      const ids = [...new Set(word)].sort((a, b) => a - b);
      assert.ok(ids.length <= 4 && !ids.includes(-1) && ids.at(-1) === ids.length - 1); // never more than written
      const before = wordGaps(tidy(ink), word, ids.length), after = wordGaps(tidy(ink, { word }), word, ids.length);
      if (!after.length) continue;
      const amin = Math.min(...after), amax = Math.max(...after);
      assert.ok(amin > 2 && amax - amin < 0.1); // equal and at least 0.5 x-height (4 mm)
      found += ids.length >= 3 ? 1 : 0; // "Welleform": it often reads the F small
      mergedBefore += Math.min(...before) < 0.6 * amin ? 1 : 0; // stuck together before
    }
  }
  assert.ok(found >= 9 && mergedBefore >= 2);
});
