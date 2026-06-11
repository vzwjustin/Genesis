#!/usr/bin/env bash
# Windsurf Cascade pre_run_command — enforce RTK for rewriteable shell commands.
# Cascade hooks cannot replace command_line; we block raw commands and stderr the rtk form.
set -euo pipefail

input=$(cat)
if [ -z "$input" ]; then
  exit 0
fi

export PATH="${HOME}/.local/bin:${PATH}"
command=$(printf '%s' "$input" | jq -r '.tool_info.command_line // empty' 2>/dev/null || true)

if [ -z "$command" ]; then
  exit 0
fi

if ! command -v rtk >/dev/null 2>&1; then
  exit 0
fi

# Already RTK-wrapped.
case "$command" in
  rtk\ *) exit 0 ;;
esac

# rtk rewrite prints the rewritten command on stdout; exit code may be 3 on success.
rewritten=$(rtk rewrite "$command" 2>/dev/null || true)
if [ -n "$rewritten" ] && [ "$rewritten" != "$command" ]; then
  printf 'RTK: use this command instead: %s\n' "$rewritten" >&2
  exit 2
fi

exit 0
