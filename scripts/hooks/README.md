# Agent harness hooks (RTK / Caveman)

Optional **PreToolUse** hooks that compress large shell tool output before it reaches the model. They are **not** part of the 9router request path; install only if you use RTK/Caveman in Cursor, Devin, or Windsurf.

## Layout

| Directory | Target harness | Install |
|-----------|----------------|---------|
| `scripts/cursor-hooks/` | Cursor (`~/.cursor/hooks.json`) | `./scripts/cursor-hooks/install.sh` |
| `scripts/devin-hooks/` | Devin (`.devin/hooks.v1.json`) | `./scripts/devin-hooks/install.sh` |
| `scripts/windsurf-hooks/` | Windsurf (`.windsurf/hooks.json`) | `./scripts/windsurf-hooks/install.sh` |

Each bundle includes:

- `install.sh` — copies the hook script and merges JSON config (idempotent)
- `rtk-*-pretooluse.sh` — runs `rtk hook <harness>` on **Shell** tool calls only
- `test-hook.sh` — smoke test with sample JSON on stdin

## Security

- Hooks run **on your machine** with your user privileges when the agent invokes Shell.
- Install scripts only register a fixed path to the bundled shell script; they do not download remote code.
- Review `rtk-*-pretooluse.sh` before installing. Do not point hooks at untrusted scripts.
- Hooks may read tool arguments (commands, paths). Treat hook logs like any local shell history.
- Uninstall: remove the hook entry from the harness `hooks.json` and delete the copied script under `~/.cursor/hooks/` (or the harness-specific hooks dir).

## Verify

```bash
./scripts/cursor-hooks/test-hook.sh   # or devin-hooks / windsurf-hooks
```

Expected: compressed or passthrough JSON on stdout; non-zero exit only when `rtk` is missing and the hook is configured to fail closed (see script).
