#!/usr/bin/env bash
# Install RTK for Windsurf Cascade.
# - User: ~/.codeium/windsurf/hooks.json
# - Project: .windsurf/hooks.json + .windsurfrules (INSTALL_SCOPE=project)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK_SCRIPT="${SCRIPT_DIR}/rtk-windsurf-prerun.sh"
RULES_TEMPLATE="${SCRIPT_DIR}/windsurfrules.template"
SCOPE="${INSTALL_SCOPE:-global}"
ENFORCE="${RTK_WINDSURF_ENFORCE:-1}"

if [ "$SCOPE" = "project" ]; then
  HOOKS_DIR="$(pwd)/.windsurf/hooks"
  CONFIG_PATH="$(pwd)/.windsurf/hooks.json"
  HOOK_CMD="bash .windsurf/hooks/rtk-windsurf-prerun.sh"
  RULES_PATH="$(pwd)/.windsurfrules"
else
  HOOKS_DIR="${HOME}/.codeium/windsurf/hooks"
  CONFIG_PATH="${HOME}/.codeium/windsurf/hooks.json"
  HOOK_CMD="bash ${HOOKS_DIR}/rtk-windsurf-prerun.sh"
  RULES_PATH=""
fi

mkdir -p "$HOOKS_DIR"
install -m 755 "$HOOK_SCRIPT" "${HOOKS_DIR}/rtk-windsurf-prerun.sh"

if [ "$SCOPE" = "project" ] && [ ! -f "$RULES_PATH" ]; then
  install -m 644 "$RULES_TEMPLATE" "$RULES_PATH"
  echo "Installed $RULES_PATH"
elif [ "$SCOPE" = "project" ] && [ -f "$RULES_PATH" ]; then
  echo "Rules present: $RULES_PATH"
fi

export HOOK_CMD CONFIG_PATH ENFORCE
python3 - <<'PY'
import json
import os
from pathlib import Path

hook_cmd = os.environ["HOOK_CMD"]
config_path = Path(os.environ["CONFIG_PATH"])
enforce = os.environ.get("ENFORCE", "1") == "1"

data = {}
if config_path.exists():
    data = json.loads(config_path.read_text())

hooks = data.setdefault("hooks", {})

if enforce:
    entry = {
        "command": hook_cmd,
        "show_output": True,
    }
    prerun = hooks.setdefault("pre_run_command", [])
    legacy_markers = ("rtk-windsurf-prerun.sh", "rtk hook", "rtk rewrite")
    prerun[:] = [
        block
        for block in prerun
        if not any(marker in (block.get("command") or "") for marker in legacy_markers)
    ]
    if not any(block.get("command") == hook_cmd for block in prerun):
        prerun.insert(0, entry)
else:
    hooks.pop("pre_run_command", None)

config_path.parent.mkdir(parents=True, exist_ok=True)
config_path.write_text(json.dumps(data, indent=2) + "\n")
print(f"Updated {config_path}")
print(json.dumps(data, indent=2))
PY

if [ "$SCOPE" = "project" ] && command -v rtk >/dev/null 2>&1; then
  rtk init -g --agent windsurf --auto-patch >/dev/null 2>&1 || true
fi

echo "RTK Windsurf installed (${SCOPE}, enforce=${ENFORCE}). Restart Windsurf/Cascade."
