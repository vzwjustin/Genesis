#!/usr/bin/env bash
# Install RTK hooks for Devin CLI (global ~/.config/devin/config.json).
# Project hooks: INSTALL_SCOPE=project bash install.sh (from repo root)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK_SCRIPT="${SCRIPT_DIR}/rtk-devin-pretooluse.sh"
SCOPE="${INSTALL_SCOPE:-global}"

if [ "$SCOPE" = "project" ]; then
  HOOKS_DIR="$(pwd)/.devin/hooks"
  CONFIG_PATH="$(pwd)/.devin/hooks.v1.json"
  mkdir -p "$HOOKS_DIR"
  install -m 755 "$HOOK_SCRIPT" "${HOOKS_DIR}/rtk-devin-pretooluse.sh"
  HOOK_CMD="bash .devin/hooks/rtk-devin-pretooluse.sh"
  WRAPPER_BASE="$(pwd)/.devin/hooks.v1.json"
else
  HOOKS_DIR="${HOME}/.config/devin/hooks"
  CONFIG_PATH="${HOME}/.config/devin/config.json"
  mkdir -p "$HOOKS_DIR"
  install -m 755 "$HOOK_SCRIPT" "${HOOKS_DIR}/rtk-devin-pretooluse.sh"
  HOOK_CMD="bash ${HOOKS_DIR}/rtk-devin-pretooluse.sh"
  WRAPPER_BASE="${CONFIG_PATH}"
fi

export HOOK_CMD WRAPPER_BASE CONFIG_PATH
python3 - <<'PY'
import json
import os
from pathlib import Path

hook_cmd = os.environ["HOOK_CMD"]
config_path = Path(os.environ["CONFIG_PATH"])

if config_path.name == "hooks.v1.json":
    data = {}
    if config_path.exists():
        data = json.loads(config_path.read_text())
else:
    data = {"version": 1}
    if config_path.exists():
        data = json.loads(config_path.read_text())

hook_entry = {
    "matcher": "^exec$",
    "hooks": [
        {
            "type": "command",
            "command": hook_cmd,
            "timeout": 10,
        }
    ],
}

hooks = data.setdefault("hooks", {})
pretool = hooks.setdefault("PreToolUse", [])

legacy_cmds = {"rtk hook claude", "rtk hook devin"}
pretool[:] = [
    block
    for block in pretool
    if block.get("matcher") != "^exec$"
    and not any(
        h.get("command") in legacy_cmds
        or "rtk-devin-pretooluse.sh" in (h.get("command") or "")
        for h in block.get("hooks", [])
        if h.get("type") == "command"
    )
]

pretool.insert(0, hook_entry)

config_path.parent.mkdir(parents=True, exist_ok=True)
config_path.write_text(json.dumps(data, indent=2) + "\n")
print(f"Updated {config_path}")
print(json.dumps(data, indent=2))
PY

echo "RTK Devin hook installed (${SCOPE})."
