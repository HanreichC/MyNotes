// The promise itself: whatever was acknowledged survives being killed at a random moment.
// Proves crash safety, not power-loss safety: the OS page cache survives a killed process either way.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/main/store.js';

const ROUNDS = 25;

if (process.env.MYNOTES_CRASH_WRITER) {
  const [dataDir, vault] = process.env.MYNOTES_CRASH_WRITER.split('|');
  const store = new Store({ dataDir, vault });
  await store.start();
  const doc = store.documents()[0] ?? (await store.create());
  let text = doc.text;
  for (let n = Number(/(\d+)\n$/.exec(text)?.[1] ?? 0) + 1; ; n++) {
    text += `Zeile ${n}\n`;
    const { ok } = await store.update(doc.id, text);
    if (ok) writeSync(1, `${n}\n`); // only now does the caller count this line as safe
  }
} else {
  test(`acknowledged text survives ${ROUNDS} hard kills`, { timeout: 120_000 }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mynotes-crash-'));
    const dataDir = path.join(root, 'data');
    const vault = path.join(root, 'vault');
    await fs.mkdir(vault);

    let lastAck = 0;
    for (let round = 0; round < ROUNDS; round++) {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
        env: { ...process.env, MYNOTES_CRASH_WRITER: `${dataDir}|${vault}` },
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      const exited = new Promise((r) => child.on('exit', r));
      // wait until it is really writing, then kill at a random point
      while (!out.includes('\n')) await new Promise((r) => setTimeout(r, 5));
      await new Promise((r) => setTimeout(r, 20 + Math.random() * 200));
      child.kill('SIGKILL');
      await exited;
      const acks = out.split('\n').filter(Boolean).map(Number);
      lastAck = Math.max(lastAck, acks.at(-1) ?? 0);

      const store = new Store({ dataDir, vault });
      await store.start();
      const [doc] = store.documents();
      assert.ok(doc, `round ${round}: tab is gone`);
      const lines = doc.text.trimEnd().split('\n');
      const last = Number(lines.at(-1).replace('Zeile ', ''));
      assert.ok(last >= lastAck, `round ${round}: acknowledged line ${lastAck}, recovered only up to ${last}`);
      lines.forEach((l, i) => assert.equal(l, `Zeile ${i + 1}`, `round ${round}: line ${i + 1} damaged`));
      lastAck = last;
      for (const d of store.docs.values()) { clearTimeout(d.timer); await d.fh?.close(); }
    }
    assert.ok(lastAck > ROUNDS, `only ${lastAck} lines written, the test proved little`);
    console.log(`  ${lastAck} lines across ${ROUNDS} kills`);
  });
}
