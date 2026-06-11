#!/usr/bin/env bash
# Devin CLI PreToolUse hook — rewrite exec commands through RTK filters.
# Devin hooks are Claude Code-compatible; rtk hook claude is the native rewriter.
set -euo pipefail

export PATH="${HOME}/.local/bin:${PATH}"

if ! command -v rtk >/dev/null 2>&1; then
  printf '%s\n' '{}'
  exit 0
fi

exec rtk hook claude
