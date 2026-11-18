#!/usr/bin/env bash
# Native screenshots have a fixed 1200x760 window at (0, 0). Both result dialogs'
# titles fall in this band. Whole-screen mixed-language OCR misses the small heading
# even when it is readable; isolate and enlarge the pixels, keeping the exact assertion.
set -euo pipefail
lang=eng
[ "$2" = zh ] && lang=chi_sim
convert "$1" -crop 480x75+360+160 +repage -resize 300% png:- |
  tesseract stdin stdout -l "$lang" --psm 6 2>/dev/null | tr -d '[:space:]'
