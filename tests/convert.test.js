import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conversionsFor, fromBase64, fromHex, jsonToCsv, markdownToHtml, parseCsv, textToJson, toBase64, toHex } from '../src/shared/convert.js';

const utf8 = (s) => new TextEncoder().encode(s);
const str = (b) => new TextDecoder().decode(b);
const labels = (name, text) => conversionsFor(name, utf8(text)).map((c) => c.label);
const convert = (name, text, label) => {
  const r = conversionsFor(name, utf8(text)).find((c) => c.label === label).make();
  return { ...r, text: str(r.bytes) };
};

test('Base64 and hex go there and back, byte for byte, also with bytes that are not text', () => {
  const samples = [utf8('Grüße 😀\nzwei'), Uint8Array.from({ length: 256 }, (_, i) => i), new Uint8Array(200_000).fill(200)];
  for (const b of samples) {
    assert.deepEqual(fromBase64(toBase64(b)), b);
    assert.deepEqual(fromHex(toHex(b)), b);
  }
  assert.equal(toBase64(utf8('Grüße')), 'R3LDvMOfZQ==');
  assert.equal(toHex(utf8('ü')), 'c3bc');
  assert.equal(str(fromBase64(' R3LD\nvMOfZQ==\n')), 'Grüße', 'line breaks in Base64 are normal');
});

test('what is no Base64 or hex is refused', () => {
  for (const bad of ['', 'abc', 'a b!c', '=abc', 'ab=c']) assert.equal(fromBase64(bad), null, bad);
  for (const bad of ['', 'abc', 'xy']) assert.equal(fromHex(bad), null, bad);
});

test('the menu only offers what works for this file', () => {
  assert.deepEqual(labels('Notiz.md', 'Einfach ein Text'), ['Zu JSON', 'Zu HTML', 'Zu Base64', 'Zu Hex', 'URL-kodieren']);
  assert.ok(!labels('a.txt', 'Text').includes('Zu HTML'), 'HTML is for Markdown');
  assert.ok(!labels('a.txt', 'test').includes('Aus Base64'), 'a word that is valid Base64 by accident');
  assert.ok(labels('a.txt', 'R3LDvMOfZQ==').includes('Aus Base64'));
  assert.ok(labels('a.txt', 'c3bc').includes('Aus Hex'));
  assert.ok(labels('a.txt', 'a%20b').includes('URL-dekodieren'));
  assert.ok(!labels('a.txt', '100% sicher').includes('URL-dekodieren'), 'a percent sign is no encoding');
  assert.ok(!labels('a.json', '{"a":1}').includes('Zu JSON'), 'it is JSON already');
  assert.ok(!labels('a.json', '{"a":1}').includes('Zu CSV'), 'one object is no table');
  assert.ok(labels('a.json', '[{"a":1}]').includes('Zu CSV'));
  assert.deepEqual(conversionsFor('leer.md', new Uint8Array(0)), [], 'an empty note has nothing to convert');
  assert.deepEqual(conversionsFor('bild.png', Uint8Array.of(0x89, 0, 1, 2)).map((c) => c.label), ['Zu Base64', 'Zu Hex'], 'not text: only the bytes');
});

test('results are named after the note, and decoding gives text or a .bin', () => {
  assert.deepEqual([convert('Liste.md', 'a,b\n1,2\n', 'Zu JSON').name, convert('Liste.md', 'a,b\n1,2\n', 'Zu JSON').ext], ['Liste', '.json']);
  const b = convert('Geheim.md', 'Hallo', 'Zu Base64');
  assert.deepEqual([b.name, b.ext, b.text], ['Geheim (Base64)', '.txt', 'SGFsbG8=']);
  const back = convert(`${b.name}.txt`, b.text, 'Aus Base64');
  assert.deepEqual([back.ext, back.text], ['.txt', 'Hallo']);
  const long = toBase64(Uint8Array.from({ length: 90 }, (_, i) => 128 + i));
  assert.equal(convert('x.txt', long, 'Aus Base64').ext, '.bin');
});

test('CSV: quotes, line breaks in cells, semicolons, and values that stay what they are', () => {
  assert.deepEqual(parseCsv('a,"b,c"\n"zwei\nZeilen","sagt ""hi"""\n', ','), [['a', 'b,c'], ['zwei\nZeilen', 'sagt "hi"']]);
  assert.equal(parseCsv('a,"offen', ','), null);
  assert.deepEqual(JSON.parse(textToJson('Name;Plz;Ok\nÄrger;00123;true\n')), [{ Name: 'Ärger', Plz: '00123', Ok: true }]);
  const big = textToJson('a,b,c\n12345678901234567890,1.0,-2e5\n');
  assert.ok(big.includes('"a": 12345678901234567890') && big.includes('"b": 1.0') && big.includes('"c": -2e5'), big);
  assert.equal(textToJson('a,b\n1,2\n', '\t'), '[\n\t{\n\t\t"a": 1,\n\t\t"b": 2\n\t}\n]');
});

test('JSON to CSV: every key, nested values as JSON, big numbers intact', () => {
  assert.equal(jsonToCsv('[{"a":1,"b":"x,y"},{"c":null,"a":"sagt \\"hi\\""}]'), 'a,b,c\n1,"x,y",\n"sagt ""hi""",,\n');
  assert.equal(jsonToCsv('[{"big":12345678901234567890,"f":1.0,"n":{"g":1.0}}]'), 'big,f,n\n12345678901234567890,1.0,"{""g"":1.0}"\n');
  for (const no of ['{"a":1}', '[]', '[1,2]', '[{"a":1},2]', '[[1]]', 'kaputt']) assert.equal(jsonToCsv(no), null, no);
});

test('plain text to JSON: key and value lines, or one entry per line', () => {
  assert.deepEqual(JSON.parse(textToJson('host: localhost\nport = 8080\nan: true\n')), { host: 'localhost', port: 8080, an: true });
  assert.deepEqual(JSON.parse(textToJson('Einkauf\n\nMilch "frisch"\n')), ['Einkauf', 'Milch "frisch"']);
});

test('Markdown to HTML is a whole page that keeps umlauts and escapes its title', () => {
  const html = markdownToHtml('# Grüße\n\n*fein*\n', '<Titel> & mehr');
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /<h1>Grüße<\/h1>/);
  assert.match(html, /<em>fein<\/em>/);
  assert.match(html, /<title>&lt;Titel&gt; &amp; mehr<\/title>/);
});
