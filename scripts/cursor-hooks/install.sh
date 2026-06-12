#!/usr/bin/env bash
# Install RTK cursor-agent hooks into ~/.cursor/hooks.json
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK_SCRIPT="${SCRIPT_DIR}/rtk-cursor-pretooluse.sh"
CURSOR_DIR="${HOME}/.cursor"
HOOKS_DIR="${CURSOR_DIR}/hooks"
HOOKS_JSON="${CURSOR_DIR}/hooks.json"

mkdir -p "$HOOKS_DIR"
install -m 755 "$HOOK_SCRIPT" "${HOOKS_DIR}/rtk-cursor-pretooluse.sh"

python3 - <<'PY'
import json
import os
from pathlib import Path

hooks_json = Path(os.environ["HOME"]) / ".cursor" / "hooks.json"
hook_script = Path(os.environ["HOME"]) / ".cursor" / "hooks" / "rtk-cursor-pretooluse.sh"
hook_cmd = f"bash {hook_script}"

data = {"version": 1, "hooks": {}}
if hooks_json.exists():
    data = json.loads(hooks_json.read_text())

hooks = data.setdefault("hooks", {})
pretool = hooks.setdefault("preToolUse", [])

# Remove legacy/broken direct rtk hook entries (incl. missing rtk-rewrite.sh)
def _is_legacy_rtk_hook(entry: dict) -> bool:
    cmd = str(entry.get("command", ""))
    return cmd in ("rtk hook cursor", hook_cmd, str(hook_script)) or "rtk-rewrite" in cmd

pretool[:] = [h for h in pretool if not _is_legacy_rtk_hook(h)]

entry = {
    "command": hook_cmd,
    "matcher": "Shell",
}
if not any(h.get("command") == hook_cmd and h.get("matcher") == "Shell" for h in pretool):
    pretool.insert(0, entry)

hooks_json.write_text(json.dumps(data, indent=2) + "\n")
print(f"Updated {hooks_json}")
print(json.dumps(data, indent=2))
PY

echo "RTK cursor-agent hook installed."
