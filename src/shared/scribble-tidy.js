// Neat handwriting in scribbles: tidies it up without reading it. Smooths jitter, straightens lines and spaces them
// evenly, gives every word the same x-height and slant, equal word gaps and a left margin, steadier stroke width. The
// letter shapes stay the writer's own. Every stroke keeps its point count, so before and after can be blended
// (strength, gliding). Pure math in sheet coordinates (2D, y up, any unit). Ported 1:1 from MyCAD ScribbleTidy.h.
// Points are {x, y, w} (w: stroke width at that point), a stroke is an array of points.

export const defaults = {
  smooth: true,
  straight: true,
  size: true,
  slant: true,
  gaps: true,
  width: true,
  /** how strongly to smooth, as a share of the typical stroke height. Measured on real tablet writing: stronger looks
   *  calmer, but recognition reads a little worse (0.10: 25 % character errors, 0.20: 29 %) */
  smoothing: 0.1,
  /** slant: upright instead of the writer's own mean */
  upright: false,
  /** every line stays where it is: no common left margin, no equal line spacing */
  inPlace: false,
  /** all lines at the left margin of this round; without, each starts where it starts and follow aligns it with the
   *  line above (also with what was written before: the continuation of a line stays on the right, where it belongs) */
  margin: true,
  /** per stroke the number of its word as recognition reads it (words in scribble-read.js; empty or -1: not read).
   *  Also splits tightly written words ("derPlan") that otherwise need a gap of 0.6 x-height to be two */
  word: [],
};

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

function quant(a, p) {
  if (!a.length) return 0;
  a = [...a].sort((x, y) => x - y);
  const i = (a.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return a[lo] + (a[hi] - a[lo]) * (i - lo);
}

const median = (a) => quant(a, 0.5);

function box(s) {
  const b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  for (const p of s) {
    b.minX = Math.min(b.minX, p.x);
    b.maxX = Math.max(b.maxX, p.x);
    b.minY = Math.min(b.minY, p.y);
    b.maxY = Math.max(b.maxY, p.y);
  }
  return b;
}

const h = (b) => b.maxY - b.minY;

const copy = (S) => S.map((s) => s.map((p) => ({ ...p })));

const flip = (S) => {
  for (const s of S) for (const p of s) p.y = -p.y;
};

/** Gaussian over arc length: takes out the jitter, towards the ends the stroke stays where it was. Mutates s. */
function smooth(s, sigma) {
  const n = s.length;
  if (n < 3 || sigma <= 0) return;
  const arc = new Array(n).fill(0);
  for (let i = 1; i < n; i++) arc[i] = arc[i - 1] + Math.hypot(s[i].x - s[i - 1].x, s[i].y - s[i - 1].y);
  const out = [];
  for (let i = 0; i < n; i++) {
    let sx = 0, sy = 0, sw = 0, W = 0;
    for (let j = 0; j < n; j++) {
      const d = Math.abs(arc[j] - arc[i]);
      if (d < 3 * sigma) {
        const g = Math.exp((-d * d) / (2 * sigma * sigma));
        sx += g * s[j].x;
        sy += g * s[j].y;
        sw += g * s[j].w;
        W += g;
      }
    }
    const edge = Math.min(1, Math.min(arc[i], arc[n - 1] - arc[i]) / sigma);
    out.push([s[i].x + (sx / W - s[i].x) * edge, s[i].y + (sy / W - s[i].y) * edge, sw / W]);
  }
  out.forEach(([x, y, w], i) => Object.assign(s[i], { x, y, w }));
}

/** typical stroke height (without dots), 0 if there are only dots */
function typicalHeight(S) {
  const hs = [];
  for (const s of S) {
    const v = h(box(s));
    if (v > 0) hs.push(v);
  }
  return quant(hs, 0.6);
}

/** Lines in writing order: a new line when the pen jumps far left and down, or lands far away (above, below or far
 *  right). y down; result sorted top to bottom. */
function groupLines(S, height) {
  const lines = [];
  S.forEach((s, i) => {
    const b = box(s);
    const cy = (b.minY + b.maxY) / 2;
    const L0 = lines.at(-1);
    // far right or left of the line (a gap of more than three character heights, not a word gap) starts something of
    // its own: two red pen corrections at one height are two lines, even if the left one comes second
    if (!L0 || Math.abs(cy - L0.cy) > 1.6 * height
      || (b.minX < L0.maxX - 3 * height && cy > L0.cy + 0.7 * height) || b.minX > L0.maxX + 3 * height
      || b.maxX < L0.minX - 3 * height) {
      lines.push({ idx: [], centers: [], cy: 0, minX: Infinity, maxX: -Infinity });
    }
    const L = lines.at(-1);
    L.idx.push(i);
    L.centers.push(cy);
    L.cy = median(L.centers);
    L.minX = Math.min(L.minX, b.minX);
    L.maxX = Math.max(L.maxX, b.maxX);
  });
  return lines.sort((a, b) => a.cy - b.cy).map((L) => L.idx);
}

/** Lines of the strokes (sheet coordinates, y up), top to bottom, per line the indices of its strokes. */
export function lines(S) {
  S = copy(S);
  flip(S);
  const height = typicalHeight(S);
  return height > 0 ? groupLines(S, height) : [];
}

/** Does the group look like writing? At least two strokes, writing-sized on screen, together not narrower than tall.
 *  unitsPerPx: sheet units per screen pixel. Only the size: with recognition, looksRead decides afterwards whether it
 *  reads as writing. */
export function looksLikeWriting(strokes, unitsPerPx) {
  if (strokes.length < 2 || unitsPerPx <= 0) return false;
  const all = { minX: Infinity, maxX: -Infinity };
  const heights = [];
  for (const s of strokes) {
    const b = box(s);
    heights.push(h(b));
    all.minX = Math.min(all.minX, b.minX);
    all.maxX = Math.max(all.maxX, b.maxX);
  }
  const typical = median(heights);
  const tallest = Math.max(...heights);
  return typical > 0 && typical / unitsPerPx <= 60 && tallest / unitsPerPx <= 150 && all.maxX - all.minX >= typical;
}

/** a, b blended by k (0 = a, 1 = b), point by point; a new stroke with a's point count. */
export const blend = (a, b, k) =>
  a.map((p, i) => (i < b.length
    ? { x: p.x + (b[i].x - p.x) * k, y: p.y + (b[i].y - p.y) * k, w: p.w + (b[i].w - p.w) * k }
    : { ...p }));

/** Strokes in writing order (line by line, left to right) → tidied, same point count per stroke. Returns new arrays. */
export function tidy(strokes, options = {}) {
  const o = { ...defaults, ...options };
  const S = copy(strokes);
  // inside y down like on paper: the baseline is the largest y of a line
  flip(S);
  run(S, o);
  flip(S);
  return S;
}

function run(S, o) {
  const height = typicalHeight(S);
  if (height <= 0) return; // only dots
  if (o.smooth) for (const s of S) smooth(s, o.smoothing * height);
  if (o.width) {
    const m = median(S.flatMap((s) => s.map((p) => p.w)));
    for (const s of S) for (const p of s) p.w = 0.2 * p.w + 0.8 * m;
  }
  if (!(o.straight || o.size || o.slant || o.gaps)) return;
  const B = S.map(box);
  const measure = (idx) => {
    for (const i of idx) B[i] = box(S[i]);
  };
  const each = (idx, f) => {
    for (const i of idx) for (const p of S[i]) f(p);
  };
  /** strokes at least frac as tall as the tallest: without dots, crossbars and commas */
  const tall = (idx, frac) => {
    let mh = 0;
    for (const i of idx) mh = Math.max(mh, h(B[i]));
    const out = idx.filter((i) => h(B[i]) > frac * mh);
    return out.length ? out : idx;
  };
  const bottoms = (idx) => median(idx.map((i) => B[i].maxY));
  const newWord = (i) => ({ idx: [i], minX: B[i].minX, maxX: B[i].maxX, base: 0, size: 0, slant: 0, hasSlant: false });

  // beside: another line stands at the same height next to it, both stay where they are
  const lines = groupLines(S, height).map((idx) => ({ idx, base: 0, xh: 0, words: [], beside: false }));

  for (const L of lines) {
    // tilt of the line: least squares through the stroke bottoms, descenders drop out as outliers
    if (o.straight) {
      let pts = tall(L.idx, 0.4).map((i) => {
        const low = S[i].reduce((a, b) => (a.y < b.y ? b : a)); // first of the largest y, like std::max_element
        return [low.x, low.y];
      });
      let fitted = false, k = 0, mx = 0, my = 0;
      for (let pass = 0; pass < 2 && pts.length >= 3; pass++) {
        mx = my = 0;
        for (const [x, y] of pts) {
          mx += x / pts.length;
          my += y / pts.length;
        }
        let sxx = 0, sxy = 0;
        for (const [x, y] of pts) {
          sxx += (x - mx) * (x - mx);
          sxy += (x - mx) * (y - my);
        }
        k = sxx > 0 ? sxy / sxx : 0;
        fitted = true;
        const keep = pts.filter(([x, y]) => Math.abs(y - (my + k * (x - mx))) < 0.3 * height);
        if (keep.length >= 3) pts = keep;
      }
      if (fitted) {
        const a = -clamp(Math.atan(k), -0.3, 0.3), c = Math.cos(a), s = Math.sin(a);
        each(L.idx, (p) => {
          const x = p.x - mx, y = p.y - my;
          p.x = mx + x * c - y * s;
          p.y = my + x * s + y * c;
        });
        measure(L.idx);
      }
    }
    const t = tall(L.idx, 0.3);
    L.base = bottoms(t);
    L.xh = quant(t.map((i) => L.base - B[i].minY), 0.25);
    // words: horizontally overlapping strokes are one piece (a letter), a large gap separates words. If the whole line
    // was read, only recognition decides (then sorted word by word): in real tablet writing, gaps inside a word are
    // often as large as between words
    const wordOf = (i) => (i < o.word.length ? o.word[i] : -1);
    const read = L.idx.every((i) => wordOf(i) >= 0);
    const same = (a, b) => !read || wordOf(a) === wordOf(b);
    const order = [...L.idx].sort((a, b) => (read && wordOf(a) !== wordOf(b) ? wordOf(a) - wordOf(b) : B[a].minX - B[b].minX));
    const units = [];
    for (const i of order) {
      const u = units.at(-1);
      if (u && B[i].minX <= u.maxX + 0.02 * height && same(i, u.idx[0])) {
        u.idx.push(i);
        u.maxX = Math.max(u.maxX, B[i].maxX);
      } else {
        units.push(newWord(i));
      }
    }
    for (const u of units) {
      const w = L.words.at(-1);
      if (w && (read || u.minX - w.maxX < 0.6 * L.xh) && same(u.idx[0], w.idx[0])) {
        w.idx.push(...u.idx);
        w.maxX = Math.max(w.maxX, u.maxX);
      } else {
        L.words.push(u);
      }
    }
  }
  // groups at the same height (x-heights overlap) are separate notes side by side: moved to the common left margin,
  // they would lie on top of each other
  for (const L of lines) {
    for (const M of lines) L.beside = L.beside || (L !== M && Math.abs(L.base - M.base) < (L.xh + M.xh) / 2);
  }
  const words = lines.flatMap((L) => L.words);
  const lineXh = lines.map((L) => L.xh);
  const pageXh = median(lineXh) > 0 ? median(lineXh) : height;

  // slant per word from the steep stroke pieces (length-weighted median), target: the writer's own or upright
  if (o.slant) {
    const all = [];
    for (const w of words) {
      const v = []; // slant, weight
      let total = 0;
      for (const i of w.idx) {
        const p = S[i];
        for (let j = 3; j < p.length; j += 3) {
          let dx = p[j].x - p[j - 3].x, dy = p[j].y - p[j - 3].y;
          if (dy > 0) {
            dx = -dx;
            dy = -dy;
          }
          const len = Math.hypot(dx, dy);
          if (len > 0 && -dy > 1.3 * Math.abs(dx)) {
            v.push([dx / -dy, len]);
            total += len;
          }
        }
      }
      v.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      let acc = 0;
      for (const [x, wt] of v) {
        acc += wt;
        if (acc >= total / 2) {
          w.slant = x;
          w.hasSlant = true;
          all.push(x);
          break;
        }
      }
    }
    const target = o.upright ? 0 : median(all);
    for (const w of words) {
      if (!w.hasSlant) continue; // nothing steep inside (×, °, -): stays as it is
      const base = bottoms(tall(w.idx, 0.3)), d = w.slant - target;
      each(w.idx, (p) => {
        p.x -= (base - p.y) * d;
      });
      measure(w.idx);
    }
  }
  // size per word: x-height. Words of only digits or capitals measure the cap height.
  // ponytail: cap height = 1.6 x-height fixed; better estimated from the sheet's mixed words
  for (const w of words) {
    const t = tall(w.idx, 0.3);
    w.base = bottoms(t);
    const tops = t.map((i) => w.base - B[i].minY);
    const q25 = quant(tops, 0.25);
    w.size = q25 > 1.3 * pageXh ? Math.max(...tops) / 1.6 : q25;
  }
  if (o.size) {
    const target = median(words.map((w) => w.size));
    for (const w of words) {
      const f = w.size > 0 ? clamp(target / w.size, 0.7, 1.45) : 1;
      let x0 = Infinity;
      for (const i of w.idx) x0 = Math.min(x0, B[i].minX);
      each(w.idx, (p) => {
        p.x = x0 + (p.x - x0) * f;
        p.y = w.base + (p.y - w.base) * f;
      });
      measure(w.idx);
    }
  }
  // words onto the baseline of their line; from three lines on also equal line spacing
  if (o.straight) {
    const stacked = lines.filter((L) => !L.beside); // lines below each other; those side by side keep their height
    const gaps = [];
    for (let i = 1; i < stacked.length; i++) gaps.push(stacked[i].base - stacked[i - 1].base);
    const step = gaps.length > 1 && !o.inPlace ? median(gaps) : 0;
    for (const L of lines) {
      const k = stacked.indexOf(L);
      const target = !L.beside && step > 0 && k > 0 ? stacked[0].base + k * step : L.base;
      for (const w of L.words) {
        const dy = target - w.base;
        each(w.idx, (p) => {
          p.y += dy;
        });
        w.base = target;
        measure(w.idx);
      }
    }
  }
  // equal word gaps, all lines at the same left margin
  if (o.gaps) {
    const left = (w) => Math.min(...w.idx.map((i) => B[i].minX));
    const right = (w) => Math.max(...w.idx.map((i) => B[i].maxX));
    const gaps = [];
    let margin = Infinity;
    for (const L of lines) {
      margin = L.beside ? margin : Math.min(margin, left(L.words[0]));
      for (let i = 1; i < L.words.length; i++) gaps.push(left(L.words[i]) - right(L.words[i - 1]));
    }
    const gap = clamp(gaps.length ? median(gaps) : pageXh, 0.55 * pageXh, 1.1 * pageXh);
    for (const L of lines) {
      let cursor = o.inPlace || !o.margin || L.beside ? left(L.words[0]) : margin;
      for (const w of L.words) {
        const dx = cursor - left(w);
        each(w.idx, (p) => {
          p.x += dx;
        });
        measure(w.idx);
        cursor = right(w) + gap;
      }
    }
  }
}

/** Measures of a line as in tidy (y up): baseline, x-height, extent, typical word gap (0 for one word). */
export function row(S, idx) {
  const r = { base: 0, xh: 0, minX: Infinity, maxX: -Infinity, gap: 0 };
  let tallest = 0;
  for (const i of idx) {
    const b = box(S[i]);
    tallest = Math.max(tallest, h(b));
    r.minX = Math.min(r.minX, b.minX);
    r.maxX = Math.max(r.maxX, b.maxX);
  }
  const bottoms = [], tops = [];
  for (const i of idx) {
    const b = box(S[i]);
    if (h(b) > 0.3 * tallest) {
      bottoms.push(b.minY);
      tops.push(b.maxY);
    }
  }
  r.base = median(bottoms);
  r.xh = quant(tops.map((t) => t - r.base), 0.25);
  // words: gaps from 0.6 x-height between horizontally non-overlapping strokes
  const order = [...idx].sort((a, b) => box(S[a]).minX - box(S[b]).minX);
  const gaps = [];
  let reach = -Infinity;
  for (const i of order) {
    const b = box(S[i]);
    if (reach > -Infinity && b.minX - reach >= 0.6 * r.xh) gaps.push(b.minX - reach);
    reach = Math.max(reach, b.maxX);
  }
  r.gap = gaps.length ? median(gaps) : 0;
  return r;
}

/** Writing on after a pause: tidy only sees the strokes since the last pause. Every line of fresh (just tidied, sheet
 *  coordinates) gets the x-height of the line in before (already there, beforeLines: per line its stroke indices) it
 *  continues: to the right on its baseline with its word gap, or below at its left margin. So what was written with
 *  the pen lifted ends up as even as in one go. resize = false: only align, the size stays. Mutates fresh. */
export function follow(fresh, before, beforeLines, resize = true) {
  before = [...before];
  const rows = beforeLines.map((idx) => row(before, idx));
  for (const idx of lines(fresh)) { // top to bottom: the next one can continue this one
    const F = row(fresh, idx);
    let same = null, above = null;
    for (const C of rows) {
      if (C.xh <= 0) continue;
      if (Math.abs(F.base - C.base) < (F.xh + C.xh) / 2) {
        if (F.minX > C.maxX - C.xh && F.minX < C.maxX + 4 * C.xh && (!same || C.maxX > same.maxX)) same = C;
      } else if (C.base > F.base && C.base - F.base < 4 * C.xh && F.minX < C.maxX && F.maxX > C.minX
        && (!above || C.base < above.base)) {
        above = C;
      }
    }
    const C = same ?? above;
    if (!C || F.xh <= 0) continue;
    const f = resize ? clamp(C.xh / F.xh, 0.7, 1.45) : 1; // like tidy per word
    const x0 = same ? C.maxX + (C.gap > 0 ? C.gap : C.xh) : C.minX;
    const y0 = same ? C.base : F.base;
    for (const i of idx) {
      for (const p of fresh[i]) {
        p.x = x0 + (p.x - F.minX) * f;
        p.y = y0 + (p.y - F.base) * f;
      }
    }
    // into the stock right away: the next line of fresh continues this one
    const added = idx.map((i) => before.push(fresh[i]) - 1);
    rows.push(row(before, added));
  }
}
