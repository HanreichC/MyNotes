// Reading handwriting offline, as in MyCAD's ScribbleRead.cpp: every line of pen strokes becomes a grayscale picture that
// DE·HTR v2 reads (German handwriting, CTC, 10 MB, Apache-2.0). Runs wherever onnxruntime-web runs: the renderer's worker
// and the tests. Strokes in sheet coordinates with y up, [{x, y, w}], in writing order.

import { lines as groupLines } from './scribble-tidy.js';
import { ALPHABET } from './scribble-read.js';

const HEIGHT = 64; // the model's input height (htr/config.json in MyCAD)
const MAX_WIDTH = 1024;
const STRIDE = 4; // pixels per output step
const MARGIN = 6; // px left and right

/**
 * One line as the model sees it: 64 px high, black on white, 0…1. Sheet x = x0 + pixel / scale.
 * Drawn here instead of with a canvas, so it is the same in the worker and in Node: the distance of each pixel centre to the
 * stroke gives its coverage, which antialiases like QPainter.
 */
export function render(strokes, line) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const widths = [];
  for (const i of line) {
    for (const p of strokes[i]) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      widths.push(p.w);
    }
  }
  if (!widths.length) return null;
  // the whole line with ascenders and descenders fills 80 % of the height, like the lines the model learned from
  let scale = (HEIGHT * 0.8) / Math.max(maxY - minY, 1e-9);
  if ((maxX - minX) * scale + 2 * MARGIN > MAX_WIDTH) scale = (MAX_WIDTH - 2 * MARGIN) / Math.max(maxX - minX, 1e-9); // long line: smaller, but whole
  let width = Math.ceil((maxX - minX) * scale + 2 * MARGIN);
  width = Math.min(Math.max(Math.ceil(width / STRIDE) * STRIDE, 2 * STRIDE), MAX_WIDTH);
  const x0 = minX - MARGIN / scale;
  const cy = (minY + maxY) / 2;
  const at = (p) => [(p.x - x0) * scale, HEIGHT / 2 - (p.y - cy) * scale];
  // stroke width like a scanned ballpoint pen: independent of the zoom, only roughly of the pressure
  widths.sort((a, b) => a - b);
  const r = Math.min(Math.max(widths[widths.length >> 1] * scale, 1.8), 3.0) / 2;

  const ink = new Float32Array(width * HEIGHT);
  const segment = ([ax, ay], [bx, by]) => {
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const x1 = Math.max(0, Math.floor(Math.min(ax, bx) - r - 1)), x2 = Math.min(width - 1, Math.ceil(Math.max(ax, bx) + r + 1));
    const y1 = Math.max(0, Math.floor(Math.min(ay, by) - r - 1)), y2 = Math.min(HEIGHT - 1, Math.ceil(Math.max(ay, by) + r + 1));
    for (let y = y1; y <= y2; y++) {
      for (let x = x1; x <= x2; x++) {
        const px = x + 0.5, py = y + 0.5;
        const t = len2 > 0 ? Math.min(Math.max(((px - ax) * dx + (py - ay) * dy) / len2, 0), 1) : 0;
        const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
        const k = y * width + x;
        ink[k] = Math.max(ink[k], Math.min(Math.max(r + 0.5 - d, 0), 1));
      }
    }
  };
  for (const i of line) {
    const s = strokes[i].map(at);
    if (s.length === 1) segment(s[0], s[0]);
    for (let j = 1; j < s.length; j++) segment(s[j - 1], s[j]);
  }
  const pixels = new Float32Array(width * HEIGHT);
  for (let k = 0; k < pixels.length; k++) pixels[k] = 1 - ink[k]; // white = 1, the model normalizes itself
  return { pixels, width, x0, scale };
}

/** Greedy CTC: per step the likeliest class, repeats and blanks dropped. Confidence = softmax of the winner. */
export function decode(logits, steps, classes, x0, scale) {
  const line = { text: '', chars: [] };
  let prev = 0;
  for (let t = 0; t < steps; t++) {
    const row = logits.subarray(t * classes, (t + 1) * classes);
    let best = 0;
    for (let k = 1; k < classes; k++) if (row[k] > row[best]) best = k;
    if (best !== prev && best > 0 && best <= ALPHABET.length) {
      let sum = 0;
      for (let k = 0; k < classes; k++) sum += Math.exp(row[k] - row[best]);
      const c = ALPHABET[best - 1];
      if (!(c === ' ' && (line.text === '' || line.text.endsWith(' ')))) {
        line.text += c;
        line.chars.push({ c, x: x0 + ((t + 0.5) * STRIDE) / scale, confidence: 1 / sum });
      }
    }
    prev = best;
  }
  while (line.text.endsWith(' ')) { line.text = line.text.slice(0, -1); line.chars.pop(); }
  return line;
}

/** Strokes → read lines from top to bottom: { text, chars: [{ c, x, confidence }], strokes: [indices] } */
export async function read(ort, session, strokes) {
  const out = [];
  for (const idx of groupLines(strokes)) {
    const img = render(strokes, idx);
    if (!img) continue;
    let result;
    try {
      result = await session.run({ image: new ort.Tensor('float32', img.pixels, [1, 1, HEIGHT, img.width]) });
    } catch { continue; }
    const logits = result.logits;
    if (logits.dims.length !== 3) continue;
    const line = decode(logits.data, logits.dims[1], logits.dims[2], img.x0, img.scale);
    if (line.text) out.push({ ...line, strokes: idx });
  }
  return out;
}
