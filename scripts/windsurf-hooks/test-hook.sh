#!/usr/bin/env bash
set -euo pipefail

HOOK="${1:-$(cd "$(dirname "$0")" && pwd)/rtk-windsurf-prerun.sh}"

fail=0
check_block() {
  local cmd="$1"
  local json
  json=$(jq -n --arg c "$cmd" '{
    agent_action_name: "pre_run_command",
    tool_info: {command_line: $c, cwd: "/tmp"}
  }')
  set +e
  out=$(printf '%s' "$json" | bash "$HOOK" 2>&1)
  code=$?
  set -e
  if [ "$code" -ne 2 ]; then
    echo "FAIL: expected block for: $cmd (exit $code)"
    echo "  output: $out"
    fail=1
  else
    echo "OK: blocked $cmd"
    echo "  $out"
  fi
}

check_allow() {
  local cmd="$1"
  local json
  json=$(jq -n --arg c "$cmd" '{
    agent_action_name: "pre_run_command",
    tool_info: {command_line: $c, cwd: "/tmp"}
  }')
  set +e
  out=$(printf '%s' "$json" | bash "$HOOK" 2>&1)
  code=$?
  set -e
  if [ "$code" -ne 0 ]; then
    echo "FAIL: expected allow for: $cmd (exit $code)"
    echo "  output: $out"
    fail=1
  else
    echo "OK: allowed $cmd"
  fi
}

check_block "git diff HEAD~1"
check_block "grep -r foo ."
check_allow "rtk git status"
check_allow 'node -e "console.log(1)"'

exit "$fail"
