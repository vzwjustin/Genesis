#!/usr/bin/env bash
#
# fix-cli-symlink.sh — repoint the global `genesis` install at THIS clone.
#
# Why this exists:
#   When more than one genesis clone exists on a machine (e.g. ~/genesis-fork
#   and ~/Downloads/genesis-fork), the global `genesis` command may resolve to
#   the wrong clone. cli.js boots the server from its own __dirname, so the
#   server then runs from the stale clone's cli/app — old code, stale build.
#
#   This re-points every global node_modules/genesis symlink found on PATH at
#   the clone this script lives in, so `genesis` always launches this checkout.
#
# Usage:
#   bash cli/scripts/fix-cli-symlink.sh          # repoint, then print result
#   bash cli/scripts/fix-cli-symlink.sh --check  # report only, change nothing
#
set -euo pipefail

# Resolve this clone's cli dir (the directory containing cli.js), following
# symlinks so it works whether invoked directly or via npm.
SCRIPT_SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SCRIPT_SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SCRIPT_SOURCE")" && pwd)"
  SCRIPT_SOURCE="$(readlink "$SCRIPT_SOURCE")"
  [[ "$SCRIPT_SOURCE" != /* ]] && SCRIPT_SOURCE="$DIR/$SCRIPT_SOURCE"
done
SCRIPTS_DIR="$(cd -P "$(dirname "$SCRIPT_SOURCE")" && pwd)"
CLI_DIR="$(cd -P "$SCRIPTS_DIR/.." && pwd)"

if [ ! -f "$CLI_DIR/cli.js" ]; then
  echo "error: $CLI_DIR/cli.js not found — run this from a genesis clone" >&2
  exit 1
fi

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

echo "this clone cli dir: $CLI_DIR"

# Find every global node_modules/genesis on the PATH's npm prefixes.
# Covers homebrew node, nvm/hermes, system node, etc.
changed=0
for npm_bin in $(command -v -a npm 2>/dev/null || true); do
  prefix="$("$npm_bin" prefix -g 2>/dev/null || true)"
  [ -z "$prefix" ] && continue
  link="$prefix/lib/node_modules/genesis"
  [ -e "$link" ] || [ -L "$link" ] || continue

  current="$(readlink "$link" 2>/dev/null || true)"
  resolved="$(cd "$(dirname "$link")" && cd "$(readlink "$link" 2>/dev/null || echo .)" 2>/dev/null && pwd || true)"

  if [ "$resolved" = "$CLI_DIR" ]; then
    echo "ok   $link -> already this clone"
    continue
  fi

  echo "stale $link -> ${current:-<none>}"
  if [ "$CHECK_ONLY" = "1" ]; then
    changed=1
    continue
  fi

  ln -sfn "$CLI_DIR" "$link"
  echo "fixed $link -> $CLI_DIR"
  changed=1
done

if [ "$changed" = "0" ]; then
  echo "nothing to do — global genesis already points at this clone"
elif [ "$CHECK_ONLY" = "1" ]; then
  echo "run without --check to repoint"
  exit 1
fi

# Show where the user-facing `genesis` command now resolves.
if command -v genesis >/dev/null 2>&1; then
  bin="$(command -v genesis)"
  target="$(cd "$(dirname "$bin")" && readlink "$bin" 2>/dev/null || true)"
  echo "PATH genesis: $bin -> ${target:-<self>}"
fi
