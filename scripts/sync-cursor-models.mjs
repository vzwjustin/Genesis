#!/usr/bin/env node
/**
 * Compare Cursor CLI model list against open-sse/config/providerModels.js (cu:).
 *
 * Usage:
 *   cursor agent models > /tmp/cursor-models.txt
 *   node scripts/sync-cursor-models.mjs /tmp/cursor-models.txt
 *
 * Or with one model id per line on stdin:
 *   cursor agent models | node scripts/sync-cursor-models.mjs
 */
import { readFileSync } from "node:fs";
import { PROVIDER_MODELS } from "../open-sse/config/providerModels.js";

function loadIdsFromText(text) {
  const ids = new Set();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const id = trimmed.split(/\s+/)[0].replace(/^["']|["']$/g, "");
    if (id && /^[a-z0-9][a-z0-9._-]*$/i.test(id)) ids.add(id);
  }
  return ids;
}

const inputPath = process.argv[2];
const raw = inputPath
  ? readFileSync(inputPath, "utf8")
  : await new Promise((resolve) => {
      let buf = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (c) => { buf += c; });
      process.stdin.on("end", () => resolve(buf));
    });

if (!raw.trim()) {
  console.error("No input. Run: cursor agent models | node scripts/sync-cursor-models.mjs");
  process.exit(1);
}

const cliIds = loadIdsFromText(raw);
const catalogIds = new Set((PROVIDER_MODELS.cu || []).map((m) => m.id));

const missing = [...cliIds].filter((id) => !catalogIds.has(id)).sort();
const extra = [...catalogIds].filter((id) => !cliIds.has(id) && id !== "default").sort();

console.log(`CLI models: ${cliIds.size}`);
console.log(`Catalog (cu): ${catalogIds.size}`);
if (missing.length) {
  console.log("\nMissing from PROVIDER_MODELS.cu:");
  for (const id of missing) console.log(`  { id: "${id}", name: "${id}" },`);
}
if (extra.length) {
  console.log("\nIn catalog but not in CLI output (may be stale):");
  for (const id of extra) console.log(`  - ${id}`);
}
if (!missing.length && !extra.length) {
  console.log("\nCatalog matches CLI output.");
}
