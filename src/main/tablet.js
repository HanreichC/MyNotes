// Keys on a graphics tablet, read by MyNotes itself (Linux): Chromium does not report them, KDE at most turns them into
// shortcuts. Devices with ID_INPUT_TABLET_PAD in the udev database, read as struct input_event, never keyboards.
// Readable for the user once a udev rule says so (uaccess), the same rule as MyCAD's: whichever of the two set it up first.
// On Windows the Huion driver owns the device and sends key combinations instead (app.js).

import { execFile } from 'node:child_process';
import fs from 'node:fs';

export const RULE = 'ACTION!="remove", SUBSYSTEM=="input", KERNEL=="event*", ENV{ID_INPUT_TABLET_PAD}=="1", TAG+="uaccess"';
const RULE_FILE = '/etc/udev/rules.d/70-mynotes-tablet.rules';
const EVENT_SIZE = 24; // struct input_event on 64-bit Linux: timeval (16), type, code (2 each), value (4)
const EV_KEY = 1;

/** capabilities/key: words of 64 bits (unsigned long), the highest first → the key codes the device has, ascending */
export function keyCodes(hex) {
  const codes = [];
  hex.trim().split(/\s+/).reverse().forEach((w, i) => {
    const v = BigInt(`0x${w}`);
    for (let b = 0n; b < 64n; b++) if ((v >> b) & 1n) codes.push(i * 64 + Number(b));
  });
  return codes;
}

/** input_event records → key presses: [{ code, down }]; a cut record waits for the rest */
export function keyEvents(buf) {
  const out = [];
  let at = 0;
  for (; at + EVENT_SIZE <= buf.length; at += EVENT_SIZE) {
    if (buf.readUInt16LE(at + 16) !== EV_KEY) continue;
    const value = buf.readInt32LE(at + 20);
    if (value !== 2) out.push({ code: buf.readUInt16LE(at + 18), down: value === 1 }); // 2 is auto-repeat
  }
  return { events: out, rest: buf.subarray(at) };
}

/**
 * Watches the tablet pads. onKey('pad3', true); onPad({ name, denied }) when one comes, goes or cannot be read.
 * Keys are numbered like libinput does: by their codes, ascending, from 1.
 */
export function watchPads({ onKey, onPad }) {
  if (process.platform !== 'linux') return { rescan() {}, close() {} };
  const open = new Map(); // device → stream
  let state = { name: '', denied: false };
  const report = (next) => { if (next.name !== state.name || next.denied !== state.denied) { state = next; onPad(next); } };
  const scan = () => {
    let names;
    try { names = fs.readdirSync('/sys/class/input').filter((n) => /^event\d+$/.test(n)); } catch { return; }
    let seen = { name: '', denied: false };
    for (const name of names) {
      const sys = `/sys/class/input/${name}`, device = `/dev/input/${name}`;
      let label, codes;
      try {
        const udev = fs.readFileSync(`/run/udev/data/c${fs.readFileSync(`${sys}/dev`, 'utf8').trim()}`, 'utf8');
        if (!/^E:ID_INPUT_TABLET_PAD=1$/m.test(udev)) continue;
        label = fs.readFileSync(`${sys}/device/name`, 'utf8').trim();
        codes = keyCodes(fs.readFileSync(`${sys}/device/capabilities/key`, 'utf8'));
      } catch { continue; }
      if (open.has(device)) { seen = { name: label, denied: false }; continue; }
      try { fs.accessSync(device, fs.constants.R_OK); } catch { seen = { name: label, denied: true }; continue; } // there, but the rule is missing
      seen = { name: label, denied: false };
      let rest = Buffer.alloc(0);
      const stream = fs.createReadStream(device, { highWaterMark: EVENT_SIZE * 64 });
      open.set(device, stream);
      stream.on('data', (chunk) => {
        const r = keyEvents(Buffer.concat([rest, chunk]));
        rest = Buffer.from(r.rest);
        for (const e of r.events) { const n = codes.indexOf(e.code); if (n >= 0) onKey(`pad${n + 1}`, e.down); }
      });
      stream.on('error', () => { open.delete(device); setTimeout(scan, 200); }); // unplugged
      stream.on('close', () => open.delete(device));
    }
    report(seen);
  };
  let timer = null;
  let watcher = null;
  try { watcher = fs.watch('/dev/input', () => { clearTimeout(timer); timer = setTimeout(scan, 500); }); } catch { /* no /dev/input: nothing to read */ }
  scan();
  return {
    rescan: scan,
    close() { watcher?.close(); for (const s of open.values()) s.destroy(); open.clear(); },
  };
}

/** Lets the logged-in user read tablet keys: pkexec asks for the password once and writes the udev rule. */
export function allowAccess() {
  return new Promise((resolve, reject) => {
    const script = `printf '%s\\n' "$1" > ${RULE_FILE} && udevadm control --reload && udevadm trigger --subsystem-match=input`;
    execFile('pkexec', ['sh', '-c', script, 'sh', RULE], (err) => (err ? reject(err) : resolve()));
  });
}
