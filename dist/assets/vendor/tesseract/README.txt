Offline OCR assets bundled for Editor PDF y Firmas

tesseract.js 7.0.0: API and browser worker
tesseract.js-core 7.0.0: LSTM-only baseline WebAssembly build embedded in its local JavaScript loader (broad browser compatibility; smaller bundle, slower than SIMD builds)
@tesseract.js-data/eng 1.0.0 and @tesseract.js-data/spa 1.0.0: 4.0.0_best_int compressed models

All assets are served from this project. OCR runs in a browser worker and does not upload documents.
The worker, WebAssembly engine, and selected language model are fetched only after the user starts OCR.
Third-party licenses are included beside their respective resources.
