#!/usr/bin/env bash
# One-time setup: downloads Tesseract.js (v5) + language data into ./vendor. Needs internet once.
set -e
cd "$(dirname "$0")"
mkdir -p vendor/lang
npm init -y >/dev/null 2>&1 || true
npm i tesseract.js@5
cp node_modules/tesseract.js/dist/tesseract.min.js vendor/
cp node_modules/tesseract.js/dist/worker.min.js vendor/
cp node_modules/tesseract.js-core/tesseract-core*.js vendor/
cp node_modules/tesseract.js-core/tesseract-core*.wasm vendor/ 2>/dev/null || true
for l in eng jpn jpn_vert kor chi_sim chi_tra; do
  curl -L -o "vendor/lang/$l.traineddata" "https://github.com/tesseract-ocr/tessdata_fast/raw/main/$l.traineddata"
  gzip -f "vendor/lang/$l.traineddata"
done
echo "Done. Load this folder via chrome://extensions -> Developer mode -> Load unpacked."
