#!/usr/bin/env node

// Postinstall: warm-up SQLite deps into ~/.genesis/runtime so the first
// `genesis` start doesn't need network. Failure here is non-fatal —
// cli.js will retry at runtime if anything is missing.
const { execSync } = require("child_process");
const { ensureSqliteRuntime } = require("./sqliteRuntime");
const { ensureTrayRuntime } = require("./trayRuntime");

try {
  ensureTrayRuntime({ silent: false });
} catch (e) {
  console.warn(`[genesis] tray runtime skipped: ${e.message}`);
}

try {
  ensureSqliteRuntime({ silent: false });
  console.log("[genesis] runtime SQLite deps ready");
} catch (e) {
  console.warn(`[genesis] runtime warm-up skipped: ${e.message}`);
}

// Optional Headroom ML compression (local Python proxy or Headroom Cloud API key).
try {
  execSync("headroom --version", { stdio: "ignore" });
  console.log("[genesis] headroom CLI detected — proxy auto-starts when genesis runs");
} catch {
  if (process.env.HEADROOM_API_KEY) {
    console.log("[genesis] HEADROOM_API_KEY set — Headroom Cloud compression available");
  } else {
    console.log("[genesis] tip: pipx install \"headroom-ai[proxy]\" for auto-start ML compression — or set HEADROOM_API_KEY for cloud");
  }
}

process.exit(0);
