// Reads handwriting off the window's thread: a page of lines takes a moment in WebAssembly, the pen must not stutter meanwhile.
// { id, strokes } → { id, lines } (lines: null without the model, see build.mjs).

import * as ort from 'onnxruntime-web/wasm';
import { read } from '../shared/htr.js';

ort.env.wasm.numThreads = 1; // threads need SharedArrayBuffer, which the window does not have; one line takes only milliseconds anyway

const session = (async () => {
  try {
    const res = await fetch(new URL('./htr/model.onnx', import.meta.url));
    if (!res.ok) return null;
    return await ort.InferenceSession.create(new Uint8Array(await res.arrayBuffer()));
  } catch (e) {
    console.warn('handwriting model not loaded:', e);
    return null;
  }
})();

// one after the other: the session runs one line at a time
let queue = Promise.resolve();
self.onmessage = ({ data: { id, strokes } }) => {
  queue = queue.then(async () => {
    const s = await session;
    self.postMessage({ id, lines: s ? await read(ort, s, strokes) : null });
  }).catch(() => self.postMessage({ id, lines: null }));
};
