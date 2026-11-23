// Cases and thresholds 1:1 from MyCAD tests/scribble_tidy_check.cpp.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blend, follow, lines, looksLikeWriting, tidy } from '../src/shared/scribble-tidy.js';

const Xh = 10; // x-height in mm

// print from "o" (circle) and "l" (stroke top to bottom), baseline y = 0, unit x-height
const glyphO = (x) => Array.from({ length: 41 }, (_, i) => {
  const t = (2 * Math.PI * i) / 40;
  return { x: x + 0.4 + 0.35 * Math.cos(t), y: 0.5 + 0.5 * Math.sin(t), w: 0.3 };
});
const glyphL = (x) => Array.from({ length: 31 }, (_, i) => ({ x: x + 0.1, y: 1.7 * (1 - i / 30), w: 0.3 }));

/** line "olo olo olo": every word shifted, sized and slanted differently, the whole line tilted, with hand tremor.
 *  words: [dy, scale, shear] */
function line(baseline, tilt, words) {
  const out = [];
  let cursor = 0, n = 0;
  for (const [dy, scale, shear] of words) {
    for (const s of [glyphO(0), glyphL(0.9), glyphO(1.4)]) {
      for (const p of s) {
        const x = (p.x + p.y * shear) * scale + cursor, y = p.y * scale + dy;
        const jx = 0.03 * Math.sin(++n * 2.3), jy = 0.03 * Math.cos(n * 1.7);
        p.x = Xh * (x * Math.cos(tilt) - y * Math.sin(tilt) + jx);
        p.y = Xh * (x * Math.sin(tilt) + y * Math.cos(tilt) + jy) + baseline;
        p.w *= 1 + 0.5 * Math.sin(n * 0.9); // pressure varies
      }
      out.push(s);
    }
    cursor += 2.2 * scale + 0.9 + 0.4 * (n % 3);
  }
  return out;
}

const bottom = (s) => Math.min(...s.map((p) => p.y));
const height = (s) => Math.max(...s.map((p) => p.y)) - bottom(s);
const left = (S, from, to) => Math.min(...S.slice(from, to).flat().map((p) => p.x));
const right = (S, from, to) => Math.max(...S.slice(from, to).flat().map((p) => p.x));
/** slant of the "l": horizontal offset per height */
const slant = (l) => (l[0].x - l.at(-1).x) / (l[0].y - l.at(-1).y);
const spread = (v) => Math.max(...v) - Math.min(...v);

function measure(S, firstWord, words) {
  const m = { bases: [], sizes: [], slants: [], gaps: [] };
  for (let w = firstWord; w < firstWord + words; w++) {
    const i = 3 * w;
    m.bases.push((bottom(S[i]) + bottom(S[i + 1]) + bottom(S[i + 2])) / 3);
    m.sizes.push((height(S[i]) + height(S[i + 2])) / 2);
    m.slants.push(slant(S[i + 1]));
    if (w > firstWord) m.gaps.push(left(S, i, i + 3) - right(S, i - 3, i));
  }
  return m;
}

const page = [
  ...line(0, 0.07, [[0.3, 1.0, 0.0], [-0.25, 1.35, 0.25], [0.15, 0.8, -0.1]]),
  ...line(-3.2 * Xh, -0.05, [[0.0, 1.1, 0.1], [0.2, 0.9, 0.0], [-0.1, 1.2, 0.15]]),
];
const neat = tidy(page);

test('two messy lines come out straight, even, equally slanted and spaced, at one margin', () => {
  const before = measure(page, 0, 3);
  assert.ok(spread(before.bases) > 3 && spread(before.sizes) > 4 && spread(before.slants) > 0.25);

  assert.equal(neat.length, page.length);
  for (let i = 0; i < page.length; i++) {
    assert.equal(neat[i].length, page[i].length); // same point count: blending works
    for (const p of neat[i]) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.w) && p.w > 0);
  }
  assert.notEqual(neat[0][0], page[0][0]); // new points, the input stays as it was
  for (let l = 0; l < 2; l++) {
    const after = measure(neat, 3 * l, 3);
    assert.ok(spread(after.bases) < 0.1 * Xh); // on one line
    assert.ok(spread(after.sizes) < 0.08 * Xh); // same size
    assert.ok(spread(after.slants) < 0.05); // same slant
    assert.ok(spread(after.gaps) < 0.05 * Xh); // same word gaps
  }
  // two lines stay two lines and start at the same margin
  const lineStep = measure(neat, 0, 1).bases[0] - measure(neat, 3, 1).bases[0];
  assert.ok(lineStep > 2.5 * Xh && lineStep < 4 * Xh);
  assert.ok(Math.abs(left(neat, 0, 9) - left(neat, 9, 18)) < 0.05 * Xh);

  // steadier stroke width
  let lo = Infinity, hi = 0, nlo = Infinity, nhi = 0;
  for (let i = 0; i < page.length; i++) {
    for (let j = 0; j < page[i].length; j++) {
      lo = Math.min(lo, page[i][j].w), hi = Math.max(hi, page[i][j].w);
      nlo = Math.min(nlo, neat[i][j].w), nhi = Math.max(nhi, neat[i][j].w);
    }
  }
  assert.ok(nhi - nlo < 0.3 * (hi - lo));

  // upright instead of the writer's own slant
  for (const s of measure(tidy(page, { upright: true }), 0, 3).slants) assert.ok(Math.abs(s) < 0.05);
});

test('notes spread over the sheet stay where they are, side by side ones too', () => {
  // red pen: corrections spread over the model (one top left, one far right lower, the third last on the left next to
  // it, like Ø4.5 / Ø4.5 / C1). Each is a line of its own, also the left one that came after the right one, and with
  // inPlace each stays where it is. Without, the two lower ones stand almost at the same height next to each other:
  // they stay too, instead of the right one sliding to the left margin onto the other
  const notes = line(0, 0, [[0, 1, 0]]);
  for (const [dx, dy] of [[11.0, -6.4], [1.5, -5.8]]) {
    for (const s of line(dy * 1.6 * Xh, 0, [[0, 1, 0]])) {
      for (const p of s) p.x += dx * 1.6 * Xh;
      notes.push(s);
    }
  }
  assert.equal(lines(notes).length, 3);
  const kept = tidy(notes, { inPlace: true }), moved = tidy(notes);
  for (let n = 0; n < 3; n++) {
    assert.ok(Math.abs(left(kept, 3 * n, 3 * n + 3) - left(notes, 3 * n, 3 * n + 3)) < 0.2 * Xh);
    assert.ok(Math.abs(measure(kept, n, 1).bases[0] - measure(notes, n, 1).bases[0]) < 0.2 * Xh);
  }
  assert.ok(Math.abs(left(moved, 3, 6) - left(notes, 3, 6)) < 0.2 * Xh);
  assert.ok(left(moved, 3, 6) > right(moved, 6, 9)); // not on top of each other

  // tablet: "Das ist ein" and, after a large gap, "Test" at the same height. Two groups; the common left margin used
  // to move "Test" onto "Das"
  const row = line(0, 0, [[0, 1, 0], [0, 1, 0]]);
  for (const s of line(0.1 * Xh, 0, [[0, 1.2, 0.1]])) {
    const dx = right(row, 0, 6) + 5 * Xh;
    for (const p of s) p.x += dx;
    row.push(s);
  }
  assert.equal(lines(row).length, 2);
  const rowNeat = tidy(row);
  assert.ok(left(rowNeat, 6, 9) > right(rowNeat, 0, 6) + 3 * Xh);
});

test('writing on after a pause continues the line before, or starts below it at its margin', () => {
  // the new word, sized differently, higher and with its own gap, lands after its own tidying on baseline and x-height
  // of the line before, with its word gap. A line below starts at its left margin.
  const first = neat.slice(0, 9);
  const had = measure(first, 0, 3);
  const later = line(0, 0.04, [[0.0, 1.4, 0.2]]);
  for (const s of later) {
    for (const p of s) {
      p.x += right(first, 0, 9) + 2.5 * Xh;
      p.y += 0.6 * Xh;
    }
  }
  const under = line(0, 0, [[0, 0.75, 0]]);
  for (const s of under) {
    for (const p of s) {
      p.x += left(first, 0, 9) + 4 * Xh;
      p.y += had.bases[0] - 3 * Xh;
    }
  }
  later.push(...under);
  const fresh = tidy(later, { margin: false }); // like in Scribble.cpp: follow sets the margin
  follow(fresh, first, lines(first));
  const now = measure(fresh, 0, 2);
  assert.ok(Math.abs(now.bases[0] - had.bases[0]) < 0.1 * Xh);
  assert.ok(Math.abs(now.sizes[0] - had.sizes[0]) < 0.1 * Xh);
  assert.ok(Math.abs(left(fresh, 0, 3) - right(first, 0, 9) - had.gaps[0]) < 0.1 * Xh);
  assert.ok(Math.abs(left(fresh, 3, 6) - left(first, 0, 9)) < 0.05 * Xh);
  assert.ok(Math.abs(now.sizes[1] - had.sizes[0]) < 0.1 * Xh);
  // far away or with no writing before: stays where it is
  const far = tidy(line(-20 * Xh, 0, [[0, 1, 0]])), alone = far.map((s) => s.map((p) => ({ ...p })));
  follow(far, first, lines(first));
  follow(alone, [], []);
  assert.ok(left(far, 0, 3) === left(tidy(line(-20 * Xh, 0, [[0, 1, 0]])), 0, 3) && left(alone, 0, 3) === left(far, 0, 3));
});

test('blend, writing or drawing, and degenerate input', () => {
  // strength: half blended lies between before and after
  const half = blend(page[1], neat[1], 0.5);
  assert.ok(Math.abs(half[5].x - (page[1][5].x + neat[1][5].x) / 2) < 1e-9);

  // writing or drawing? 10 mm x-height at 0.5 mm per pixel = 20 px: writing. Two large strokes: none.
  assert.ok(looksLikeWriting(page, 0.5));
  assert.ok(!looksLikeWriting(page, 0.05)); // zoomed in this far it is no longer writing
  assert.ok(!looksLikeWriting([page[1]], 0.5)); // one stroke alone
  assert.deepEqual(tidy([]), []);
  assert.equal(tidy([[{ x: 1, y: 2, w: 0.3 }], [{ x: 4, y: 2, w: 0.3 }]]).length, 2); // only dots: stays whole
});

test('a read line: only recognition decides word boundaries', () => {
  // real tablet writing: gaps inside a word are often as large as between words ("Die s ist"). If recognition reads
  // the line, the gap inside the word stays as it is instead of being evened out as a word gap.
  // Six vertical strokes, 4 tall: word 0 = 0, 2, | 5.5, 7.5, word 1 = 13, 15
  const word = [0.0, 2.0, 5.5, 7.5, 13.0, 15.0].map((x) => [{ x, y: 0, w: 0.3 }, { x, y: 2, w: 0.3 }, { x, y: 4, w: 0.3 }]);
  const only = { smooth: false, straight: false, size: false, slant: false, width: false }; // only the gaps
  const inner = (S) => S[2][0].x - S[1][0].x; // gap inside word 0
  assert.ok(Math.abs(inner(tidy(word, { ...only, word: [0, 0, 0, 0, 1, 1] })) - 3.5) < 1e-9); // one word: gap stays
  assert.ok(Math.abs(inner(tidy(word, only)) - 3.5) > 0.1); // without reading: two words, gap evened out
});

test('stronger smoothing takes a tremor further away', () => {
  const zigzag = Array.from({ length: 41 }, (_, i) => ({ x: i * 0.25, y: (i % 2) * 0.3, w: 0.3 }));
  const one = [zigzag, [{ x: 0, y: 0, w: 0.3 }, { x: 0, y: 4, w: 0.3 }]]; // the second stroke sets the height
  const wobble = (s) => {
    let w = 0;
    for (let i = 1; i + 1 < s.length; i++) w += Math.abs(s[i].y - (s[i - 1].y + s[i + 1].y) / 2);
    return w;
  };
  const soft = { straight: false, size: false, slant: false, gaps: false, width: false, smoothing: 0.05 };
  const strong = { ...soft, smoothing: 0.25 };
  assert.ok(wobble(tidy(one, strong)[0]) < 0.5 * wobble(tidy(one, soft)[0]));
});
