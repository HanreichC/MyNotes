// Every text of the app has its English version, and the dictionary holds nothing that is no longer used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { EN, keys, setLanguage, t } from '../src/shared/i18n.js';

const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const sources = files('src').filter((f) => /\.(js|cjs)$/.test(f) && !f.endsWith('i18n.js')).map((f) => [f, fs.readFileSync(f, 'utf8')]);

/** The keys in the code: t('…') with a plain string, and the German texts of index.html that translatePage() passes through t(). */
function usedKeys() {
  const used = new Set();
  for (const [, src] of sources) for (const m of src.matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g)) used.add(m[1]);
  const html = fs.readFileSync('src/renderer/index.html', 'utf8');
  for (const m of html.matchAll(/ (?:title|aria-label|placeholder)="([^"]+)"/g)) used.add(m[1]);
  for (const m of html.matchAll(/class="(?:split-zone[^"]*|st-btn)"[^>]*>([^<]+)</g)) used.add(m[1]);
  return used;
}

test('t() is only called with a plain string, so the keys can be found', () => {
  for (const [f, src] of sources) assert.doesNotMatch(src, /\bt\([`"]/, f);
});

test('every text has its English version, and none is left over', () => {
  const used = usedKeys();
  assert.deepEqual([...used].filter((k) => !EN[k]), [], 'missing in EN');
  assert.deepEqual(Object.keys(EN).filter((k) => !used.has(k)), [], 'in EN, but no longer used');
});

test('placeholders survive the translation', () => {
  for (const [de, en] of Object.entries(EN)) {
    const names = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(names(en), names(de), de);
  }
});

test('t() and keys() switch with the language', () => {
  try {
    assert.equal(t('„{name}“ ist leer, es gibt nichts zu konvertieren.', { name: 'a$&b' }), '„a$&b“ ist leer, es gibt nichts zu konvertieren.');
    assert.equal(keys('Strg+Umschalt+Bild↓'), 'Strg+Umschalt+Bild↓');
    setLanguage('en-US');
    assert.equal(t('Gesichert'), EN.Gesichert);
    assert.equal(t('nicht im Wörterbuch'), 'nicht im Wörterbuch');
    assert.equal(keys('Strg+Umschalt+Bild↓'), 'Ctrl+Shift+PgDn');
    assert.equal(keys('Esc, dann Tab'), 'Esc, then Tab');
    setLanguage('de-AT');
    assert.equal(t('Gesichert'), 'Gesichert');
  } finally {
    setLanguage('de');
  }
});
