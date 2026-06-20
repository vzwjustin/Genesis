#!/usr/bin/env bash
# Verify the Anthropic built-in tool model-prefix fix reached the CLI bundle.
# See AGENTS.md "Verify fixes in compiled output".
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHUNKS_DIR="$ROOT/cli/app/.next-cli-build/server/chunks"

if [ ! -d "$CHUNKS_DIR" ]; then
  echo "FAIL: no CLI build at $CHUNKS_DIR"
  echo "Clear cache and rebuild: rm -rf .next-cli-build && cd cli && npm run build"
  exit 1
fi

for chunk in "$CHUNKS_DIR"/*.js; do
  [ -e "$chunk" ] || continue
  if grep -q 'claude-opus-4-8' "$chunk" \
    && grep -q 'cc/' "$chunk" \
    && grep -Eq '(lastIndexOf|indexOf)\("/"\)[[:space:]]*\+[[:space:]]*1' "$chunk"; then
    echo "OK: Anthropic tool model-prefix strip found in compiled chunks"
    exit 0
  fi
done

echo "FAIL: expected Anthropic tool model-prefix strip markers in $CHUNKS_DIR"
echo "Clear cache and rebuild: rm -rf .next-cli-build && cd cli && npm run build"
exit 1
