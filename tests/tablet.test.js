import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keyCodes, keyEvents } from '../src/main/tablet.js';
import { Actions, Kind, actionFor, detect, format, model, padKey, parse, suggestion } from '../src/shared/tablet.js';

test('model from the device name: the H640P with 6 keys, unknown ones are learned', () => {
  assert.equal(detect('HUION Huion Tablet_H640P Pad').id, 'h640p');
  assert.equal(detect('huion huion tablet_h640p pad').buttons, 6);
  assert.equal(detect('Wacom Intuos S Pad').id, 'intuosS');
  assert.equal(detect('UGTABLET 10 inch PenTablet Pad').id, 'other');
  assert.equal(detect('').id, 'other');
  assert.equal(model('gibt es nicht').id, 'other');
});

test('suggestion (H640P): undo, eraser, select, sheet, redo, fit; pen low pans, pen high erases while held', () => {
  const expected = ['undo', 'eraser', 'select', 'sheet', 'redo', 'look'];
  for (let n = 1; n <= 6; n++) assert.equal(suggestion(padKey(n)), expected[n - 1]);
  assert.equal(suggestion('pad7'), 'none');
  assert.equal(actionFor(new Map(), 'penLow').kind, Kind.Pan);
  assert.equal(actionFor(new Map(), 'penHigh').kind, Kind.Hold);
  assert.equal(actionFor(new Map(), 'pad1').command, 'undo');
  // every action with a command has one, Pan and Nothing have none
  for (const a of Actions) assert.equal(a.kind === Kind.Command || a.kind === Kind.Hold, a.command !== '', a.id);
});

test('stored layout: only what differs from the suggestion, read back the same', () => {
  const a = new Map([
    ['pad1', 'undo'], // as suggested: not stored
    ['pad2', 'marker'],
    ['penLow', 'pan'], // as suggested now (MyCAD suggests rotate here)
    ['penHigh', 'pan'],
  ]);
  const text = format(a);
  assert.equal(text, 'pad2=marker;penHigh=pan');
  const back = parse(text);
  assert.equal(actionFor(back, 'pad2').id, 'marker');
  assert.equal(actionFor(back, 'pad1').id, 'undo');
  assert.equal(actionFor(back, 'penLow').kind, Kind.Pan);
  assert.equal(actionFor(back, 'penHigh').kind, Kind.Pan);
  assert.ok(parse('').size === 0 && parse(';;=x;pad3').size === 0);
  assert.equal(actionFor(parse('pad1=kaputt'), 'pad1').kind, Kind.None); // old or foreign values: Nothing
});

// An emulated H640P pad as the kernel reports it (hid-uclogic): BTN_0 … BTN_5 and BTN_STYLUS, read as struct input_event
const event = (type, code, value) => { const b = Buffer.alloc(24); b.writeUInt16LE(type, 16); b.writeUInt16LE(code, 18); b.writeInt32LE(value, 20); return b; };

test('tablet keys from /dev/input: numbered like libinput, repeats ignored, a cut record waits for the rest', () => {
  const codes = keyCodes('800 3f 0 0 0 0\n');
  assert.deepEqual(codes, [256, 257, 258, 259, 260, 261, 331]);
  const stream = Buffer.concat([event(4, 4, 589827), event(1, 258, 1), event(0, 0, 0), event(1, 258, 2), event(1, 258, 0), event(1, 261, 1)]);
  const first = keyEvents(stream.subarray(0, 24 * 5 + 10));
  assert.deepEqual(first.events.map((e) => [padKey(codes.indexOf(e.code) + 1), e.down]), [['pad3', true], ['pad3', false]]);
  assert.equal(first.rest.length, 10);
  const second = keyEvents(Buffer.concat([first.rest, stream.subarray(24 * 5 + 10)]));
  assert.deepEqual(second.events, [{ code: 261, down: true }]);
  assert.equal(second.rest.length, 0);
});
