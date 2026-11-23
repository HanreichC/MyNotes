// Grafiktablett messen (docs/PLAN.md § 10.3, Schritt 0): was kommt vom Stift und von den Tasten bei Electron an?
//   npx electron tests/pen-probe.cjs                         Windows, CachyOS mit Wayland
//   npx electron tests/pen-probe.cjs --ozone-platform=x11    CachyOS über XWayland
// Leicht und fest schreiben, jede Taste am Tablett und am Stift drücken, Fenster schließen. Der Bericht steht dann im
// Terminal und als JSON im Temp-Ordner.
// Nur ein Messwerkzeug: die Seite ist eigener, eingebetteter Code, deshalb nodeIntegration ohne Sandbox.

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const report = {
  platform: process.platform, session: process.env.XDG_SESSION_TYPE ?? null, desktop: process.env.XDG_CURRENT_DESKTOP ?? null,
  ozone: app.commandLine.getSwitchValue('ozone-platform') || null, electron: process.versions.electron,
  pads: [], padKeys: [], keys: [], pen: null,
};
let lastPad = 0;

/** capabilities/key: Wörter zu je 64 Bit (unsigned long auf x86_64), das höchste zuerst → gesetzte Tastencodes */
function keyCodes(hex) {
  const codes = [];
  hex.trim().split(/\s+/).reverse().forEach((w, i) => {
    const v = BigInt(`0x${w}`);
    for (let b = 0n; b < 64n; b++) if ((v >> b) & 1n) codes.push(i * 64 + Number(b));
  });
  return codes;
}

/** Tasten am Tablett selbst lesen (Linux): Geräte mit ID_INPUT_TABLET_PAD, struct input_event = 24 Byte */
function readPads(send) {
  if (process.platform !== 'linux') return;
  for (const name of fs.readdirSync('/sys/class/input').filter((n) => /^event\d+$/.test(n))) {
    const sys = `/sys/class/input/${name}`;
    let udev;
    try { udev = fs.readFileSync(`/run/udev/data/c${fs.readFileSync(`${sys}/dev`, 'utf8').trim()}`, 'utf8'); } catch { continue; }
    if (!/^E:ID_INPUT_TABLET_PAD=1$/m.test(udev)) continue;
    const codes = keyCodes(fs.readFileSync(`${sys}/device/capabilities/key`, 'utf8'));
    const pad = { device: `/dev/input/${name}`, name: fs.readFileSync(`${sys}/device/name`, 'utf8').trim(), codes, error: null };
    report.pads.push(pad);
    let rest = Buffer.alloc(0);
    fs.createReadStream(pad.device)
      .on('error', (e) => { pad.error = e.code; send('pads', report.pads); }) // EACCES: udev-Regel fehlt
      .on('data', (chunk) => {
        rest = Buffer.concat([rest, chunk]);
        for (; rest.length >= 24; rest = rest.subarray(24)) {
          if (rest.readUInt16LE(16) !== 1) continue; // nur EV_KEY
          const code = rest.readUInt16LE(18), value = rest.readInt32LE(20);
          lastPad = performance.now();
          const e = { t: Math.round(lastPad), device: pad.name, code, key: codes.indexOf(code) + 1, down: value === 1 };
          report.padKeys.push(e);
          send('pad', e);
        }
      });
  }
  send('pads', report.pads);
}

const page = String.raw`<!doctype html><meta charset="utf-8"><title>Stift messen</title>
<style>
  html, body { margin: 0; height: 100%; font: 14px system-ui, sans-serif; background: #fff; color: #1d1d1f; overflow: hidden; }
  canvas { position: fixed; inset: 0; touch-action: none; }
  pre { position: fixed; left: 12px; top: 12px; margin: 0; padding: 10px 12px; background: #f2f2f7e6; border-radius: 10px;
        pointer-events: none; white-space: pre-wrap; max-width: 46em; }
</style>
<canvas></canvas><pre></pre>
<script>
const { ipcRenderer } = require('electron');
const canvas = document.querySelector('canvas'), out = document.querySelector('pre'), g = canvas.getContext('2d');
const fit = () => { canvas.width = innerWidth * devicePixelRatio; canvas.height = innerHeight * devicePixelRatio; g.scale(devicePixelRatio, devicePixelRatio); };
fit(); addEventListener('resize', fit);
addEventListener('contextmenu', (e) => e.preventDefault());

const types = {}, downButtons = {}, moveButtons = {}, pressures = [];
let hover = 0, events = 0, coalesced = 0, predicted = 0, tilt = false, twist = false, eraser = false;
let strokeStart = 0, strokePoints = 0, strokeTime = 0, last = null, current = '-', pads = [], padLast = '-', keyLast = '-';
const count = (o, k) => { o[k] = (o[k] ?? 0) + 1; };
const q = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return +s[Math.round((s.length - 1) * p)].toFixed(3); };

function summary() {
  const pen = types.pen ?? 0;
  return {
    pointerTypes: types, penDownButtons: downButtons, penMoveButtons: moveButtons, eraserSeen: eraser, tiltSeen: tilt, twistSeen: twist,
    hoverMoves: hover, pressure: { n: pressures.length, min: q(pressures, 0), p10: q(pressures, 0.1), median: q(pressures, 0.5),
      p90: q(pressures, 0.9), max: q(pressures, 1), shareAtLeast08: pressures.length ? +(pressures.filter((p) => p >= 0.8).length / pressures.length).toFixed(3) : null },
    coalescedPerEvent: events ? +(coalesced / events).toFixed(2) : null, predictedPerEvent: events ? +(predicted / events).toFixed(2) : null,
    pointsPerSecond: strokeTime ? Math.round(strokePoints / (strokeTime / 1000)) : null, penEvents: pen,
  };
}
function show() {
  const s = summary();
  out.textContent = 'Leicht und fest schreiben. Jede Taste am Tablett und am Stift drücken (Stift in der Luft und aufgesetzt). Dann das Fenster schließen.\n\n'
    + 'Druck jetzt: ' + current + '   Median: ' + s.pressure.median + '   10–90 %: ' + s.pressure.p10 + '–' + s.pressure.p90 + '   Anteil ≥ 0,8: ' + s.pressure.shareAtLeast08 + '\n'
    + 'Zeigertypen: ' + JSON.stringify(s.pointerTypes) + '   Schweben: ' + s.hoverMoves + '   Neigung: ' + (s.tiltSeen ? 'ja' : 'nein') + '   Radierer-Ende: ' + (s.eraserSeen ? 'ja' : 'nein') + '\n'
    + 'Stift-Tasten (button beim Drücken): ' + JSON.stringify(s.penDownButtons) + '   buttons beim Bewegen: ' + JSON.stringify(s.penMoveButtons) + '\n'
    + 'Punkte/s: ' + s.pointsPerSecond + '   zusammengefasst je Ereignis: ' + s.coalescedPerEvent + '   vorhergesagt: ' + s.predictedPerEvent + '\n'
    + 'Tablett-Tasten (evdev): ' + (pads.length ? pads.map((p) => p.name + (p.error ? ' (' + p.error + ')' : '')).join(', ') : 'keine gefunden') + '   zuletzt: ' + padLast + '\n'
    + 'Tastatur zuletzt: ' + keyLast;
  ipcRenderer.send('pen', s);
}

canvas.addEventListener('pointerdown', (e) => {
  count(types, e.pointerType);
  if (e.pointerType !== 'pen') return;
  count(downButtons, 'button ' + e.button + ' / buttons ' + e.buttons);
  eraser ||= e.button === 5 || (e.buttons & 32) !== 0;
  canvas.setPointerCapture(e.pointerId);
  strokeStart = e.timeStamp; last = { x: e.offsetX, y: e.offsetY };
  show();
});
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'pen') return;
  count(moveButtons, e.buttons);
  if (e.buttons === 0) { hover++; return; }
  const list = e.getCoalescedEvents(), ahead = e.getPredictedEvents();
  events++; coalesced += list.length; predicted += ahead.length;
  for (const c of list.length ? list : [e]) {
    pressures.push(c.pressure);
    tilt ||= c.tiltX !== 0 || c.tiltY !== 0; twist ||= c.twist !== 0;
    if (last && (c.buttons & 1)) {
      g.strokeStyle = (c.buttons & 32) ? '#FF383C' : '#1D1D1F'; g.lineCap = 'round';
      g.lineWidth = 0.6 + 4 * Math.pow(c.pressure, 3); // wie penFeel in MyCAD
      g.beginPath(); g.moveTo(last.x, last.y); g.lineTo(c.offsetX, c.offsetY); g.stroke();
    }
    last = { x: c.offsetX, y: c.offsetY }; strokePoints++;
  }
  current = e.pressure.toFixed(3);
  if (events % 10 === 0) show();
});
canvas.addEventListener('pointerup', (e) => {
  if (e.pointerType !== 'pen') return;
  strokeTime += e.timeStamp - strokeStart; last = null; current = '-';
  show();
});
ipcRenderer.on('pads', (_e, p) => { pads = p; show(); });
ipcRenderer.on('pad', (_e, k) => { padLast = 'Taste ' + k.key + ' (Code ' + k.code + ') ' + (k.down ? 'gedrückt' : 'losgelassen'); show(); });
ipcRenderer.on('key', (_e, k) => { keyLast = k.type + ' ' + k.mods + k.key + (k.sincePad == null ? '' : ', ' + k.sincePad + ' ms nach der Tablett-Taste'); show(); });
show();
</script>`;

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1100, height: 760, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } });
  const send = (channel, data) => { if (!win.isDestroyed()) win.webContents.send(channel, data); };
  ipcMain.on('pen', (_e, s) => { report.pen = s; });
  // Tastatur, wie sie vor der Seite ankommt: KDE-Kürzel bzw. Kombinationen aus dem Huion-Treiber, mit Abstand zur Pad-Taste
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    const t = performance.now();
    const k = { t: Math.round(t), type: input.type, key: input.key, code: input.code,
      mods: ['control', 'alt', 'shift', 'meta'].filter((m) => input[m]).map((m) => `${m}+`).join(''),
      sincePad: lastPad ? Math.round(t - lastPad) : null };
    report.keys.push(k);
    send('key', k);
  });
  win.webContents.once('did-finish-load', () => readPads(send));
  // aus einer Datei: getCoalescedEvents gibt es nur in einem Secure Context, eine data:-URL ist keiner
  const html = path.join(os.tmpdir(), 'pen-probe.html');
  fs.writeFileSync(html, page);
  win.loadFile(html);
});

app.on('window-all-closed', () => {
  const file = path.join(os.tmpdir(), `pen-probe-${report.platform}-${report.ozone ?? report.session ?? 'default'}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, padKeys: report.padKeys.slice(-20), keys: report.keys.slice(-20) }, null, 2));
  console.log(`\nBericht: ${file}`);
  app.quit();
});
