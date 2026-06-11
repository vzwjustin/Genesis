#!/usr/bin/env bash
# Verify the Anthropic built-in tool model-prefix fix reached the CLI bundle.
# See AGENTS.md "Verify fixes in compiled output".
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHUNKS_DIR="$ROOT/cli/app/.next-cli-build/server/chunks"

if [ ! -d "$CHUNKS_DIR" ]; then
  echo "SKIP: no CLI build at $CHUNKS_DIR — run: rm -rf .next-cli-build && cd cli && npm run build"
  exit 0
fi

if grep -R -q 'indexOf("/")+1' "$CHUNKS_DIR"/*.js 2>/dev/null; then
  echo "OK: Anthropic tool model-prefix strip found in compiled chunks"
  exit 0
fi

echo "FAIL: expected indexOf(\"/\")+1 model-prefix strip in $CHUNKS_DIR"
echo "Clear cache and rebuild: rm -rf .next-cli-build && cd cli && npm run build"
exit 1
