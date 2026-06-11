#!/usr/bin/env bash
# Cursor Agent preToolUse hook — rewrite Shell commands through RTK filters.
#
# rtk hook cursor (0.42.x) fails to rewrite common commands (git, grep, find).
# rtk hook claude applies the same rewrite rules reliably; this script bridges
# Claude hook output to Cursor's updated_input response format.
set -euo pipefail

input=$(cat)
if [ -z "$input" ]; then
  printf '%s\n' '{}'
  exit 0
fi

export PATH="${HOME}/.local/bin:${PATH}"

if ! command -v rtk >/dev/null 2>&1; then
  printf '%s\n' '{}'
  exit 0
fi

command=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
if [ -z "$command" ]; then
  printf '%s\n' '{}'
  exit 0
fi

claude_out=$(printf '%s' "$input" | rtk hook claude 2>/dev/null || printf '%s' '{}')
new_cmd=$(printf '%s' "$claude_out" | jq -r '
  .hookSpecificOutput.updatedInput.command //
  .updated_input.command //
  .updatedInput.command //
  empty
' 2>/dev/null || true)

if [ -z "$new_cmd" ] || [ "$new_cmd" = "$command" ]; then
  printf '%s\n' '{}'
  exit 0
fi

printf '%s' "$input" | jq --arg cmd "$new_cmd" '
  .tool_input as $ti |
  { permission: "allow", updated_input: ($ti + {command: $cmd}) }
'
