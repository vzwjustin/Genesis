#!/usr/bin/env bash
# Wire RTK stats into Cursor (Shell hook) and Headroom dashboard.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
HEADROOM_PORT="${HEADROOM_PORT:-8787}"
HEADROOM_HOST="${HEADROOM_HOST:-127.0.0.1}"
RTK_PROJECT_DIR="${HEADROOM_RTK_PROJECT_DIR:-${REPO_ROOT}}"

echo "==> Installing Cursor RTK preToolUse hook"
bash "${SCRIPT_DIR}/cursor-hooks/install.sh"

echo "==> Patching Headroom RTK project-dir polling"
"${SCRIPT_DIR}/patch-headroom-rtk-project-dir.py"

echo "==> RTK project scope: ${RTK_PROJECT_DIR}"
rtk gain -p 2>&1 | head -12 || true

if ! command -v headroom >/dev/null 2>&1; then
  echo "headroom CLI not found; skip proxy restart"
  exit 0
fi

if curl -fsS --max-time 2 "http://${HEADROOM_HOST}:${HEADROOM_PORT}/health" >/dev/null 2>&1; then
  echo "==> Restarting Headroom proxy on ${HEADROOM_HOST}:${HEADROOM_PORT}"
  pid="$(lsof -ti tcp:"${HEADROOM_PORT}" 2>/dev/null | head -1 || true)"
  if [ -n "${pid}" ]; then
    kill "${pid}" 2>/dev/null || true
    sleep 1
  fi
  export HEADROOM_RTK_PROJECT_DIR="${RTK_PROJECT_DIR}"
  nohup env HEADROOM_RTK_PROJECT_DIR="${RTK_PROJECT_DIR}" \
    headroom proxy --host "${HEADROOM_HOST}" --port "${HEADROOM_PORT}" \
    >>"${HOME}/.headroom/logs/proxy-rtk-restart.log" 2>&1 &
  healthy=0
  for _ in $(seq 1 15); do
    if curl -fsS --max-time 3 "http://${HEADROOM_HOST}:${HEADROOM_PORT}/health" >/dev/null 2>&1; then
      healthy=1
      break
    fi
    sleep 2
  done
  if [ "${healthy}" -eq 1 ]; then
    curl -fsS -X POST "http://${HEADROOM_HOST}:${HEADROOM_PORT}/stats/reset" >/dev/null || true
    echo "==> Headroom proxy healthy; RTK stats baseline reset"
    curl -fsS "http://${HEADROOM_HOST}:${HEADROOM_PORT}/stats?cached=1" \
      | python3 -c "
import json,sys
d=json.load(sys.stdin)
ct=d.get('cli_filtering') or d.get('context_tool') or {}
life=ct.get('lifetime') or {}
sess=ct.get('session') or {}
print('Headroom RTK lifetime commands:', life.get('commands'))
print('Headroom RTK session commands:', sess.get('commands'))
print('Headroom RTK lifetime tokens_saved:', life.get('tokens_saved'))
"
  else
    echo "proxy restart failed — check ${HOME}/.headroom/logs/proxy-rtk-restart.log"
    exit 1
  fi
else
  echo "No Headroom proxy on ${HEADROOM_HOST}:${HEADROOM_PORT}; start with:"
  echo "  HEADROOM_RTK_PROJECT_DIR=${RTK_PROJECT_DIR} headroom proxy --host ${HEADROOM_HOST} --port ${HEADROOM_PORT}"
fi

echo "Done. New Cursor Shell commands will route through RTK after hook reload."
