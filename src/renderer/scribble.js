// The scribble editor: a sheet with a fine dot grid for pen and mouse, as in MyCAD (src/Mod/Design/Gui/Scribble.cpp).
// Pencil, fineliner and marker in five colors, thicker the harder you press; the back of the pen or E erases; holding
// still at the end of a stroke makes it a clean shape; shape tools, fill, select, text. A second after the pen leaves the
// sheet, what was just written is tidied (ScribbleTidy) and read (DE·HTR v2), Ctrl+Z brings back the raw writing.
// Sheet coordinates are CSS pixels at zoom 1 with y down; the tidying and reading work with y up, as in MyCAD.

import { t } from '../shared/i18n.js';
import { dragged, Drag, Kind as ShapeKind, lasso, recognize, snapAxis } from '../shared/scribble-shapes.js';
import { applyInk, correct, looksRead, words } from '../shared/scribble-read.js';
import { bounds, darkRules, fromSvg, scribbleText, strokeMarkup, toSvg } from '../shared/scribble-svg.js';
import { blend, follow, looksLikeWriting, tidy } from '../shared/scribble-tidy.js';
import { icon } from './icons.js';
import { el, menu, promptDialog } from './ui.js';

export const Kind = { ...ShapeKind, Text: 8 };
const INK = '#1D1D1F'; // MyStyle color.label.primary (light): stored in light mode, shown lighter in dark mode
const DARK = { ink: '#F5F5F7', markerAlpha: 0.25 }; // MyStyle color.label.primary (dark) and opacity.markerDark
export const COLORS = [[INK, t('Schwarz')], ['#0088FF', t('Blau')], ['#FF383C', t('Rot')], ['#34C759', t('Grün')], ['#FFCC00', t('Gelb')]];

/** Width in screen pixels at full pressure, share of it at the lightest pressure, opacity of the color */
const NIB = { pencil: { px: 1.8, light: 0.35, alpha: 0.8 }, pen: { px: 2.6, light: 0.45, alpha: 1 }, marker: { px: 16, light: 1, alpha: 0.35 } };
const SNAP_RADIUS = 10; // px: this close the pen must come to a stroke end to snap to it
const ERASE_RADIUS = 10; // px
const HOLD_MS = 450; // hold this still and a stroke becomes a shape
const TEXT_PX = 20; // font size while typing, px (MyStyle typography.desktop.title2)
const TIDY_PAUSE_MS = 1000; // this long without the pen on the sheet, then what was written is tidied
const GLIDE_MS = 250; // this long the strokes glide to their tidied place
const MOUSE_PRESSURE = 0.6;

/**
 * Pressure curve of the tablet: measured on real writing (Huion H640P under KDE, MyCAD tests/projects), even light writing
 * arrives with 0.8 to 1.0 and the line always looked equally thick. Cubed, 0.8 becomes about 0.5, full pressure stays full.
 * ponytail: one curve for all tablets and systems; if one lies differently, a slider in the settings
 */
export const penFeel = (p) => Math.min(Math.max(p, 0), 1) ** 3;

export const TOOLS = {
  pencil: { icon: 'pencil', label: t('Bleistift'), tip: t('Bleistift: eine weiche Linie, dünner, je leichter du drückst') },
  pen: { icon: 'pen', label: t('Fineliner'), tip: t('Fineliner: eine gleichmäßige, dunkle Linie') },
  marker: { icon: 'marker', label: t('Marker'), tip: t('Marker: ein breiter, durchscheinender Strich zum Hervorheben') },
  eraser: { icon: 'eraser', label: t('Radierer'), tip: t('Radierer (E): über Striche wischen entfernt sie. E noch einmal geht zurück zum Stift. Bei Stiften mit Radierer-Ende radiert auch das hintere Ende') },
  select: { icon: 'select', label: t('Auswählen'), tip: t('Auswählen (V): einen Strich antippen oder Striche umranden, dann ziehen. Entf löscht sie, eine Farbe färbt sie um') },
  fill: { icon: 'fill', label: t('Füllen'), tip: t('Füllen: in eine geschlossene Form tippen färbt sie, um eine Fläche herumzeichnen füllt sie') },
  text: { icon: 'text', label: t('Text'), tip: t('Text: aufs Blatt klicken und tippen. Enter oder Esc legt ihn ab, Umschalt+Enter beginnt eine neue Zeile') },
  line: { icon: 'line', label: t('Linie'), tip: t('Linie: vom Anfang zum Ende ziehen. Sie rastet waagerecht, senkrecht und an Strich-Enden ein') },
  arrow: { icon: 'arrow', label: t('Pfeil'), tip: t('Pfeil: vom Ende zur Spitze ziehen') },
  rectangle: { icon: 'rectangle', label: t('Rechteck'), tip: t('Rechteck: von einer Ecke zur gegenüberliegenden ziehen') },
  triangle: { icon: 'triangle', label: t('Dreieck'), tip: t('Dreieck: darüber ziehen, die Spitze zeigt nach oben') },
  hexagon: { icon: 'hexagon', label: t('Sechseck'), tip: t('Sechseck: von der Mitte zu einer Ecke ziehen') },
  circle: { icon: 'circle', label: t('Kreis'), tip: t('Kreis: von der Mitte nach außen ziehen') },
  ellipse: { icon: 'ellipse', label: t('Ellipse'), tip: t('Ellipse: von Ecke zu Ecke darüber ziehen') },
};
const SHAPES = ['line', 'arrow', 'rectangle', 'triangle', 'hexagon', 'circle', 'ellipse'];
const isPen = (tool) => tool === 'pencil' || tool === 'pen' || tool === 'marker';

// ---------------------------------------------------------------- shared by all scribbles, like in MyCAD

const shared = { tool: 'pen', last: 'pen', color: INK, shape: 'line' };
const editors = new Set();
export const currentTool = () => shared.tool;

export function setTool(tool) {
  shared.tool = tool;
  if (isPen(tool)) shared.last = tool;
  if (SHAPES.includes(tool)) shared.shape = tool;
  for (const e of editors) e.toolChanged();
}
export const toggleTool = (tool) => setTool(shared.tool === tool ? shared.last : tool);

// ---------------------------------------------------------------- reading, in a worker

let worker = null;
let readSeq = 0;
const waiting = new Map();
let canRead = true; // until the worker says it has no model

/** Strokes (y up, writing order) → read lines, or null without the model */
function readLines(flat) {
  if (!canRead || !flat.length) return Promise.resolve(canRead ? [] : null);
  if (!worker) {
    worker = new Worker(new URL('./htr-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (data.lines === null) canRead = false;
      waiting.get(data.id)?.(data.lines);
      waiting.delete(data.id);
    };
    worker.onerror = () => { canRead = false; for (const r of waiting.values()) r(null); waiting.clear(); };
  }
  return new Promise((resolve) => {
    const id = ++readSeq;
    waiting.set(id, resolve);
    worker.postMessage({ id, strokes: flat });
  });
}

const flat = (s) => s.points.map((p) => ({ x: p.x, y: -p.y, w: p.w }));
const unflat = (pts) => pts.map((p) => ({ x: p.x, y: -p.y, w: p.w }));
const isWriting = (s) => s.kind === Kind.Free && s.tool !== 'marker';

// ---------------------------------------------------------------- geometry

const distanceToSegment = (p, a, b) => {
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
  const k = len2 > 0 ? Math.min(Math.max(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0), 1) : 0;
  return Math.hypot(p.x - (a.x + dx * k), p.y - (a.y + dy * k));
};
/** Inside by winding number, like Qt::WindingFill: also an eight or an area drawn around twice */
function windingContains(poly, p) {
  let wn = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const side = (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
    if (a.y <= p.y) { if (b.y > p.y && side > 0) wn++; } else if (b.y <= p.y && side < 0) wn--;
  }
  return wn !== 0;
}
const evenOddContains = (poly, p) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
};

/** A typed text: its lines at the size it was typed in, the box around them is its geometry for selecting, moving, erasing. */
const measure = (() => {
  let ctx = null;
  return (text, size) => {
    ctx ??= document.createElement('canvas').getContext('2d');
    ctx.font = `500 ${size}px Inter, sans-serif`;
    return Math.max(...text.split('\n').map((l) => ctx.measureText(l).width), size * 0.05);
  };
})();
function textStroke(text, at, size, color) {
  // the click is on the first line, at half its cap height (Inter: cap 0.727 em, ascent 0.969 em, line 1.21 em)
  const top = at.y + 0.364 * size - 0.969 * size;
  const w = measure(text, size), h = (text.split('\n').length - 1) * 1.21 * size + 1.2 * size;
  const r = [{ x: at.x, y: top }, { x: at.x + w, y: top }, { x: at.x + w, y: top + h }, { x: at.x, y: top + h }];
  return { kind: Kind.Text, tool: 'pen', color, alpha: 1, text, size, points: [...r, r[0]].map((p) => ({ ...p, w: 0 })) };
}

// ---------------------------------------------------------------- the editor

/**
 * Same interface as the other editors (getText, setText, focus, destroy …). onPenButton(key, down) → true if the key has an
 * action (app.js knows the tablet settings); onSheetOnly toggles "Only the Sheet"; settings() gives the current settings.
 */
export function createScribbleEditor({ parent, text, onChange, settings, onPenButton = () => false, onSheetOnly = () => {} }) {
  let strokes = fromSvg(text) ?? [];
  let handwriting = scribbleText(text);
  const undoStack = [], redoStack = [];
  let view = { x: 0, y: 0, zoom: 1 };
  let fitted = false;

  const root = el('div', { class: 'scribble', tabindex: '0', role: 'application', 'aria-label': t('Scribble') });
  root.innerHTML = '<svg class="scribble-sheet" xmlns="http://www.w3.org/2000/svg"><style></style><g class="scribble-sel"></g>'
    + '<g class="scribble-ink"></g><g class="scribble-live"></g><circle class="scribble-snap" r="4.5" visibility="hidden"/></svg>';
  const svg = root.firstChild;
  const [style, selG, inkG, liveG, snapRing] = svg.children;
  const palette = el('div', { class: 'scribble-palette ms-glass ms-glass--capsule', role: 'toolbar', 'aria-label': t('Werkzeuge') });
  const actions = el('div', { class: 'scribble-actions ms-glass ms-glass--capsule', role: 'toolbar', 'aria-label': t('Auswahl'), hidden: true });
  const textInput = el('textarea', { class: 'scribble-type', 'aria-label': t('Text'), spellcheck: 'false' });
  root.append(palette, actions, textInput);
  parent.append(root);

  // running gesture
  let down = false, pointerId = null, gesture = 'pen', pressPos = null, current = null, screen = [], screenLength = 0, mmPerPx = 1;
  let snappedStart = null, start = null, shaped = false, anchor = null, holdTimer = null, erasedFrom = null;
  // selecting and moving
  let selection = [], moving = false, grabFrom = null, moveOffset = { x: 0, y: 0 }, grabCandidate = -1, lassoPts = [];
  // text: typed straight onto the sheet; Enter, Esc, a click beside it or another tool puts it down
  let typing = false, typed = '', typedAt = null, typedSize = TEXT_PX;
  // handwriting: free strokes that follow each other without a long pause are one round of writing
  let writingFrom = -1, writingTo = 0, pauseTimer = null;
  let glide = null;
  let panning = null; // { x, y } of the last pointer position while the view is being dragged
  let panHeld = false; // a tablet key "Pan View" is held: every move drags the view
  let readTimer = null;

  // ---- coordinates
  const sheet = (pos) => ({ x: view.x + pos.x / view.zoom, y: view.y + pos.y / view.zoom });
  const toScreen = (p) => ({ x: (p.x - view.x) * view.zoom, y: (p.y - view.y) * view.zoom });
  const local = (e) => { const r = svg.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const pixelSize = () => 1 / view.zoom;

  // ---- undo: every change is one step; the eraser and moving collect theirs until the pen lifts
  function commit(next) {
    undoStack.push(strokes);
    if (undoStack.length > 500) undoStack.shift();
    redoStack.length = 0;
    strokes = next;
    changed();
  }
  function changed() {
    selection = selection.filter((i) => i < strokes.length);
    paint();
    onChange();
    clearTimeout(readTimer);
    readTimer = setTimeout(rereadAll, 1500);
  }
  function undo() {
    commitText();
    if (!undoStack.length) return;
    endGlide();
    redoStack.push(strokes);
    strokes = undoStack.pop();
    writingFrom = -1;
    changed();
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(strokes);
    strokes = redoStack.pop();
    writingFrom = -1;
    changed();
  }

  // ---- painting
  function shownStroke(i) {
    let s = strokes[i];
    if (moving && selection.includes(i)) s = { ...s, points: s.points.map((p) => ({ ...p, x: p.x + moveOffset.x, y: p.y + moveOffset.y })) };
    if (glide && i >= glide.from && i < glide.from + glide.before.length) {
      const b = glide.before[i - glide.from], k = glide.k;
      s = { ...s, points: s.points.map((p, j) => (b.points[j] ? { x: b.points[j].x + (p.x - b.points[j].x) * k, y: b.points[j].y + (p.y - b.points[j].y) * k, w: b.points[j].w + (p.w - b.points[j].w) * k } : p)) };
    }
    return s;
  }
  function paint() {
    const order = [...strokes.keys()].sort((a, b) => (strokes[b].kind === Kind.Fill) - (strokes[a].kind === Kind.Fill)); // areas first, lines over them
    inkG.innerHTML = order.map((i) => strokeMarkup(shownStroke(i))).join('');
    const all = current ? [...strokes, current] : strokes;
    const colors = [...all, ...COLORS.map(([color]) => ({ color }))];
    style.textContent = darkRules(colors, DARK, ':root[data-theme="dark"] .scribble ')
      + `@media (prefers-color-scheme: dark){${darkRules(colors, DARK, ':root:not([data-theme="light"]) .scribble ')}}`;
    paintSelection();
  }
  function paintView() {
    const w = svg.clientWidth, h = svg.clientHeight;
    svg.setAttribute('viewBox', `${view.x} ${view.y} ${w / view.zoom} ${h / view.zoom}`);
    const grid = 20 * view.zoom; // ponytail: a fixed 20 px dot grid; MyCAD's sheet has its own spacing in mm
    root.style.backgroundSize = `${grid}px ${grid}px`;
    root.style.backgroundPosition = `${-view.x * view.zoom}px ${-view.y * view.zoom}px`;
    svg.style.setProperty('--px', String(1 / view.zoom)); // hairlines: one screen pixel at any zoom
    paintSelection();
  }
  function showLive() {
    liveG.innerHTML = current?.points.length ? strokeMarkup(current) : '';
  }
  function showSnap(p) {
    snapRing.setAttribute('visibility', p ? 'visible' : 'hidden');
    if (p) { snapRing.setAttribute('cx', p.x); snapRing.setAttribute('cy', p.y); snapRing.setAttribute('r', 4.5 / view.zoom); }
  }

  // ---- snapping: open strokes snap at their ends (free, line, arc, arrow)
  function endpoints() {
    const out = [];
    for (const s of strokes) {
      if (s.points.length && [Kind.Free, Kind.Line, Kind.Polygon, Kind.Arc].includes(s.kind)) out.push(s.points[0], s.points[s.points.length - 1]);
    }
    return out;
  }
  function snapEndpoint(pos, includeCurrent) {
    let best = null, bestDist = SNAP_RADIUS;
    const consider = (p) => {
      const s = toScreen(p), d = Math.hypot(s.x - pos.x, s.y - pos.y);
      if (d < bestDist) { bestDist = d; best = { x: p.x, y: p.y }; }
    };
    for (const p of endpoints()) consider(p);
    // its own start only once the stroke is longer: so an outline closes
    if (includeCurrent && current?.points.length && screenLength > 4 * SNAP_RADIUS) consider(current.points[0]);
    return best;
  }

  // ---- hits
  const screenPolygon = (s) => s.points.map(toScreen);
  function hits(s, pos) {
    const poly = screenPolygon(s);
    for (let i = 0; i < poly.length; i++) if (distanceToSegment(pos, poly[Math.max(i - 1, 0)], poly[i]) < ERASE_RADIUS) return true;
    return (s.kind === Kind.Fill && windingContains(poly, pos)) || (s.kind === Kind.Text && evenOddContains(poly, pos));
  }
  function hitStroke(pos) {
    for (let i = strokes.length - 1; i >= 0; i--) if (strokes[i].kind !== Kind.Fill && hits(strokes[i], pos)) return i; // lines in front of areas
    for (let i = strokes.length - 1; i >= 0; i--) if (hits(strokes[i], pos)) return i;
    return -1;
  }
  function selectionBox() {
    if (!selection.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const i of selection) for (const p of screenPolygon(strokes[i])) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    return { x0: x0 - 8, y0: y0 - 8, x1: x1 + 8, y1: y1 + 8 };
  }
  const inBox = (b, p) => b && p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1;

  // ---- selection: an accent glow under every stroke and a dashed frame around all of them
  function paintSelection() {
    const off = moving ? moveOffset : { x: 0, y: 0 };
    let out = '';
    for (const i of selection) {
      const s = strokes[i];
      if (!s) continue;
      const w = (s.points.reduce((a, p) => a + p.w, 0) / s.points.length) + 8 / view.zoom;
      out += `<path class="scribble-glow" stroke-width="${w}" d="M${s.points.map((p) => `${p.x + off.x} ${p.y + off.y}`).join('L')}"/>`;
    }
    const b = selectionBox();
    if (b) {
      const a = sheet({ x: b.x0, y: b.y0 }), c = sheet({ x: b.x1, y: b.y1 });
      out += `<rect class="scribble-frame" x="${a.x + off.x}" y="${a.y + off.y}" width="${c.x - a.x}" height="${c.y - a.y}"/>`;
    }
    if (lassoPts.length > 1) out += `<path class="scribble-frame" d="M${lassoPts.map((q) => { const p = sheet(q); return `${p.x} ${p.y}`; }).join('L')}"/>`;
    selG.innerHTML = out;
    // bar with colors and delete below the selection; gone while dragging, then at the new place
    actions.hidden = !b || moving || down;
    if (!actions.hidden) {
      const r = root.clientWidth, h = root.clientHeight, aw = actions.offsetWidth || 240, ah = actions.offsetHeight || 44;
      actions.style.left = `${Math.min(Math.max((b.x0 + b.x1) / 2 - aw / 2, 8), r - aw - 8)}px`;
      actions.style.top = `${b.y1 + 8 + ah > h - 72 ? Math.max(b.y0 - ah - 8, 8) : b.y1 + 8}px`;
    }
  }

  // ---- the gesture: press, move, release
  function addPoint(p, pos, pressure) {
    const n = NIB[current.tool];
    current.points.push({ x: p.x, y: p.y, w: n.px * mmPerPx * (n.light + (1 - n.light) * Math.min(Math.max(pressure, 0), 1)) });
    if (screen.length) screenLength += Math.hypot(pos.x - screen[screen.length - 1].x, pos.y - screen[screen.length - 1].y);
    screen.push(pos);
  }

  function press(pos, pressure, eraser) {
    if (pauseTimer) {
      clearTimeout(pauseTimer); // writing on: the pause starts again when the pen lifts
      pauseTimer = null;
      if (!isPen(eraser ? 'eraser' : shared.tool)) tidyWriting(); // something else comes now: tidy what was written first
    }
    endGlide(); // whoever works on sees the result at once; erasing must not fall into a glide
    root.focus({ preventScroll: true });
    down = true;
    pressPos = pos;
    gesture = eraser ? 'eraser' : shared.tool;
    clearTimeout(holdTimer);
    commitText(); // a click beside it puts the typed text down
    if (gesture === 'text') {
      typing = true; typed = ''; typedAt = sheet(pos); typedSize = TEXT_PX / view.zoom;
      textInput.value = '';
      Object.assign(textInput.style, { left: `${pos.x}px`, top: `${pos.y}px` }); // an input method opens its window here
      textInput.focus({ preventScroll: true }); // the pointer event is prevented, so nothing takes the focus back
      showTyped();
      return;
    }
    if (gesture === 'eraser') {
      erasedFrom = strokes;
      erase(pos);
      return;
    }
    if (gesture === 'select') {
      // on the selection or on a stroke: drag (another stroke becomes the selection); otherwise draw around
      const hit = hitStroke(pos);
      if ((hit >= 0 && selection.includes(hit)) || inBox(selectionBox(), pos)) grab(pos);
      else if (hit >= 0) { selection = [hit]; grab(pos); } else { selection = []; lassoPts = [pos]; paintSelection(); }
      return;
    }
    grabCandidate = isPen(gesture) ? hitStroke(pos) : -1;
    const pen = isPen(gesture) ? gesture : shared.last;
    current = { kind: Kind.Free, tool: pen, color: shared.color, alpha: NIB[pen].alpha, points: [] };
    screen = []; screenLength = 0; shaped = false;
    mmPerPx = pixelSize(); // width in pixels: equally thick while drawing, however far zoomed
    snappedStart = snapEndpoint(pos, false);
    addPoint(snappedStart ?? sheet(pos), pos, pressure);
    anchor = pos;
    showSnap(null);
    if (gesture === 'fill') { // drawing around like with the pen, colored like a marker
      Object.assign(current, { tool: 'marker', alpha: NIB.marker.alpha, kind: Kind.Fill });
      return;
    }
    if (!isPen(gesture)) {
      shaped = true; // the shape is fixed from the start, it needs no holding
      current.kind = { line: Kind.Line, rectangle: Kind.Rectangle, circle: Kind.Circle, ellipse: Kind.Ellipse }[gesture] ?? Kind.Polygon;
      start = current.points[0];
      return;
    }
    holdTimer = setTimeout(shapeUp, HOLD_MS);
    showLive();
  }

  function move(pos, pressure) {
    if (gesture === 'eraser') { erase(pos); return; }
    if (gesture === 'text') return;
    if (gesture === 'select') {
      if (moving) { const p = sheet(pos); moveOffset = { x: p.x - grabFrom.x, y: p.y - grabFrom.y }; paint(); } else { lassoPts.push(pos); paintSelection(); }
      return;
    }
    if (!current) return;
    if (!isPen(gesture) && gesture !== 'fill') { updateShape(pos); return; }
    if (shaped) {
      if (current.kind === Kind.Line) updateLineEnd(pos); // the line follows the pen on, snaps to ends and axes
      return;
    }
    const last = screen[screen.length - 1];
    if (Math.hypot(pos.x - last.x, pos.y - last.y) < 1) return; // closer than a pixel brings nothing
    addPoint(sheet(pos), pos, pressure);
    if (isPen(gesture) && Math.hypot(pos.x - anchor.x, pos.y - anchor.y) > 4) {
      anchor = pos;
      clearTimeout(holdTimer);
      holdTimer = setTimeout(shapeUp, HOLD_MS); // moved: holding starts again
    }
    showLive();
  }

  function shapeUp() {
    // holding to grab: the pen has stood still on a stroke since it touched down, now the stroke hangs on the pen
    if (down && isPen(gesture) && grabCandidate >= 0 && screenLength < 4) {
      current = null;
      liveG.innerHTML = '';
      writingFrom = -1; // grabbed instead of written: the round of writing is over, without tidying
      selection = [grabCandidate];
      gesture = 'select';
      grab(pressPos);
      return;
    }
    if (!down || shaped || !current || gesture === 'eraser' || current.points.length < 3) return;
    // recognized in sheet coordinates with y up, as in MyCAD (a triangle points up)
    const shape = recognize(current.points.map((p) => ({ x: p.x, y: -p.y })));
    if (shape.kind === Kind.Free) return;
    const width = current.points.reduce((a, p) => a + p.w, 0) / current.points.length;
    current.points = shape.points.map((q) => ({ x: q.x, y: -q.y, w: width }));
    current.kind = shape.kind;
    shaped = true;
    if (current.kind === Kind.Line) {
      if (snappedStart) current.points[0] = { ...snappedStart, w: width };
      updateLineEnd(screen[screen.length - 1]);
    }
    showLive();
  }

  function updateLineEnd(pos) {
    let end = snapEndpoint(pos, false);
    showSnap(end);
    if (!end) {
      const a = current.points[0], b = sheet(pos);
      const r = snapAxis({ x: a.x, y: -a.y }, { x: b.x, y: -b.y });
      end = { x: r.x, y: -r.y };
    }
    current.points[current.points.length - 1] = { ...end, w: current.points[0].w };
    showLive();
  }

  /** Shape tool while dragging. Line and arrow snap like a line to axes and stroke ends, the others to stroke ends. */
  function updateShape(pos) {
    const width = current.points[0].w;
    let end = null;
    if (gesture === 'line' || gesture === 'arrow') {
      current.points = [start, { ...start }];
      updateLineEnd(pos);
      if (gesture === 'line') return;
      end = current.points[1];
    } else {
      end = snapEndpoint(pos, false);
      showSnap(end);
      end ??= sheet(pos);
    }
    const drag = { rectangle: Drag.Rectangle, ellipse: Drag.Ellipse, triangle: Drag.Triangle, circle: Drag.Circle, hexagon: Drag.Hexagon }[gesture] ?? Drag.Arrow;
    const head = Math.max(18 * mmPerPx, 4 * width); // arrow head: well visible, also with the marker
    current.points = dragged(drag, { x: start.x, y: -start.y }, { x: end.x, y: -end.y }, head).map((q) => ({ x: q.x, y: -q.y, w: width }));
    showLive();
  }

  function release(pos) {
    down = false;
    clearTimeout(holdTimer);
    showSnap(null);
    if (gesture === 'eraser') {
      if (erasedFrom && erasedFrom !== strokes) { undoStack.push(erasedFrom); redoStack.length = 0; changed(); }
      erasedFrom = null;
      return;
    }
    if (gesture === 'text') return;
    if (gesture === 'select') {
      if (moving) {
        moving = false;
        const off = moveOffset;
        moveOffset = { x: 0, y: 0 };
        if (Math.hypot(off.x, off.y) > 1e-9) {
          commit(strokes.map((s, i) => (selection.includes(i) ? { ...s, points: s.points.map((p) => ({ ...p, x: p.x + off.x, y: p.y + off.y })) } : s)));
        }
        if (shared.tool !== 'select') selection = []; // grabbed with the pen: the pen goes on afterwards
        paint();
        return;
      }
      // drawn around: selected is what lies mostly inside
      if (lassoPts.length > 2) {
        selection = strokes.flatMap((s, i) => {
          const poly = screenPolygon(s);
          const inside = poly.filter((q) => evenOddContains(lassoPts, q)).length;
          return poly.length && inside * 10 >= poly.length * 6 ? [i] : [];
        });
      }
      lassoPts = [];
      paintSelection();
      return;
    }
    if (!current?.points.length) return;
    const tapped = Math.hypot(pos.x - pressPos.x, pos.y - pressPos.y) < 3 && screenLength < 6;
    if (gesture === 'fill' && (tapped || current.points.length < 3)) {
      current = null;
      liveG.innerHTML = '';
      if (tapped) fillAt(pos);
      return;
    }
    if (gesture === 'fill') { // the area drawn around: without shaking and overhang, closed
      current.points = lasso(current.points.map((p) => ({ x: p.x, y: p.y })), mmPerPx).map((q) => ({ ...q, w: 0 }));
      if (current.points.length < 3) { current = null; liveG.innerHTML = ''; return; } // hardly moved: no invisible area
    } else if (!isPen(gesture) && tapped) {
      current = null; // only tapped: no shape without a size
      liveG.innerHTML = '';
      return;
    }
    if (!shaped && gesture !== 'fill' && current.points.length > 1) {
      const end = snapEndpoint(pos, true);
      if (end) current.points[current.points.length - 1] = { ...end, w: current.points[current.points.length - 1].w };
    }
    // handwriting: free strokes with fineliner or pencil are collected, a pause tidies them; a shape ends the round
    const writing = isWriting(current);
    if (!writing && writingFrom >= 0) tidyWriting();
    const done = current;
    current = null;
    liveG.innerHTML = '';
    commit([...strokes, done]);
    if (writing) {
      if (writingFrom < 0 || writingTo !== strokes.length - 1) writingFrom = strokes.length - 1;
      writingTo = strokes.length;
      pauseTimer = setTimeout(() => { pauseTimer = null; tidyWriting(); }, TIDY_PAUSE_MS);
    }
  }

  function cancel() {
    if (down && gesture === 'eraser' && erasedFrom && erasedFrom !== strokes) { undoStack.push(erasedFrom); redoStack.length = 0; changed(); }
    down = false; erasedFrom = null;
    clearTimeout(holdTimer);
    current = null; moving = false; moveOffset = { x: 0, y: 0 }; lassoPts = [];
    liveG.innerHTML = '';
    showSnap(null);
    paint();
  }

  function grab(pos) {
    moving = true;
    grabFrom = sheet(pos);
    moveOffset = { x: 0, y: 0 };
    paintSelection();
  }

  function erase(pos) {
    const keep = strokes.filter((s) => !hits(s, pos));
    if (keep.length !== strokes.length) { strokes = keep; selection = []; paint(); }
  }

  /**
   * Tapping with Fill: the smallest closed shape under the pen gets the current color, an area already filled is recolored.
   * ponytail: only single closed strokes (shapes, outlines with a snapped end, fills); areas that several strokes enclose
   * together would need all strokes cut at their crossings
   */
  function fillAt(pos) {
    let best = -1, bestArea = 0;
    strokes.forEach((s, i) => {
      if (s.points.length < 4 || s.kind === Kind.Text) return;
      const poly = screenPolygon(s);
      const gap = Math.hypot(poly[0].x - poly[poly.length - 1].x, poly[0].y - poly[poly.length - 1].y);
      if (gap > 1.5 || !windingContains(poly, pos)) return; // open, or the pen is not inside
      let area = 0;
      for (let k = 1; k < poly.length; k++) area += poly[k - 1].x * poly[k].y - poly[k].x * poly[k - 1].y;
      area = Math.abs(area) / 2;
      // equally large: the fill wins against its outline, so tapping recolors instead of laying a second coat
      if (best < 0 || area < bestArea - 1e-9 || (Math.abs(area - bestArea) <= 1e-9 && s.kind === Kind.Fill)) { best = i; bestArea = area; }
    });
    if (best < 0) return;
    const target = strokes[best], alpha = NIB.marker.alpha;
    commit(target.kind === Kind.Fill
      ? strokes.map((s, i) => (i === best ? { ...s, color: shared.color, alpha } : s))
      : [...strokes, { kind: Kind.Fill, tool: 'marker', color: shared.color, alpha, points: target.points.map((p) => ({ ...p, w: 0 })) }]);
  }

  function hover(pos) {
    const snaps = !['eraser', 'fill', 'select', 'text'].includes(shared.tool);
    showSnap(snaps ? snapEndpoint(pos, false) : null);
    root.classList.toggle('is-over-selection', shared.tool === 'select' && (inBox(selectionBox(), pos) || hitStroke(pos) >= 0));
  }

  // ---- text
  function showTyped() {
    if (!typing) return;
    const s = textStroke(typed || ' ', typedAt, typedSize, shared.color);
    const lines = typed.split('\n');
    const caretX = typedAt.x + measure(lines[lines.length - 1], typedSize) + 1.5 / view.zoom;
    const top = s.points[0].y + (lines.length - 1) * 1.21 * typedSize;
    liveG.innerHTML = (typed ? strokeMarkup({ ...s, text: typed }) : '')
      + `<path class="scribble-caret" d="M${caretX} ${top + 0.15 * typedSize}V${top + 1.15 * typedSize}"/>`;
  }
  function commitText() {
    if (!typing) return;
    typing = false;
    liveG.innerHTML = '';
    if (document.activeElement === textInput) root.focus({ preventScroll: true });
    if (typed.trim()) commit([...strokes, textStroke(typed, typedAt, typedSize, shared.color)]);
  }
  // Typing goes into a hidden text field: so dead keys, AltGr, an input method and pasting work as anywhere else
  textInput.addEventListener('input', () => { typed = textInput.value; showTyped(); });
  textInput.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' && !e.shiftKey && !e.isComposing) || e.key === 'Escape') { e.preventDefault(); commitText(); }
    e.stopPropagation(); // letters are no tool keys while typing
  });

  // ---- colors
  function setColor(color) {
    shared.color = color;
    if (typing) { showTyped(); paintPalette(); return; }
    if (selection.length) { // recolor the selection, every kind of stroke keeps its opacity
      commit(strokes.map((s, i) => (selection.includes(i) ? { ...s, color } : s)));
    } else if (shared.tool === 'eraser') {
      setTool(shared.last); // choosing a color means drawing on
    }
    for (const e of editors) e.toolChanged();
  }
  function deleteSelection() {
    if (!selection.length) return;
    const gone = new Set(selection);
    selection = [];
    commit(strokes.filter((_, i) => !gone.has(i)));
  }

  // ---- view
  function fit() {
    const b = bounds(strokes);
    const w = svg.clientWidth || 800, h = svg.clientHeight || 600;
    if (!b) { view = { x: 0, y: 0, zoom: 1 }; paintView(); return; }
    const m = 48;
    const zoom = Math.min(Math.max(Math.min((w - 2 * m) / Math.max(b.width, 1), (h - 2 * m - 64) / Math.max(b.height, 1)), 0.1), 4);
    view = { zoom, x: b.x + b.width / 2 - w / 2 / zoom, y: b.y + b.height / 2 - (h - 64) / 2 / zoom };
    paintView();
  }
  function zoomAt(pos, factor) {
    const p = sheet(pos);
    const zoom = Math.min(Math.max(view.zoom * factor, 0.1), 8);
    view = { zoom, x: p.x - pos.x / zoom, y: p.y - pos.y / zoom };
    paintView();
    if (typing) showTyped();
  }
  function panBy(dx, dy) {
    view = { ...view, x: view.x - dx / view.zoom, y: view.y - dy / view.zoom };
    paintView();
  }

  // ---- tidying handwriting, like MyCAD's tidyWriting, but the reading waits for the worker
  const sheetWriting = (count) => {
    const index = [];
    for (let i = 0; i < Math.min(count, strokes.length); i++) if (isWriting(strokes[i])) index.push(i);
    return { flat: index.map((i) => flat(strokes[i])), index };
  };
  async function tidyWriting() {
    clearTimeout(pauseTimer);
    pauseTimer = null;
    const from = writingFrom;
    const over = () => { if (writingFrom === from) writingFrom = -1; }; // this round is done, tidied or not
    const s = settings();
    if (from < 0 || strokes.length !== writingTo || down || !s.scribbleTidy) return over();
    const base = strokes;
    const fresh = strokes.slice(from).map(flat);
    const strength = Math.min(Math.max(s.scribbleTidyStrength, 0), 100) / 100;
    const small = looksLikeWriting(fresh, pixelSize());
    if (strength <= 0 || fresh.length < 2 || (!small && !canRead)) return over();
    // The size alone takes a small drawing for writing too: if the model reads no line in it that looks like writing, it
    // stays as it is. With a tablet one writes larger than the limit for writing (up to 230 px instead of 60): a word of
    // three characters or more read with confidence is writing all the same.
    // Reading waits for the worker: whoever writes on meanwhile keeps the round going, and the next pause takes all of it
    const raw = await readLines(fresh);
    const stale = () => strokes !== base || down;
    if (stale()) return undefined;
    if (raw ? !raw.some((l) => looksRead(l, fresh) && (small || l.chars.length >= 3)) : !small) return over();
    // every step can be switched off on its own (Settings › Pen & Handwriting), smoothing also in its strength
    const options = {
      smooth: s.scribbleTidySmooth, smoothing: Math.min(Math.max(s.scribbleTidySmoothing, 1), 30) / 100, straight: s.scribbleTidyStraight,
      size: s.scribbleTidySize, slant: s.scribbleTidySlant, gaps: s.scribbleTidyGaps, width: s.scribbleTidyWidth,
      upright: false, inPlace: false, margin: false, // the left margin is set by follow, also against what was written before
      word: raw ? words(raw, fresh) : [], // written close together ("derPlan"): the model reads the word boundary
    };
    const neat = tidy(fresh, options);
    if (options.straight) { // written on after a pause: as large and on the line as what is already there
      // only what the model reads as writing: nothing joins a drawing beside it.
      // ponytail: reads the whole sheet each time (a few ms per line); on very full sheets only lines near the new ones
      const before = sheetWriting(from).flat;
      const read = before.length ? await readLines(before) : [];
      if (stale()) return undefined;
      follow(neat, before, (read ?? []).filter((l) => looksRead(l, before)).map((l) => l.strokes), options.size);
    }
    const done = neat.map((n, i) => blend(fresh[i], n, strength));
    // CAD notation, when the model is there: what the ink lacks for Ø12, 2×45° or 25 mm comes in its own stroke width;
    // extra: for each new stroke the one it takes pen and color from
    const extra = [];
    for (const line of (await readLines(done)) ?? []) for (const origin of applyInk(done, line, correct(line))) extra.push(origin);
    if (stale()) return undefined;
    over();
    const next = strokes.slice(0, from);
    done.forEach((pts, i) => next.push({ ...strokes[from + (i >= fresh.length ? extra[i - fresh.length] : i)], points: unflat(pts) }));
    glide = { from, before: strokes.slice(from), start: performance.now(), k: 0 };
    commit(next); // undo brings back the raw writing
    if (document.documentElement.dataset.motion === 'reduce' || matchMedia('(prefers-reduced-motion: reduce)').matches) { glide = null; paint(); return; }
    const tick = () => {
      if (!glide) return;
      const x = Math.min((performance.now() - glide.start) / GLIDE_MS, 1);
      glide.k = x * x * (3 - 2 * x); // gently in and out
      paint();
      if (x < 1) requestAnimationFrame(tick); else endGlide();
    };
    requestAnimationFrame(tick);
  }
  function endGlide() {
    if (!glide) return;
    glide = null;
    paint();
  }

  /** All writing on the sheet, read and corrected: the text for the search and the title (<desc>). */
  async function readScribble() {
    const { flat: all, index } = sheetWriting(Infinity);
    const lines = ((await readLines(all)) ?? []).filter((l) => looksRead(l, all));
    for (const l of lines) { correct(l); l.strokes = l.strokes.map((i) => index[i]); }
    return lines;
  }
  async function rereadAll() {
    const base = strokes;
    const text = (await readScribble()).map((l) => l.text).join('\n');
    if (strokes === base && text !== handwriting) { handwriting = text; onChange(); }
  }

  /** Find handwriting: the next line containing q is selected and moved into view. Spaces, case, ø/o and ×/x do not matter. */
  async function find(q) {
    q ??= await promptDialog({ title: t('Handschrift suchen'), placeholder: t('Wort oder Maß'), action: t('Suchen') });
    if (!q) return false;
    const plain = (s) => s.toLowerCase().replace(/ /g, '').replace(/ø/g, 'o').replace(/×/g, 'x');
    const hits = (await readScribble()).filter((l) => plain(l.text).includes(plain(q)));
    if (!hits.length) return false;
    const at = hits.findIndex((h) => selection.length && h.strokes.includes(selection[0]));
    const hit = hits[(at + 1) % hits.length];
    setTool('select'); // the hit is selected: move, recolor or delete it right away
    selection = hit.strokes;
    const b = bounds(selection.map((i) => strokes[i]));
    if (b) view = { ...view, x: b.x + b.width / 2 - svg.clientWidth / 2 / view.zoom, y: b.y + b.height / 2 - svg.clientHeight / 2 / view.zoom };
    paintView();
    return true;
  }

  // ---- the palette
  function paintPalette() {
    palette.replaceChildren();
    const button = (id, { icon: ic, label, tip }, run, pressed) => el('button', {
      class: 'round-btn scribble-tool', 'data-tool': id, title: tip ?? label, 'aria-label': label, 'aria-pressed': String(!!pressed), html: icon(ic), onclick: run,
    });
    for (const id of ['pencil', 'pen', 'marker']) palette.append(button(id, TOOLS[id], () => setTool(id), shared.tool === id));
    palette.append(el('span', { class: 'scribble-sep' }));
    for (const id of ['eraser', 'select', 'fill', 'text']) palette.append(button(id, TOOLS[id], () => (id === 'eraser' || id === 'select' ? toggleTool(id) : setTool(id)), shared.tool === id));
    const shape = SHAPES.includes(shared.tool) ? shared.tool : shared.shape;
    const shapes = button('shapes', { ...TOOLS[shape], label: t('Formen'), tip: TOOLS[shape].tip }, (e) => {
      menu(e.currentTarget, SHAPES.map((id) => ({ label: TOOLS[id].label, run: () => setTool(id) })));
    }, SHAPES.includes(shared.tool));
    palette.append(shapes, el('span', { class: 'scribble-sep' }));
    for (const [c, label] of COLORS) {
      palette.append(el('button', {
        class: 'scribble-color', title: label, 'aria-label': label, 'aria-pressed': String(shared.color === c), style: `--ink:${c}`, 'data-color': c, onclick: () => setColor(c),
      }));
    }
    palette.append(el('span', { class: 'scribble-sep' }));
    palette.append(button('fit', { icon: 'fit', label: t('Blatt einpassen'), tip: t('Blatt einpassen (L): alles auf dem Blatt in den Blick') }, fit));
    palette.append(button('focus', { icon: 'focus', label: t('Nur das Blatt'), tip: t('Nur das Blatt (Tab): Seitenleiste und Tabs klappen weg. Tab noch einmal holt sie zurück') }, onSheetOnly));
    root.dataset.tool = shared.tool;
  }
  function paintActions() {
    actions.replaceChildren(
      ...COLORS.map(([c, label]) => el('button', { class: 'scribble-color', title: label, 'aria-label': label, style: `--ink:${c}`, 'data-color': c, onclick: () => setColor(c) })),
      el('button', { class: 'round-btn', title: t('Löschen (Entf)'), 'aria-label': t('Löschen'), html: icon('trash'), onclick: deleteSelection }),
    );
  }
  paintActions();

  // ---- input. A pen is one pointer: a key pressed while another is down comes as pointermove with button set (chorded).
  // Pen keys: Chromium reports the barrel button as button 2, taken here as the lower one, a second one as button 1.
  // ponytail: unmeasured on the H640P (no tablet at hand); the tablet settings light up the row of the key that was pressed
  const BIT = { 0: 1, 1: 4, 2: 2, 5: 32 };
  let heldPenKey = null, heldKind = false, lastPos = null;
  function pointer(e) {
    const pos = local(e), pen = e.pointerType === 'pen';
    if (e.type === 'pointerdown') svg.setPointerCapture(e.pointerId);
    if (e.button < 0) { // only moved
      if (panning) { panBy(pos.x - panning.x, pos.y - panning.y); panning = pos; return; }
      if (panHeld && lastPos && !down) { panBy(pos.x - lastPos.x, pos.y - lastPos.y); lastPos = pos; return; } // a tablet key "Pan View" is held
      lastPos = pos;
      if (down && e.pointerId === pointerId) {
        for (const c of e.getCoalescedEvents?.() ?? [e]) move(local(c), pen ? penFeel(c.pressure) : MOUSE_PRESSURE);
      } else if (!down && e.buttons === 0) hover(pos);
      return;
    }
    e.preventDefault();
    const pressed = (e.buttons & (BIT[e.button] ?? 0)) !== 0;
    if (pen && (e.button === 1 || e.button === 2)) { // a key on the pen: what the tablet settings say, otherwise dragging the view
      const key = e.button === 2 ? 'penLow' : 'penHigh';
      if (pressed && !heldPenKey) {
        heldPenKey = key;
        heldKind = onPenButton(key, true);
        if (!heldKind && !down) panning = pos;
      } else if (!pressed && heldPenKey === key) {
        onPenButton(key, false);
        heldPenKey = null; heldKind = false; panning = null;
      }
      return;
    }
    if (e.button === 0 || (pen && e.button === 5)) { // the tip, the eraser end, the left mouse button, a finger
      if (pressed) {
        if (down || panning) return;
        // a finger, or the tip with a pen key held that is not "… while held": navigation, not a stroke
        if (e.pointerType === 'touch' || (heldPenKey && heldKind !== 'hold')) { panning = pos; return; }
        pointerId = e.pointerId;
        press(pos, pen ? penFeel(e.pressure) : MOUSE_PRESSURE, pen && (e.button === 5 || (e.buttons & 32) !== 0));
      } else if (down && e.pointerId === pointerId) {
        release(pos);
      } else if (panning && !heldPenKey) {
        panning = null;
      }
      return;
    }
    if (!pen) panning = pressed ? pos : null; // middle or right mouse button: drag the view
  }
  for (const type of ['pointerdown', 'pointermove', 'pointerup']) svg.addEventListener(type, pointer);
  svg.addEventListener('pointercancel', () => { panning = null; heldPenKey = null; if (down) cancel(); });
  svg.addEventListener('contextmenu', (e) => e.preventDefault());
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey) zoomAt(local(e), Math.exp(-e.deltaY * 0.002)); // also the pinch on a trackpad
    else panBy(-e.deltaX, -e.deltaY);
  }, { passive: false });

  root.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    const plain = !(e.ctrlKey || e.metaKey || e.altKey || e.shiftKey);
    const take = (fn) => { e.preventDefault(); e.stopPropagation(); if (!e.repeat && !down) fn(); };
    if ((e.ctrlKey || e.metaKey) && !e.altKey && k === 'z') return take(e.shiftKey ? redo : undo);
    if ((e.ctrlKey || e.metaKey) && !e.altKey && k === 'y') return take(redo);
    // tool keys, also for tablet keys that KDE puts on shortcuts: E eraser, V select, each again back to the pen; L fit; Tab only the sheet
    if (plain && k === 'e') return take(() => toggleTool('eraser'));
    if (plain && k === 'v') return take(() => toggleTool('select'));
    if (plain && k === 'l') return take(fit);
    if (plain && e.key === 'Tab') return take(onSheetOnly);
    if (selection.length && (e.key === 'Delete' || e.key === 'Backspace')) return take(deleteSelection);
    if (selection.length && e.key === 'Escape') return take(() => { selection = []; paintSelection(); });
    // Esc puts shapes, fill, select and text away (back to the pen)
    if (e.key === 'Escape' && !isPen(shared.tool) && shared.tool !== 'eraser') return take(() => setTool(shared.last));
    return undefined;
  });

  const resize = new ResizeObserver(() => { if (!fitted && svg.clientWidth) { fitted = true; fit(); } else paintView(); });
  resize.observe(svg);

  const api = {
    kind: 'scribble',
    getText: () => toSvg(strokes, { text: handwriting, dark: DARK }),
    /** From the history or from outside: one undo step of its own */
    setText(next) {
      cancel();
      undoStack.push(strokes);
      redoStack.length = 0;
      strokes = fromSvg(next) ?? [];
      handwriting = scribbleText(next);
      selection = [];
      paint();
    },
    focus: () => root.focus({ preventScroll: true }),
    destroy() {
      clearTimeout(pauseTimer); clearTimeout(readTimer); clearTimeout(holdTimer);
      resize.disconnect();
      editors.delete(api);
      root.remove();
    },
    setSpellcheck() {},
    setWrap() {},
    setRename() {},
    position: () => `${strokes.length === 1 ? t('1 Strich') : t('{n} Striche', { n: strokes.length })} · ${Math.round(view.zoom * 100)} %`,
    find,
    getCursor: () => ({ pos: 0, scroll: 0, view }),
    setCursor(c) { if (c?.view && Number.isFinite(c.view.zoom)) { view = c.view; fitted = true; paintView(); } },
    toolChanged() {
      if (shared.tool !== 'select' && selection.length) { selection = []; paintSelection(); }
      if (shared.tool !== 'text') commitText();
      showSnap(null);
      paintPalette();
    },
    /** What a tablet key does here (src/shared/tablet.js): run is called on press, for "… while held" also on release */
    run(command) {
      ({
        eraser: () => toggleTool('eraser'), select: () => toggleTool('select'), pencil: () => setTool('pencil'), fineliner: () => setTool('pen'),
        marker: () => setTool('marker'), color: () => setColor(COLORS[(COLORS.findIndex(([c]) => c === shared.color) + 1) % COLORS.length][0]),
        undo, redo, sheet: onSheetOnly, look: fit,
      })[command]?.();
    },
    setPanning(on) { panHeld = on; },
    /** for the tests: the strokes as they are */
    strokes: () => strokes,
    handwriting: () => handwriting,
  };
  editors.add(api);
  paintPalette();
  paint();
  return api;
}
