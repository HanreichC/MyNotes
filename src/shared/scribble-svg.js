// A scribble is a note of its own, stored as SVG (docs/PLAN.md § 10.2): any browser shows it, a Markdown note embeds it as
// an image, and the store keeps it like any text. One stroke per line, so drawing one more changes only the end of the file.
//   <desc> the handwriting as read, one line per line: the search finds it, the title comes from it
//   <g data-kind data-tool data-color data-alpha data-points="x,y,w …"> the raw points (sheet units, y down) and their picture
// Colors are stored as in light mode; dark mode only shows them differently (shown), as in MyCAD.

export const MARK = 'data-mynotes-scribble="1"';
export const isScribble = (text) => typeof text === 'string' && text.slice(0, 400).includes(MARK);

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const num = (v, digits = 2) => String(+v.toFixed(digits));

/** The handwriting read on the sheet, as saved in <desc>. */
export function scribbleText(text) {
  const m = /<desc>([\s\S]*?)<\/desc>/.exec(text);
  return m ? unesc(m[1]) : '';
}

/** Line numbers (1-based, inclusive) of the <desc> text in the file: only these lines are searched. */
export function textLines(text) {
  const lines = text.split('\n');
  const from = lines.findIndex((l) => l.includes('<desc>'));
  const to = lines.findIndex((l) => l.includes('</desc>'));
  return from < 0 || to < from ? null : [from + 1, to + 1];
}

/**
 * How a stored color looks in dark mode (MyCAD shown()): black ink becomes the light label color, every other color keeps
 * its hue and becomes lighter and a little less saturated, or it would glare on the dark sheet or sink into it.
 */
export function shown(color, dark) {
  if (color.toUpperCase() === '#1D1D1F') return dark.ink;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  const h = d === 0 ? 0 : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  const S = s * 0.9, L = Math.max(l, 0.7), C = (1 - Math.abs(2 * L - 1)) * S, X = C * (1 - Math.abs((h % 2) - 1)), m = L - C / 2;
  const [R, G, B] = [[C, X, 0], [X, C, 0], [0, C, X], [0, X, C], [X, 0, C], [C, 0, X]][Math.floor(h) % 6];
  return `#${[R, G, B].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

/** CSS that recolors strokes for dark mode, inside whatever condition the caller wraps it in. */
export function darkRules(strokes, dark, scope = '') {
  const colors = [...new Set(strokes.map((s) => s.color.toUpperCase()))];
  return colors.map((c) => `${scope}g[data-color="${c}"]{stroke:${shown(c, dark)}}${scope}g[data-color="${c}"][data-kind="6"],${scope}g[data-color="${c}"][data-kind="8"]{fill:${shown(c, dark)};stroke:none}`).join('')
    + `${scope}g[data-tool="marker"]{opacity:${dark.markerAlpha}}`;
}

const LINE = 1.21, ASCENT = 0.969; // Inter: line height and ascent in em

/**
 * The picture of one stroke. A pen line changes its width with the pressure, which an SVG stroke cannot: it is drawn in runs
 * of about the same width with round ends, the runs share their end points. Fills are areas, filled by winding number.
 */
export function strokeMarkup(s) {
  const p = s.points;
  const attrs = `data-kind="${s.kind}" data-tool="${s.tool}" data-color="${s.color}" data-alpha="${num(s.alpha)}"`;
  const pts = `data-points="${p.map((q) => `${num(q.x)},${num(q.y)},${num(q.w, 3)}`).join(' ')}"`;
  const xy = (q) => `${num(q.x)} ${num(q.y)}`;
  if (s.kind === 8) { // typed text: the box around it (points) is its geometry, the first point its top left corner
    const lines = s.text.split('\n').map((l, i) => `<tspan x="${num(p[0].x)}" y="${num(p[0].y + (ASCENT + i * LINE) * s.size)}">${esc(l)}</tspan>`).join('');
    return `<g ${attrs} ${pts} data-text="${esc(s.text).replace(/"/g, '&quot;').replace(/\n/g, '&#10;')}" data-size="${num(s.size, 3)}" fill="${s.color}" opacity="${num(s.alpha)}">`
      + `<text font-family="Inter, sans-serif" font-weight="500" font-size="${num(s.size, 3)}" xml:space="preserve">${lines}</text></g>`;
  }
  if (s.kind === 6) {
    return `<g ${attrs} ${pts} fill="${s.color}" opacity="${num(s.alpha)}"><path d="M${p.map(xy).join('L')}Z"/></g>`;
  }
  const runs = [];
  const bucket = (w) => Math.round(Math.log(Math.max(w, 1e-6)) / Math.log(1.08)); // 8 % steps: invisible, few paths
  let from = 0;
  for (let i = 1; i < p.length; i++) {
    if (bucket(p[i].w) !== bucket(p[from].w) || i === p.length - 1) {
      const run = p.slice(from, i + 1);
      runs.push({ w: run.reduce((a, q) => a + q.w, 0) / run.length, pts: run });
      from = i;
    }
  }
  if (p.length === 1) runs.push({ w: p[0].w, pts: [p[0], p[0]] }); // a dot: a zero-length line with round ends
  const paths = runs.map((r) => `<path stroke-width="${num(r.w, 3)}" d="M${r.pts.map(xy).join('L')}"/>`).join('');
  return `<g ${attrs} ${pts} fill="none" stroke="${s.color}" stroke-linecap="round" stroke-linejoin="round" opacity="${num(s.alpha)}">${paths}</g>`;
}

/** Everything the strokes cover, with their widths. */
export function bounds(strokes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) for (const q of s.points) {
    x0 = Math.min(x0, q.x - q.w / 2); y0 = Math.min(y0, q.y - q.w / 2);
    x1 = Math.max(x1, q.x + q.w / 2); y1 = Math.max(y1, q.y + q.w / 2);
  }
  return x0 > x1 ? null : { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** The file. dark: { ink, markerAlpha } from MyStyle, for a viewer in dark mode. */
export function toSvg(strokes, { text = '', dark }) {
  const b = bounds(strokes) ?? { x: 0, y: 0, width: 0, height: 0 };
  const m = 16;
  const box = [b.x - m, b.y - m, b.width + 2 * m, b.height + 2 * m].map((v) => num(v));
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" ${MARK} viewBox="${box.join(' ')}" width="${box[2]}" height="${box[3]}">`,
    `<desc>${esc(text)}</desc>`,
    `<style>@media (prefers-color-scheme: dark){${darkRules(strokes, dark)}}</style>`,
    ...strokes.map(strokeMarkup),
    '</svg>',
    '',
  ].join('\n');
}

/** The strokes of a scribble file; null if the text is not one. What does not parse is left out, the rest stays. */
export function fromSvg(text) {
  if (!isScribble(text)) return null;
  const out = [];
  for (const [tag] of text.matchAll(/<g data-kind="[^>]*>/g)) {
    const a = Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, k, v]) => [k, v]));
    const points = (a['data-points'] ?? '').trim().split(/\s+/).filter(Boolean).map((t) => { const [x, y, w] = t.split(',').map(Number); return { x, y, w }; });
    const s = { kind: Number(a['data-kind']), tool: a['data-tool'], color: (a['data-color'] ?? '').toUpperCase(), alpha: Number(a['data-alpha']), points };
    if (s.kind === 8) Object.assign(s, { text: unesc((a['data-text'] ?? '').replace(/&quot;/g, '"').replace(/&#10;/g, '\n')), size: Number(a['data-size']) });
    const ok = Number.isInteger(s.kind) && s.kind >= 0 && s.kind <= 8 && ['pencil', 'pen', 'marker'].includes(s.tool) && /^#[0-9A-F]{6}$/.test(s.color)
      && Number.isFinite(s.alpha) && points.length && points.every((q) => Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.w))
      && (s.kind !== 8 || (s.text && s.size > 0));
    if (ok) out.push(s);
  }
  return out;
}
