// "Hold to straighten" in scribbles: finds a line, circle or rectangle in a freehand stroke.
// Pure math in sheet coordinates (2D, any unit, all tolerances are relative). Ported 1:1 from MyCAD ScribbleShapes.h.
// Points are plain {x, y} and never mutated; results may share point objects with the input.

/** Same numbers as MyCAD's Design::Scribble::Kind. */
export const Kind = Object.freeze({
  Free: 0,
  Line: 1,
  Circle: 2,
  Rectangle: 3,
  Polygon: 4, // here: triangle (4 points, closed)
  Ellipse: 5, // 96 + 1 points, point 0 on one semi-axis, point 24 on the other
  Fill: 6,
  Arc: 7, // circular arc, 48 + 1 points from start to end
});

/** Shape tools that are dragged open. */
export const Drag = Object.freeze({
  Rectangle: 0, // a, b: opposite corners
  Ellipse: 1, // a, b: corners of the bounding box
  Triangle: 2, // a, b: corners of the bounding box, apex at the top middle
  Circle: 3, // a: center, b: on the rim
  Hexagon: 4, // a: center, b: a corner
  Arrow: 5, // a: tail, b: tip; head: length of the tip
});

const free = () => ({ kind: Kind.Free, points: [] });

/** IEEE remainder like std::remainder (ties differ: Math.round rounds up, not to even; never hit by real strokes). */
const remainder = (x, y) => x - y * Math.round(x / y);

export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function length(p) {
  let l = 0;
  for (let i = 1; i < p.length; i++) l += dist(p[i - 1], p[i]);
  return l;
}

/** n points evenly spaced by path length: slowly drawn parts get no extra weight. */
export function resample(p, n) {
  const total = length(p);
  if (p.length < 2 || total <= 0 || n < 2) return p;
  p = p.slice();
  const step = total / (n - 1);
  const out = [p[0]];
  let walked = 0;
  for (let i = 1; i < p.length && out.length < n; i++) {
    const d = dist(p[i - 1], p[i]);
    if (d > 0 && walked + d >= step) {
      const t = (step - walked) / d;
      const q = { x: p[i - 1].x + t * (p[i].x - p[i - 1].x), y: p[i - 1].y + t * (p[i].y - p[i - 1].y) };
      out.push(q);
      p.splice(i, 0, q);
      walked = 0;
    } else {
      walked += d;
    }
  }
  while (out.length < n) out.push(p[p.length - 1]);
  return out;
}

/** Moving average over ±3 points: otherwise jitter makes the path much longer than the stroke. */
export function smooth(p) {
  const out = [];
  for (let i = 0; i < p.length; i++) {
    const from = i < 3 ? 0 : i - 3, to = Math.min(p.length - 1, i + 3);
    let o = { x: 0, y: 0 };
    for (let k = from; k <= to; k++) o = { x: o.x + p[k].x / (to - from + 1), y: o.y + p[k].y / (to - from + 1) };
    out.push(o);
  }
  return out;
}

/** Moves b so that a→b is exactly horizontal or vertical, if it is off by at most tolDeg. */
export function snapAxis(a, b, tolDeg = 5) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const off = Math.atan2(Math.min(Math.abs(dx), Math.abs(dy)), Math.max(Math.abs(dx), Math.abs(dy)));
  if ((off * 180) / Math.PI > tolDeg) return b;
  return Math.abs(dx) >= Math.abs(dy) ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
}

function rotate(p, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return { x: c * p.x - s * p.y, y: s * p.x + c * p.y };
}

/** Box around the points in a frame rotated by angle: min/max in that frame. */
function bounds(pts, angle) {
  let lo = { x: 1e300, y: 1e300 }, hi = { x: -1e300, y: -1e300 };
  for (const q of pts) {
    const r = rotate(q, -angle);
    lo = { x: Math.min(lo.x, r.x), y: Math.min(lo.y, r.y) };
    hi = { x: Math.max(hi.x, r.x), y: Math.max(hi.y, r.y) };
  }
  return { lo, hi };
}

/** Least-squares circle through the points (algebraic, Kåsa): {c, r}, or null if they lie on a line. */
function fitCircle(pts) {
  // x² + y² + D x + E y + F = 0 → 3 × 3 normal equations, solved by Cramer's rule
  let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0, sxz = 0, syz = 0, sz = 0;
  const n = pts.length;
  for (const q of pts) {
    const z = q.x * q.x + q.y * q.y;
    sxx += q.x * q.x; sxy += q.x * q.y; syy += q.y * q.y; sx += q.x; sy += q.y;
    sxz += q.x * z; syz += q.y * z; sz += z;
  }
  const det = (a, b, c, d, e, f, g, h, i) => a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  const m = det(sxx, sxy, sx, sxy, syy, sy, sx, sy, n);
  if (Math.abs(m) < 1e-12) return null;
  const D = det(-sxz, sxy, sx, -syz, syy, sy, -sz, sy, n) / m;
  const E = det(sxx, -sxz, sx, sxy, -syz, sy, sx, -sz, n) / m;
  const F = det(sxx, sxy, -sxz, sxy, syy, -syz, sx, sy, -sz) / m;
  const c = { x: -D / 2, y: -E / 2 };
  const rr = c.x * c.x + c.y * c.y - F;
  if (rr <= 0) return null;
  return { c, r: Math.sqrt(rr) };
}

/** Open stroke as a circular arc? All points near the circle and the angle runs one way without turning back. */
function arc(pts) {
  const fit = fitCircle(pts);
  if (!fit) return null;
  const { c, r } = fit;
  let worst = 0, sweep = 0, back = 0;
  for (let i = 0; i < pts.length; i++) {
    worst = Math.max(worst, Math.abs(dist(pts[i], c) - r));
    if (i > 0) {
      let d = Math.atan2(pts[i].y - c.y, pts[i].x - c.x) - Math.atan2(pts[i - 1].y - c.y, pts[i - 1].x - c.x);
      d = remainder(d, 2 * Math.PI);
      sweep += d;
      back += Math.abs(d);
    }
  }
  const span = Math.abs(sweep);
  // flatter than 20° is a jittery line, turning back means a hook or a wave
  if (worst > 0.08 * r || span < (20 * Math.PI) / 180 || span > 1.9 * Math.PI || back > 1.15 * span) return null;
  const t0 = Math.atan2(pts[0].y - c.y, pts[0].x - c.x);
  const out = { kind: Kind.Arc, points: [] };
  const n = 48;
  for (let i = 0; i <= n; i++) {
    const t = t0 + (sweep * i) / n;
    out.points.push({ x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) });
  }
  out.points[0] = pts[0]; // ends exactly on the stroke: they may have snapped there
  out.points[n] = pts[pts.length - 1];
  return out;
}

/**
 * Line (nearly straight) or arc; otherwise, for a closed stroke, rectangle (points on the rim of the smallest
 * enclosing box, all four corners hit), circle (distance to the center nearly constant), ellipse (close to the ellipse
 * in the enclosing box) or triangle (three corners survive simplify). Anything else stays free.
 * Returns {kind, points}: line 2 points; circle, rectangle, ellipse, triangle closed (last = first).
 * ponytail: the tolerances are empirical values for hand-drawn strokes
 */
export function recognize(raw) {
  if (raw.length < 3) return free();
  const len = length(smooth(raw));
  const a = raw[0], b = raw[raw.length - 1];
  const chord = dist(a, b);
  if (len <= 0) return free();
  if (chord > 0.8 * len) {
    let dev = 0;
    for (const q of raw) dev = Math.max(dev, Math.abs((b.x - a.x) * (a.y - q.y) - (a.x - q.x) * (b.y - a.y)) / chord);
    if (dev < 0.06 * chord) return { kind: Kind.Line, points: [a, snapAxis(a, b)] };
  }
  if (chord > 0.25 * len) return arc(resample(raw, 64)) ?? free(); // open: arc, else hook or wave (free)
  const pts = resample(raw, 96);

  // rectangle first: a square has nearly as even distances around its center as a wobbly circle
  let bestAngle = 0, bestArea = 1e300;
  for (let deg = 0; deg < 90; deg++) {
    const { lo, hi } = bounds(pts, (deg * Math.PI) / 180);
    const area = (hi.x - lo.x) * (hi.y - lo.y);
    if (area < bestArea) {
      bestArea = area;
      bestAngle = (deg * Math.PI) / 180;
    }
  }
  if (bestAngle < (6 * Math.PI) / 180 || bestAngle > (84 * Math.PI) / 180) bestAngle = 0; // nearly axis-aligned: exactly
  const { lo, hi } = bounds(pts, bestAngle);
  const w = hi.x - lo.x, h = hi.y - lo.y, side = Math.min(w, h);
  if (side > 0.08 * Math.max(w, h)) {
    let edge = 0;
    for (const q of pts) {
      const r = rotate(q, -bestAngle);
      edge += Math.min(r.x - lo.x, hi.x - r.x, r.y - lo.y, hi.y - r.y);
    }
    const box = [{ x: lo.x, y: lo.y }, { x: hi.x, y: lo.y }, { x: hi.x, y: hi.y }, { x: lo.x, y: hi.y }];
    let allCorners = true;
    for (const c of box) {
      let nearest = 1e300;
      for (const q of pts) nearest = Math.min(nearest, dist(rotate(q, -bestAngle), c));
      allCorners = allCorners && nearest < 0.15 * side;
    }
    if (allCorners && edge / pts.length < 0.06 * side) {
      const points = box.map((c) => rotate(c, bestAngle));
      points.push(points[0]);
      return { kind: Kind.Rectangle, points };
    }
  }

  let c = { x: 0, y: 0 };
  for (const q of pts) c = { x: c.x + q.x / pts.length, y: c.y + q.y / pts.length };
  let mean = 0, sq = 0;
  for (const q of pts) {
    const r = dist(q, c);
    mean += r / pts.length;
    sq += (r * r) / pts.length;
  }
  const sd = Math.sqrt(Math.max(0, sq - mean * mean));
  if (mean > 0 && sd < 0.1 * mean) {
    const points = [];
    const n = 96;
    for (let i = 0; i <= n; i++) {
      const t = (2 * Math.PI * i) / n;
      points.push({ x: c.x + mean * Math.cos(t), y: c.y + mean * Math.sin(t) });
    }
    return { kind: Kind.Circle, points };
  }

  // ellipse: in the smallest enclosing box (rotated as drawn) the points lie close to the ellipse
  {
    const rx = w / 2, ry = h / 2;
    const m = { x: (lo.x + hi.x) / 2, y: (lo.y + hi.y) / 2 };
    let off = 0;
    for (const q of pts) {
      const r = rotate(q, -bestAngle);
      off += Math.abs(Math.hypot((r.x - m.x) / rx, (r.y - m.y) / ry) - 1) / pts.length;
    }
    if (rx > 0 && ry > 0 && side > 0.15 * Math.max(w, h) && off < 0.06) {
      const points = [];
      const n = 96;
      for (let i = 0; i <= n; i++) {
        const t = (2 * Math.PI * i) / n;
        points.push(rotate({ x: m.x + rx * Math.cos(t), y: m.y + ry * Math.sin(t) }, bestAngle));
      }
      return { kind: Kind.Ellipse, points };
    }
  }

  // triangle: three corners survive simplify (the start does not count if it lies mid-side)
  const loop = pts.slice();
  loop[loop.length - 1] = loop[0];
  const corners = simplify(loop, 0.06 * Math.max(w, h));
  if (corners.length > 2) {
    corners.pop(); // = start
    const straight = (a, b, c) => {
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      return Math.abs(cross) < 0.1 * dist(a, b) * dist(b, c); // bend under ~6°
    };
    if (corners.length === 4 && straight(corners[3], corners[0], corners[1])) corners.shift();
    if (corners.length === 3) {
      corners.push(corners[0]);
      return { kind: Kind.Polygon, points: corners };
    }
  }
  return free();
}

/**
 * Points of a dragged shape. Closed shapes end on their first point; circle and ellipse have 96 + 1 points, point 0
 * on the x semi-axis, point 24 on the y semi-axis. The arrow runs tail → tip → wing → wing → tip: one stroke without
 * doubled segments, the head is a closed triangle.
 */
export function dragged(d, a, b, head = 0) {
  const n = 96;
  const round = (c, rx, ry) => {
    const p = [];
    for (let i = 0; i <= n; i++) {
      const t = (2 * Math.PI * i) / n;
      p.push({ x: c.x + rx * Math.cos(t), y: c.y + ry * Math.sin(t) });
    }
    return p;
  };
  const lo = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) }, hi = { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) };
  switch (d) {
    case Drag.Rectangle:
      return [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }, a];
    case Drag.Ellipse:
      return round({ x: (lo.x + hi.x) / 2, y: (lo.y + hi.y) / 2 }, (hi.x - lo.x) / 2, (hi.y - lo.y) / 2);
    case Drag.Triangle:
      return [{ x: lo.x, y: lo.y }, { x: hi.x, y: lo.y }, { x: (lo.x + hi.x) / 2, y: hi.y }, { x: lo.x, y: lo.y }];
    case Drag.Circle:
      return round(a, dist(a, b), dist(a, b));
    case Drag.Hexagon: {
      const p = [];
      for (let i = 0; i <= 6; i++) {
        const r = rotate({ x: b.x - a.x, y: b.y - a.y }, (Math.PI / 3) * (i % 6));
        p.push({ x: a.x + r.x, y: a.y + r.y });
      }
      return p;
    }
    case Drag.Arrow: {
      const len = dist(a, b);
      if (len <= 0) return [a, b];
      const h = Math.min(head, 0.4 * len), ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
      const base = { x: b.x - ux * h, y: b.y - uy * h };
      const w = h * 0.55; // wings ~29° to the shaft each
      return [a, b, { x: base.x - uy * w, y: base.y + ux * w }, { x: base.x + uy * w, y: base.y - ux * w }, b];
    }
  }
  return [a, b];
}

/** Douglas-Peucker: only the points that are more than tol off the line between their neighbours. */
export function simplify(p, tol) {
  if (p.length < 3) return p;
  const keep = new Array(p.length).fill(false);
  keep[0] = keep[p.length - 1] = true;
  const todo = [[0, p.length - 1]];
  while (todo.length) {
    const [a, b] = todo.pop();
    const len = dist(p[a], p[b]);
    let worst = 0, at = a;
    for (let i = a + 1; i < b; i++) {
      const d = len > 0
        ? Math.abs((p[b].x - p[a].x) * (p[a].y - p[i].y) - (p[a].x - p[i].x) * (p[b].y - p[a].y)) / len
        : dist(p[i], p[a]);
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > tol) {
      keep[at] = true;
      todo.push([a, at], [at, b]);
    }
  }
  return p.filter((_, i) => keep[i]);
}

/**
 * Outlined area to fill: without jitter (simplify with tol) and closed. If the stroke runs on past its start, the
 * overhang is cut (at the point in the last third nearest to the start): otherwise the outline would cross itself and
 * the overlap would stay empty. Filled by winding number, so a figure eight or an area circled twice is filled whole.
 */
export function lasso(raw, tol) {
  const p = simplify(raw, tol);
  if (p.length < 3) return p;
  let cut = p.length - 1;
  for (let i = Math.floor((p.length * 2) / 3); i < p.length; i++) {
    if (i > 1 && dist(p[i], p[0]) < dist(p[cut], p[0])) cut = i;
  }
  const out = p.slice(0, cut + 1);
  out.push(out[0]);
  return out;
}
