#!/usr/bin/env bash
set -euo pipefail

HOOK="${1:-$(cd "$(dirname "$0")" && pwd)/rtk-devin-pretooluse.sh}"

fail=0
check() {
  local cmd="$1"
  local want="$2"
  local json out got
  json=$(jq -n --arg c "$cmd" '{
    hook_event_name: "PreToolUse",
    tool_name: "exec",
    tool_input: {command: $c, shell_id: "main"}
  }')
  out=$(printf '%s' "$json" | bash "$HOOK")
  got=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.updatedInput.command // empty')
  if [ "$got" != "$want" ]; then
    echo "FAIL: $cmd"
    echo "  want: $want"
    echo "  got:  $got"
    echo "  full: $out"
    fail=1
  else
    echo "OK: $cmd -> ${got:-<passthrough>}"
  fi
}

check "git diff HEAD~1" "rtk git diff HEAD~1"
check "git status" "rtk git status"
check "grep -r foo ." "rtk grep -r foo ."
check "node -e \"console.log(1)\"" ""

exit "$fail"
