// Bundles the window into dist/. Only the renderer needs this; the main process runs from src/ as it is.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The handwriting model of MyCAD (DE·HTR v2, Apache-2.0, docs/PLAN.md § 10.2): downloaded once, checked, kept in the npm cache folder. */
const MODEL = {
  url: 'https://huggingface.co/naeyn/de-htr-web-v2/resolve/6241c1ff0fd42725e0dc46fcd3217469cac851bb/model.onnx',
  sha256: 'b576a0a1281b9be46b2574028b75575e041b7d7cb650f063886e733467cc1499',
  cache: 'node_modules/.cache/mynotes-htr/model.onnx',
};

/** Without the model (offline, download failed) MyNotes still tidies handwriting, it only cannot read it. */
export async function htrModel() {
  const ok = (b) => b && createHash('sha256').update(b).digest('hex') === MODEL.sha256;
  let bytes = await readFile(MODEL.cache).catch(() => null);
  if (ok(bytes)) return bytes;
  try {
    const res = await fetch(MODEL.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bytes = Buffer.from(await res.arrayBuffer());
    if (!ok(bytes)) throw new Error('wrong SHA-256');
    await mkdir(path.dirname(MODEL.cache), { recursive: true });
    await writeFile(MODEL.cache, bytes);
    return bytes;
  } catch (e) {
    console.warn(`handwriting model not available (${e.message}): MyNotes is built without reading handwriting`);
    return null;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { // run, not imported by a test
  await rm('dist', { recursive: true, force: true });
  await mkdir('dist/htr', { recursive: true });
  await copyFile('src/renderer/index.html', 'dist/index.html');
  await copyFile('node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm', 'dist/ort-wasm-simd-threaded.wasm');
  const model = await htrModel();
  if (model) {
    await writeFile('dist/htr/model.onnx', model);
    for (const f of ['README.md', 'LICENSE', 'NOTICE-training-data.md']) await copyFile(`docs/htr/${f}`, `dist/htr/${f}`); // its license travels with it
  }
  await build({
    entryPoints: ['src/renderer/app.js', 'src/renderer/htr-worker.js', 'src/renderer/style.css'],
    outdir: 'dist',
    bundle: true,
    format: 'esm',
    splitting: true,
    minify: true,
    sourcemap: 'linked',
    target: 'chrome130',
    loader: { '.ttf': 'file' },
    assetNames: 'fonts/[name]',
    logLevel: 'warning',
  });
}
