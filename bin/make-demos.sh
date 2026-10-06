#!/usr/bin/env bash
# Rebuild the demo videos from the engine in this checkout.
#   bin/make-demos.sh [OUTDIR]        (default ~/.capy/work/front)
# Writes OUTDIR/demo/{demo.mp4,demo.gif,demo.wav,contact.png} (headless, 35 tics/s, with sound) and
# OUTDIR/live/live.mp4 (the web page in headless Chromium, recorded in real time).
# Env: ROUTE=key script (default bin/demo-route.txt), ROOT=alternate repo root holding interp/ doom/ wad/.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-$HOME/.capy/work/front}"
ROUTE="${ROUTE:-bin/demo-route.txt}"
ROOTARG=()
[ -n "${ROOT:-}" ] && ROOTARG=(--root "$ROOT")
mkdir -p "$OUT/demo" "$OUT/live"
[ -f wad/sounds.wad ] || python3 tools/mksounds.py

node bin/doom-record.mjs "${ROOTARG[@]}" --quiet --script-file "$ROUTE" \
  --mp4 "$OUT/demo/demo.mp4" --gif "$OUT/demo/demo.gif" --gif-fps 20 --wav "$OUT/demo/demo.wav"
ffmpeg -v error -y -i "$OUT/demo/demo.mp4" -vf "select='not(mod(n\,130))',scale=320:240,tile=4x2" -frames:v 1 "$OUT/demo/contact.png"

node bin/doom-live.mjs "${ROOTARG[@]}" --script-file "$ROUTE" --out "$OUT/live/live.mp4"

ls -la "$OUT/demo" "$OUT/live"
