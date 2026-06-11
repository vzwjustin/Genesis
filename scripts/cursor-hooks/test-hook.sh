#!/usr/bin/env bash
set -euo pipefail

HOOK="${1:-$(cd "$(dirname "$0")" && pwd)/rtk-cursor-pretooluse.sh}"

fail=0
check() {
  local cmd="$1"
  local want="$2"
  local json out got
  json=$(jq -n --arg c "$cmd" '{tool_name:"Shell",tool_input:{command:$c},tool_use_id:"t1",hook_event_name:"preToolUse"}')
  out=$(printf '%s' "$json" | bash "$HOOK")
  got=$(printf '%s' "$out" | jq -r '.updated_input.command // empty')
  if [ "$got" != "$want" ]; then
    echo "FAIL: $cmd"
    echo "  want: $want"
    echo "  got:  $got"
    echo "  full: $out"
    fail=1
  else
    echo "OK: $cmd -> $got"
  fi
}

check "git diff HEAD~1" "rtk git diff HEAD~1"
check "git status" "rtk git status"
check "grep -r foo ." "rtk grep -r foo ."
check "node -e \"console.log(1)\"" ""

exit "$fail"
