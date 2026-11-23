# Handwriting model for scribbles

Scribbles read handwriting offline with **DE·HTR v2** (`naeyn/de-htr-web-v2`), the same model as in MyCAD: a small model for
German handwriting (ResNet18 + BiLSTM, CTC, 10.4 MB int8). It runs with onnxruntime-web (WebAssembly) in a worker of the
window, without the network.

- Model card: https://huggingface.co/naeyn/de-htr-web-v2 (revision `6241c1ff0fd42725e0dc46fcd3217469cac851bb`)
- Code: https://github.com/naeyn/de-htr-web
- License: Apache-2.0 for weights and code, see `LICENSE`
- Training data and their attribution: `NOTICE-training-data.md`
  (ScaDS.AI German Handwriting, CC BY 4.0, Burghardt, Alzin, Nestler et al., Universität Leipzig;
  fhswf/german_handwriting, AFL-3.0, FH Südwestfalen)

`model.onnx` is not in the repository: `build.mjs` downloads it once, checks it against SHA-256
`b576a0a1281b9be46b2574028b75575e041b7d7cb650f063886e733467cc1499` and puts it into `dist/htr/` with these three files. If the
download fails, MyNotes is built without reading: tidying handwriting still works.

The alphabet of the model is in `src/shared/scribble-read.js`. It does not know Ø and ±; the CAD correction there adds them.
Checked with the real model: `tests/scribble-read.test.js`.
