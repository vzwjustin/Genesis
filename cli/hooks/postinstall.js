#!/usr/bin/env node

// Postinstall: warm-up SQLite deps into ~/.9router/runtime so the first
// `9router` start doesn't need network. Failure here is non-fatal —
// cli.js will retry at runtime if anything is missing.
const { execSync } = require("child_process");
const { ensureSqliteRuntime } = require("./sqliteRuntime");
const { ensureTrayRuntime } = require("./trayRuntime");

try {
  ensureTrayRuntime({ silent: false });
} catch (e) {
  console.warn(`[9router] tray runtime skipped: ${e.message}`);
}

try {
  ensureSqliteRuntime({ silent: false });
  console.log("[9router] runtime SQLite deps ready");
} catch (e) {
  console.warn(`[9router] runtime warm-up skipped: ${e.message}`);
}

// Optional Headroom ML compression (local Python proxy or Headroom Cloud API key).
try {
  execSync("headroom --version", { stdio: "ignore" });
  console.log("[9router] headroom CLI detected — proxy auto-starts when 9router runs");
} catch {
  if (process.env.HEADROOM_API_KEY) {
    console.log("[9router] HEADROOM_API_KEY set — Headroom Cloud compression available");
  } else {
    console.log("[9router] tip: pipx install \"headroom-ai[proxy]\" for auto-start ML compression — or set HEADROOM_API_KEY for cloud");
  }
}

process.exit(0);
