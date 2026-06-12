#!/usr/bin/env python3
"""Patch installed Headroom to poll RTK stats from HEADROOM_RTK_PROJECT_DIR.

Headroom runs `rtk gain --project` using the proxy process cwd. When the proxy
starts from a subdirectory (e.g. cli/app), the dashboard shows near-zero RTK
stats even though the repo has substantial RTK history.

This patch is idempotent. Re-run after `pipx upgrade headroom-ai`.
"""
from __future__ import annotations

import sys
from pathlib import Path


MARKER = "HEADROOM_RTK_PROJECT_DIR"
HELPERS_REL = Path("headroom/proxy/helpers.py")

RTK_PROJECT_DIR_HELPER = '''
_RTK_PROJECT_DIR_ENV = "HEADROOM_RTK_PROJECT_DIR"


def _rtk_stats_project_dir() -> str | None:
    """Directory passed to `rtk gain --project` (RTK project scope)."""
    raw = os.environ.get(_RTK_PROJECT_DIR_ENV, "").strip()
    if not raw:
        return None
    expanded = os.path.expanduser(raw)
    return expanded if os.path.isdir(expanded) else None
'''

SUBPROCESS_OLD = """        result = subprocess.run(
            [str(rtk_path), "gain", "--project", "--format", "json"],
            capture_output=True,
            text=True,
            timeout=5,
        )"""

SUBPROCESS_NEW = """        rtk_cwd = _rtk_stats_project_dir()
        result = subprocess.run(
            [str(rtk_path), "gain", "--project", "--format", "json"],
            capture_output=True,
            text=True,
            timeout=5,
            cwd=rtk_cwd,
        )"""


def find_helpers() -> Path | None:
    try:
        import headroom.proxy.helpers as helpers  # type: ignore

        return Path(helpers.__file__)
    except Exception:
        pass

    candidates = [
        Path.home() / ".local/pipx/venvs/headroom-ai/lib",
    ]
    for base in candidates:
        if not base.exists():
            continue
        for pyver in sorted(base.glob("python*/site-packages/headroom/proxy/helpers.py")):
            return pyver
    return None


def patch_helpers(path: Path) -> bool:
    text = path.read_text()
    if MARKER in text and "rtk_cwd = _rtk_stats_project_dir()" in text:
        print(f"already patched: {path}")
        return False

    if "_CONTEXT_TOOL_ENV = " not in text:
        print(f"unexpected helpers.py layout: {path}", file=sys.stderr)
        return False

    if SUBPROCESS_OLD not in text:
        print(f"subprocess block not found (headroom version mismatch?): {path}", file=sys.stderr)
        return False

    if MARKER not in text:
        text = text.replace(
            '_CONTEXT_TOOL_ENV = "HEADROOM_CONTEXT_TOOL"',
            '_CONTEXT_TOOL_ENV = "HEADROOM_CONTEXT_TOOL"' + RTK_PROJECT_DIR_HELPER,
            1,
        )

    text = text.replace(SUBPROCESS_OLD, SUBPROCESS_NEW, 1)
    path.write_text(text)
    print(f"patched: {path}")
    return True


def main() -> int:
    helpers = find_helpers()
    if helpers is None:
        print("headroom.proxy.helpers not found — is headroom-ai installed?", file=sys.stderr)
        return 1
    patch_helpers(helpers)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
