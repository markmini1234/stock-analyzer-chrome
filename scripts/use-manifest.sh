#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:-chrome}"

case "$TARGET" in
  chrome)
    SRC="manifests/manifest.chrome.json"
    ;;
  edge)
    SRC="manifests/manifest.edge.json"
    ;;
  firefox)
    SRC="manifests/manifest.firefox.json"
    ;;
  *)
    echo "Usage: bash scripts/use-manifest.sh [chrome|edge|firefox]" >&2
    exit 1
    ;;
esac

if [[ ! -f "$SRC" ]]; then
  echo "Manifest template not found: $SRC" >&2
  exit 1
fi

cp "$SRC" manifest.json

echo "Switched manifest.json to: $TARGET"
