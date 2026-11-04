import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isJson, JsonError, minifyJson, prettyJson } from '../src/shared/json.js';
import { decode, encode, safeName, titleOf } from '../src/shared/text.js';

test('pretty print only touches whitespace: numbers, duplicates and escapes survive', () => {
  const src = '{"big":12345678901234567890,"f":1.0,"e":1E+5,"a":1,"a":2,"s":"x\\"y\\n{,:}","u":"\\u00e4","e0":{},"e1":[ ],"10":0,"2":0}';
  const out = prettyJson(src);
  assert.equal(out, `{
  "big": 12345678901234567890,
  "f": 1.0,
  "e": 1E+5,
  "a": 1,
  "a": 2,
  "s": "x\\"y\\n{,:}",
  "u": "\\u00e4",
  "e0": {},
  "e1": [],
  "10": 0,
  "2": 0
}`);
  assert.equal(minifyJson(out), src.replace('[ ]', '[]'));
  assert.equal(prettyJson('[1,[2,{"a":null}]]', '\t'), '[\n\t1,\n\t[\n\t\t2,\n\t\t{\n\t\t\t"a": null\n\t\t}\n\t]\n]');
  assert.equal(prettyJson('﻿  "x" \n'), '"x"');
  assert.equal(prettyJson('true'), 'true');
});

test('invalid JSON reports where, and nothing is changed', () => {
  assert.throws(() => prettyJson('{\n  "a": 1,\n  oops\n}'), (e) => e instanceof JsonError && e.line === 3 && e.column === 3);
  assert.throws(() => minifyJson(''), JsonError);
  assert.equal(isJson('{"a":1}'), true);
  assert.equal(isJson(' [1] '), true);
  assert.equal(isJson('5'), false);
  assert.equal(isJson('{a}'), false);
});

test('encodings and line endings go back byte for byte', () => {
  const samples = [
    ['utf-8 lf', Buffer.from('ä\nb\n')],
    ['utf-8 crlf', Buffer.from('ä\r\nb\r\n')],
    ['utf-8 bom', Buffer.from('﻿ä\n')],
    ['utf-16le', Buffer.from('﻿äö\r\n', 'utf16le')],
    ['utf-16be', Buffer.from('﻿äö\n', 'utf16le').swap16()],
    ['cp1252', Buffer.from([0x47, 0x72, 0xfc, 0xdf, 0x80, 0x0d, 0x0a])],
    ['classic mac', Buffer.from('a\rb\r')],
    ['empty', Buffer.alloc(0)],
  ];
  for (const [name, bytes] of samples) {
    const d = decode(bytes);
    assert.ok(!d.text.includes('\r'), name);
    assert.deepEqual(encode(d.text, d), bytes, name);
  }
  assert.equal(decode(Buffer.from([0x80, 0xe4])).text, '€ä');
});

test('mixed line endings are flagged, encoding gaps are refused, binaries too', () => {
  assert.equal(decode(Buffer.from('a\r\nb\nc\r\n')).mixedEol, true);
  assert.equal(decode(Buffer.from('a\r\nb\r\n')).mixedEol, false);
  assert.equal(encode('😀', { encoding: 'windows-1252' }), null);
  assert.throws(() => decode(Buffer.from([1, 2, 0, 3])));
  assert.throws(() => decode(Buffer.from([0xff, 0xfe, 0x00, 0xd8]))); // UTF-16 with a broken surrogate
});

test('file names work on both systems', () => {
  assert.equal(safeName('a<b>:c"/d\\e|f?g*h'), 'a b c d e f g h');
  assert.equal(safeName('  Punkt am Ende...  '), 'Punkt am Ende');
  assert.equal(safeName('CON'), '_CON');
  assert.equal(safeName('lpt1.txt'), '_lpt1.txt');
  assert.equal(safeName('{'), 'Unbenannt');
  assert.equal(safeName('...'), 'Unbenannt');
  assert.equal(safeName('x'.repeat(200)).length, 80);
  assert.equal(safeName('Größe ß 日本語'), 'Größe ß 日本語');
});

test('titles come from the first line with text', () => {
  assert.equal(titleOf('\n\n# Projektplan: Q4\nText'), 'Projektplan Q4');
  assert.equal(titleOf('- [x] **Erledigt** _heute_'), 'Erledigt heute');
  assert.equal(titleOf('> Zitat'), 'Zitat');
  assert.equal(titleOf('1. Erstens'), 'Erstens');
  assert.equal(titleOf('{\n"name": "x"\n}'), 'name x');
  assert.equal(titleOf('---\n***'), 'Unbenannt');
  assert.equal(titleOf(''), 'Unbenannt');
});
