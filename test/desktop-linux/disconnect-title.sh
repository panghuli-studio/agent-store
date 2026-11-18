#!/usr/bin/env bash
# The delete result has a fixed layout in the harness's 1200x760 native window.
# Read only its heading, excluding background/body text and the status bar. Use a
# single-line recognizer: full-window/mixed-language OCR drops this small title.
# Tesseract 4 misreads the light-on-dark Chinese heading; negate its pixels first
# (the CI preprocessing comparison isolates this from scaling/thresholding).
set -euo pipefail
lang=eng
crop=260x28+374+170
if [ "$2" = zh ]; then
  lang=chi_sim
  crop=126x24+374+199
fi
convert "$1" -crop "$crop" +repage -negate -resize 400% png:- |
  tesseract stdin stdout -l "$lang" --psm 7 2>/dev/null | tr -d '[:space:]'
