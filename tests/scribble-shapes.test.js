import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Drag, Kind, dist, dragged, lasso, recognize, simplify, snapAxis } from '../src/shared/scribble-shapes.js';

// hand jitter: even, but not periodic in step with the shape
const jitter = (i, amount) => amount * Math.sin(i * 2.3) * Math.cos(i * 0.7);

function line(a, b, noise) {
  const p = [];
  for (let i = 0; i <= 60; i++) {
    const t = i / 60;
    p.push({ x: a.x + t * (b.x - a.x) + jitter(i, noise), y: a.y + t * (b.y - a.y) + jitter(i + 7, noise) });
  }
  return p;
}

function ellipse(c, rx, ry, noise, sweep = 2 * Math.PI) {
  const p = [];
  for (let i = 0; i <= 120; i++) {
    const t = (sweep * i) / 120;
    p.push({ x: c.x + rx * Math.cos(t) + jitter(i, noise), y: c.y + ry * Math.sin(t) + jitter(i + 3, noise) });
  }
  return p;
}

function rectangle(c, w, h, angle, noise) {
  const corners = [{ x: -w / 2, y: -h / 2 }, { x: w / 2, y: -h / 2 }, { x: w / 2, y: h / 2 }, { x: -w / 2, y: h / 2 }, { x: -w / 2, y: -h / 2 }];
  const p = [];
  let k = 0;
  for (let e = 0; e < 4; e++) {
    for (let i = 0; i < 25; i++, k++) {
      const t = i / 25;
      let q = { x: corners[e].x + t * (corners[e + 1].x - corners[e].x), y: corners[e].y + t * (corners[e + 1].y - corners[e].y) };
      q = { x: Math.cos(angle) * q.x - Math.sin(angle) * q.y, y: Math.sin(angle) * q.x + Math.cos(angle) * q.y };
      p.push({ x: c.x + q.x + jitter(k, noise), y: c.y + q.y + jitter(k + 5, noise) });
    }
  }
  p.push(p[0]);
  return p;
}

const P = (x, y) => ({ x, y });
const closed = (p) => p.length > 3 && dist(p[0], p[p.length - 1]) < 1e-9;
const remainder = (x, y) => x - y * Math.round(x / y);

test('a line is recognized, nearly horizontal snaps, slanted stays slanted', () => {
  let s = recognize(line(P(0, 0), P(100, 4), 0.8));
  assert.ok(s.kind === Kind.Line && s.points.length === 2);
  assert.ok(Math.abs(s.points[1].y - s.points[0].y) < 1e-9); // 2.3° → horizontal
  s = recognize(line(P(0, 0), P(60, 60), 0.8));
  assert.ok(s.kind === Kind.Line && Math.abs(s.points[1].y - 60) < 3);
});

test('a circle, even jittery and slightly overdrawn', () => {
  const s = recognize(ellipse(P(10, 20), 30, 30, 1.0, 2.1 * Math.PI));
  assert.equal(s.kind, Kind.Circle);
  assert.ok(Math.abs(dist(s.points[0], P(10, 20)) - 30) < 2);
  assert.ok(dist(s.points[0], s.points[s.points.length - 1]) < 1e-9);
});

test('rectangle and square (a square is no circle), rotated stays rotated, nearly straight becomes straight', () => {
  let s = recognize(rectangle(P(0, 0), 80, 40, 0, 0.8));
  assert.ok(s.kind === Kind.Rectangle && s.points.length === 5);
  assert.ok(Math.abs(s.points[0].y - s.points[1].y) < 1e-9);
  s = recognize(rectangle(P(0, 0), 50, 50, 0.04, 0.8));
  assert.equal(s.kind, Kind.Rectangle);
  assert.ok(Math.abs(s.points[0].y - s.points[1].y) < 1e-9);
  s = recognize(rectangle(P(0, 0), 80, 40, (30 * Math.PI) / 180, 0.5));
  assert.equal(s.kind, Kind.Rectangle);
  const angle = Math.atan2(s.points[1].y - s.points[0].y, s.points[1].x - s.points[0].x);
  assert.ok(Math.abs(angle - (30 * Math.PI) / 180) < 0.05 || Math.abs(angle + (60 * Math.PI) / 180) < 0.05);
});

test('arc (half and flat), ellipse (also rotated), triangle', () => {
  let s = recognize(ellipse(P(0, 0), 30, 30, 0.5, Math.PI));
  assert.ok(s.kind === Kind.Arc && s.points.length === 49);
  assert.ok(dist(s.points[0], P(30, 0)) < 1.5 && dist(s.points[48], P(-30, 0)) < 1.5);
  assert.ok(Math.abs(dist(s.points[24], P(0, 0)) - 30) < 1 && s.points[24].y > 25); // over the top, not round the bottom
  s = recognize(ellipse(P(0, -100), 100, 100, 0.3, Math.PI / 4)); // 45° arc: chord nearly as long as the arc
  assert.equal(s.kind, Kind.Arc);
  s = recognize(ellipse(P(0, 0), 60, 25, 0.5));
  assert.ok(s.kind === Kind.Ellipse && s.points.length === 97);
  assert.ok(Math.abs(dist(s.points[0], P(0, 0)) - 60) < 2 && Math.abs(dist(s.points[24], P(0, 0)) - 25) < 2);

  const tilted = ellipse(P(0, 0), 50, 20, 0.4).map((q) => P(Math.cos(0.5) * q.x - Math.sin(0.5) * q.y, Math.sin(0.5) * q.x + Math.cos(0.5) * q.y));
  s = recognize(tilted);
  assert.equal(s.kind, Kind.Ellipse);
  const major = Math.max(dist(s.points[0], P(0, 0)), dist(s.points[24], P(0, 0)));
  assert.ok(Math.abs(major - 50) < 2.5);

  const tri = [...line(P(0, 0), P(60, 0), 0.4), ...line(P(60, 0), P(30, 45), 0.4), ...line(P(30, 45), P(0, 0), 0.4)];
  s = recognize(tri);
  assert.ok(s.kind === Kind.Polygon && s.points.length === 4);
  const fromSide = [...tri.slice(30), ...tri.slice(0, 31)]; // started mid base
  s = recognize(fromSide);
  assert.ok(s.kind === Kind.Polygon && s.points.length === 4);
  for (const corner of [P(0, 0), P(60, 0), P(30, 45)]) {
    assert.ok(Math.min(...s.points.map((q) => dist(q, corner))) < 2);
  }
});

test('stays free: hook, zigzag, dot', () => {
  const hook = [...line(P(0, 0), P(50, 0), 0.3), ...line(P(50, 0), P(50, 40), 0.3)];
  assert.equal(recognize(hook).kind, Kind.Free);
  const zigzag = [];
  for (let i = 0; i <= 10; i++) zigzag.push(P(i * 10, i % 2 ? 12 : 0));
  assert.equal(recognize(zigzag).kind, Kind.Free);
  assert.equal(recognize([P(1, 1), P(1, 1), P(1, 1)]).kind, Kind.Free);
});

test('snapping to the axes, and simplify', () => {
  assert.equal(snapAxis(P(0, 0), P(100, 3)).y, 0);
  assert.equal(snapAxis(P(0, 0), P(3, 100)).x, 0);
  assert.equal(snapAxis(P(0, 0), P(100, 30)).y, 30);
  assert.equal(simplify(line(P(0, 0), P(100, 0), 0.1), 1).length, 2);
});

test('dragged shapes: closed, in the right place, ellipse with semi-axes at points 0 and 24', () => {
  let f = dragged(Drag.Rectangle, P(10, 10), P(0, 4));
  assert.ok(f.length === 5 && closed(f) && f[2].x === 0 && f[2].y === 4);
  f = dragged(Drag.Ellipse, P(0, 0), P(20, -10));
  assert.ok(f.length === 97 && closed(f) && Math.abs(f[0].x - 20) < 1e-9 && Math.abs(f[0].y + 5) < 1e-9);
  assert.ok(Math.abs(f[24].x - 10) < 1e-9 && Math.abs(f[24].y) < 1e-9);
  f = dragged(Drag.Triangle, P(0, 10), P(8, 0));
  assert.ok(f.length === 4 && closed(f) && f[2].x === 4 && f[2].y === 10 && f[0].y === 0 && f[1].y === 0); // apex on top
  f = dragged(Drag.Circle, P(5, 5), P(8, 9));
  assert.ok(f.length === 97 && closed(f) && Math.abs(dist(f[37], P(5, 5)) - 5) < 1e-9);
  f = dragged(Drag.Hexagon, P(0, 0), P(0, 10));
  assert.ok(f.length === 7 && closed(f) && dist(f[0], P(0, 10)) < 1e-9 && Math.abs(dist(f[3], P(0, -10))) < 1e-9);
  for (let i = 1; i < f.length; i++) assert.ok(Math.abs(dist(f[i - 1], f[i]) - 10) < 1e-9); // regular: edge = radius
  f = dragged(Drag.Arrow, P(0, 0), P(100, 0), 12);
  assert.ok(f.length === 5 && f[1].x === 100 && f[4].x === 100 && Math.abs(f[2].x - 88) < 1e-9 && f[2].y > 0 && f[3].y < 0);
  assert.ok(Math.abs(dragged(Drag.Arrow, P(0, 0), P(10, 0), 12)[2].x - 6) < 1e-9); // short arrow: head 40 %
});

test('lasso: the overhang past the start is cut, jitter becomes fewer points', () => {
  const loop = ellipse(P(0, 0), 30, 30, 0.3, 2.3 * Math.PI);
  const f = lasso(loop, 0.5);
  assert.ok(closed(f) && f.length < loop.length);
  let swept = 0; // without overlap the outline goes round the center once (with overhang: 2.6 π)
  for (let i = 1; i < f.length; i++) {
    swept += Math.abs(remainder(Math.atan2(f[i].y, f[i].x) - Math.atan2(f[i - 1].y, f[i - 1].x), 2 * Math.PI));
  }
  assert.ok(swept < 2 * Math.PI + 0.5);
  assert.equal(lasso([P(0, 0), P(1, 1)], 0.5).length, 2);
});
