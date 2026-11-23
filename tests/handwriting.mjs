// Synthetic handwriting from MyCAD tests/scribble_read_check.cpp, for the read tests and for writing with the emulated pen
// in tests/e2e.mjs. Not a test of its own.

// --- synthetic print, as in the C++ check: Hershey-like polylines in x-height units, y down, baseline 0 ---

/** std::mt19937, and std::uniform_real_distribution<double>(-1, 1) as libstdc++ draws it (generate_canonical from two
 *  32-bit draws), so the seeds give the same handwriting as in MyCAD */
export function mt19937(seed) {
  const mt = new Uint32Array(624);
  let i = 624;
  mt[0] = seed;
  for (let k = 1; k < 624; k++) mt[k] = Math.imul(1812433253, mt[k - 1] ^ (mt[k - 1] >>> 30)) + k;
  return () => {
    if (i >= 624) {
      for (let k = 0; k < 624; k++) {
        const y = (mt[k] & 0x80000000) | (mt[(k + 1) % 624] & 0x7fffffff);
        mt[k] = mt[(k + 397) % 624] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      i = 0;
    }
    let y = mt[i++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  };
}
function uniform(seed) {
  const g = mt19937(seed);
  return () => {
    const lo = g(), hi = g();
    const c = Math.min((lo + hi * 2 ** 32) / 2 ** 64, 1 - 2 ** -53);
    return c * 2 - 1;
  };
}

function arc(cx, cy, rx, ry, t0, t1, n = 14) {
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = (t0 + (t1 - t0) * i / n) * Math.PI / 180;
    return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)];
  });
}
const cat = (a, b) => [...a, ...b];
/** Catmull-Rom through the control points; double points make corners */
function spline(P) {
  const out = [];
  for (let i = 0; i + 1 < P.length; i++) {
    const p0 = P[i ? i - 1 : 0], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)];
    const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    if (len < 1e-9) continue;
    const n = Math.max(2, Math.ceil(len / 0.05));
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      const f = (a0, a1, a2, a3) => 0.5 * (2 * a1 + (-a0 + a2) * t + (2 * a0 - 5 * a1 + 4 * a2 - a3) * t2 + (-a0 + 3 * a1 - 3 * a2 + a3) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(P.at(-1));
  return out;
}

const glyphs = (() => {
  const m = new Map();
  const arch = (x0, x1) => cat(cat([[x0, -.55]], arc((x0 + x1) / 2, -.55, (x1 - x0) / 2, .42, 180, 360, 10)), [[x1, 0]]);
  m.set('o', [.85, [arc(.4, -.5, .32, .5, -80, -430, 20)]]);
  m.set('a', [.9, [arc(.4, -.5, .32, .5, -30, -370, 18), [[.74, -1], [.74, -.3], [.78, -.05], [.88, 0]]]]);
  m.set('e', [.85, [cat([[.1, -.5], [.72, -.52]], arc(.41, -.5, .32, .5, -5, -310, 16))]]);
  m.set('n', [.85, [[[.1, -1], [.1, 0]], arch(.1, .66)]]);
  m.set('m', [1.3, [[[.1, -1], [.1, 0]], arch(.1, .6), arch(.6, 1.1)]]);
  m.set('h', [.85, [[[.1, -1.7], [.1, 0]], arch(.1, .66)]]);
  m.set('r', [.62, [[[.1, -1], [.1, 0]], cat([[.1, -.5]], arc(.38, -.55, .26, .42, 180, 290, 6))]]);
  m.set('u', [.85, [cat([[.1, -1]], arc(.38, -.45, .28, .45, 180, 0, 10)), [[.66, -1], [.66, 0]]]]);
  m.set('g', [.9, [arc(.4, -.5, .32, .5, -30, -370, 18), cat([[.74, -1], [.74, .35]], arc(.42, .35, .32, .3, 0, 150, 8))]]);
  m.set('l', [.45, [cat([[.15, -1.7], [.14, -.25]], arc(.3, -.25, .16, .25, 180, 90, 5))]]);
  m.set('s', [.75, [[[.62, -.88], [.42, -1], [.18, -.9], [.16, -.68], [.4, -.52], [.62, -.35], [.6, -.1], [.38, 0], [.1, -.1]]]]);
  m.set('B', [.85, [[[.1, -1.6], [.1, 0]], [[.1, -1.6], [.45, -1.6], [.65, -1.45], [.63, -1.02], [.4, -.86], [.12, -.86], [.12, -.86], [.5, -.84], [.74, -.6], [.72, -.2], [.5, -.02], [.1, 0]]]]);
  m.set('W', [1.15, [[[0, -1.6], [.27, 0], [.27, 0], [.55, -1.05], [.55, -1.05], [.82, 0], [.82, 0], [1.1, -1.6]]]]);
  m.set('F', [.72, [[[.1, -1.6], [.1, 0]], [[.1, -1.6], [.68, -1.62]], [[.1, -.85], [.52, -.86]]]]);
  m.set('Ø', [1.05, [arc(.5, -.8, .38, .8, -90, -450, 24), [[.05, .12], [.95, -1.72]]]]);
  m.set('1', [.55, [[[.08, -1.25], [.36, -1.6], [.36, -1.6], [.36, 0]]]]);
  m.set('2', [.82, [[[.1, -1.25], [.3, -1.58], [.58, -1.5], [.65, -1.1], [.1, 0], [.1, 0], [.75, 0]]]]);
  m.set('4', [.9, [[[.58, 0], [.58, -1.6], [.58, -1.6], [.05, -.5], [.05, -.5], [.82, -.5]]]]);
  m.set('5', [.8, [[[.68, -1.6], [.18, -1.6], [.18, -1.6], [.13, -.88], [.13, -.88], [.45, -.98], [.7, -.72], [.68, -.22], [.42, 0], [.08, -.14]]]]);
  m.set('R', [.82, [[[.1, 0], [.1, -1.6]], [[.1, -1.6], [.45, -1.6], [.68, -1.42], [.66, -1.0], [.42, -.84], [.1, -.84]], [[.36, -.84], [.76, 0]]]]);
  m.set('M', [1.15, [[[.08, 0], [.12, -1.6], [.12, -1.6], [.55, -.6], [.55, -.6], [.98, -1.6], [.98, -1.6], [1.02, 0]]]]);
  m.set('8', [.8, [arc(.4, -1.22, .24, .36, -90, -450, 14), arc(.4, -.42, .3, .42, -90, -450, 16)]]);
  m.set('3', [.78, [[[.12, -1.5], [.35, -1.62], [.6, -1.5], [.62, -1.15], [.35, -.88], [.62, -.72], [.68, -.35], [.45, -.02], [.12, -.1]]]]);
  m.set('×', [.72, [[[.12, -.82], [.58, -.18]], [[.58, -.82], [.12, -.18]]]]);
  m.set('°', [.42, [arc(.2, -1.45, .13, .16, -90, -450, 12)]]);
  m.set('C', [.85, [arc(.45, -.8, .38, .8, -45, -315, 16)]]);
  m.set('.', [.3, [arc(.12, -.06, .05, .05, -90, -450, 8)]]);
  m.set(',', [.3, [[[.16, -.1], [.14, .05], [.06, .25]]]]);
  for (const [c, [w, strokes]] of m) m.set(c, { w, strokes: strokes.map(spline) });
  return m;
})();

/** text as strokes (sheet coordinates in mm, y up); messy 0 = clean, 1 = scrawl; gap: word gap in x-heights */
export function write(lines, messy, seed, gap = 0.55) {
  const r = uniform(seed);
  const U = 4; // x-height 4 mm
  const out = [];
  lines.forEach((text, li) => {
    const tilt = messy * (r() * 2.5 + 2.5) * Math.PI / 180;
    let cx = 0;
    for (const word of text.split(' ')) {
      const ws = 1 + messy * r() * 0.2, wdy = messy * r() * 0.25, wsl = 0.12 + messy * r() * 0.2;
      let gx = 0;
      for (const ch of word) {
        const g = glyphs.get(ch);
        const gs = 1 + messy * r() * 0.1, grot = messy * r() * 5 * Math.PI / 180;
        const gdx = messy * r() * 0.05, gdy = messy * r() * 0.08;
        for (const st of g.strokes) {
          const s = [];
          let k = 0;
          for (const [x, y] of st) {
            let px = (x - g.w / 2) * gs, py = (y + 0.5) * gs;
            const rx = px * Math.cos(grot) - py * Math.sin(grot), ry = px * Math.sin(grot) + py * Math.cos(grot);
            px = rx + g.w / 2 + gdx + gx, py = ry - 0.5 + gdy;
            px *= ws, py *= ws, px += -py * wsl, py += wdy, px += cx;
            const tx = px * Math.cos(tilt) - py * Math.sin(tilt), ty = px * Math.sin(tilt) + py * Math.cos(tilt);
            const jitter = messy * 0.03 * Math.sin(++k * 1.3 + seed);
            s.push({ x: U * (tx + jitter), y: -U * (ty + jitter) - li * 3.2 * U, w: 0.35 });
          }
          out.push(s);
        }
        gx += g.w * gs + 0.08;
      }
      cx += gx * ws + gap + messy * Math.abs(r()) * 0.5;
    }
  });
  return out;
}
