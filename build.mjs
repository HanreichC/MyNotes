// Bundles the window into dist/. Only the renderer needs this; the main process runs from src/ as it is.
import { build } from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await copyFile('src/renderer/index.html', 'dist/index.html');
await build({
  entryPoints: ['src/renderer/app.js', 'src/renderer/style.css'],
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
