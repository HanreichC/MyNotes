// A scribble as an SVG file: what is drawn comes back exactly, the handwriting read is searchable, dark mode only shows
// colors differently, and a broken file loses only what is broken.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fromSvg, isScribble, scribbleText, shown, textLines, toSvg } from '../src/shared/scribble-svg.js';
import { nameFromText } from '../src/shared/text.js';

const DARK = { ink: '#F5F5F7', markerAlpha: 0.25 };
const strokes = [
  { kind: 0, tool: 'pen', color: '#1D1D1F', alpha: 1, points: [{ x: 1.25, y: 2.5, w: 1.3 }, { x: 4, y: 3, w: 2.6 }, { x: 9.5, y: 2, w: 2.4 }] },
  { kind: 6, tool: 'marker', color: '#FFCC00', alpha: 0.35, points: [{ x: 0, y: 0, w: 0 }, { x: 10, y: 0, w: 0 }, { x: 10, y: 10, w: 0 }, { x: 0, y: 0, w: 0 }] },
  { kind: 0, tool: 'pencil', color: '#0088FF', alpha: 0.8, points: [{ x: -3, y: -4, w: 0.9 }] }, // a dot
  { kind: 8, tool: 'pen', color: '#FF383C', alpha: 1, text: 'Ø12 "<b>" & mehr\nZeile 2', size: 20, points: [{ x: 0, y: 0, w: 0 }, { x: 50, y: 0, w: 0 }, { x: 50, y: 40, w: 0 }, { x: 0, y: 40, w: 0 }, { x: 0, y: 0, w: 0 }] },
];

test('what is drawn comes back exactly, the handwriting as read too', () => {
  const svg = toSvg(strokes, { text: 'Welle 25 mm\nFase <2×45°>', dark: DARK });
  assert.ok(isScribble(svg));
  assert.deepEqual(fromSvg(svg), strokes);
  assert.equal(scribbleText(svg), 'Welle 25 mm\nFase <2×45°>');
  assert.equal(svg.split('\n').filter((l) => l.startsWith('<g ')).length, strokes.length); // one stroke per line: drawing one more changes only the end
  assert.equal(toSvg(fromSvg(svg), { text: scribbleText(svg), dark: DARK }), svg);
});

test('the title is the first handwritten line, the search sees only the handwriting', () => {
  const svg = toSvg(strokes, { text: 'Welle 25 mm\nFase', dark: DARK });
  assert.equal(nameFromText(svg, '.svg'), 'Welle 25 mm');
  assert.equal(nameFromText('<svg xmlns="http://www.w3.org/2000/svg"/>', '.svg'), 'Unbenannt'); // any other SVG keeps its name
  const [from, to] = textLines(svg);
  assert.deepEqual(svg.split('\n').slice(from - 1, to).join('\n').replace(/<\/?desc>/g, ''), 'Welle 25 mm\nFase');
});

test('dark mode: black ink becomes the light label color, other colors lighter with their hue', () => {
  assert.equal(shown('#1D1D1F', DARK), '#F5F5F7');
  const blue = shown('#0088FF', DARK);
  const rgb = [1, 3, 5].map((i) => parseInt(blue.slice(i, i + 2), 16));
  assert.ok(Math.max(...rgb) + Math.min(...rgb) >= 0.7 * 2 * 255 - 2, 'lightness at least 0.7');
  assert.ok(rgb[2] > rgb[1] && rgb[1] > rgb[0], 'still blue');
  assert.match(toSvg(strokes, { dark: DARK }), /@media \(prefers-color-scheme: dark\)\{.*g\[data-color="#1D1D1F"\]\{stroke:#F5F5F7\}/);
});

test('a broken file loses only what is broken; another SVG is no scribble', () => {
  const svg = toSvg(strokes, { dark: DARK });
  const broken = svg.replace('data-points="1.25,2.5,1.3', 'data-points="x,2.5,1.3').replace('data-tool="pencil"', 'data-tool="<script>"');
  assert.deepEqual(fromSvg(broken), [strokes[1], strokes[3]]);
  assert.equal(fromSvg('<svg xmlns="http://www.w3.org/2000/svg"><g data-kind="0"/></svg>'), null);
  assert.deepEqual(fromSvg(toSvg([], { dark: DARK })), []);
});
