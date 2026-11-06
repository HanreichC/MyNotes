// Full-text search over the notes folder. A thread of its own so a bad regex can be killed from outside.

import fs from 'node:fs/promises';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { setLanguage, t } from '../shared/i18n.js';
import { decode } from '../shared/text.js';

const { vault, query, regex, caseSensitive, language } = workerData;
setLanguage(language);
const MAX_FILE = 5 * 1024 * 1024;
const MAX_RESULTS = 500;

try {
  const flags = caseSensitive ? 'g' : 'gi';
  const re = new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  const results = [];
  const walk = async (rel) => {
    for (const e of await fs.readdir(path.join(vault, rel), { withFileTypes: true }).catch(() => [])) {
      if (results.length >= MAX_RESULTS) return;
      if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { await walk(p); continue; }
      if (!e.isFile()) continue;
      const { size } = await fs.stat(path.join(vault, p));
      if (size > MAX_FILE) continue;
      let text;
      try { text = decode(await fs.readFile(path.join(vault, p))).text; } catch { continue; } // not text
      text.split('\n').forEach((line, i) => {
        re.lastIndex = 0;
        const m = results.length < MAX_RESULTS && re.exec(line);
        if (m) results.push({ path: p, line: i + 1, column: m.index + 1, text: line.slice(Math.max(0, m.index - 40), m.index + 120) });
      });
    }
  };
  await walk('');
  parentPort.postMessage({ results });
} catch (e) {
  parentPort.postMessage({ error: e instanceof SyntaxError ? t('Der reguläre Ausdruck ist ungültig.') : e.message });
}
