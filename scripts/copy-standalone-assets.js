#!/usr/bin/env node

// Next.js `output: "standalone"` does not copy .next/static or public/
// into the standalone dir. cli.js runs .next/standalone/server.js, so
// without these assets the packaged CLI serves broken static files.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const standalone = path.join(root, ".next", "standalone");

if (!fs.existsSync(path.join(standalone, "server.js"))) {
  console.log("No standalone build; skipping asset copy");
  process.exit(0);
}

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  return true;
}

const pairs = [
  [path.join(root, ".next", "static"), path.join(standalone, ".next", "static")],
  [path.join(root, "public"), path.join(standalone, "public")],
];

for (const [src, dest] of pairs) {
  if (copyRecursive(src, dest)) {
    console.log(`Copied ${path.relative(root, src)} to ${path.relative(root, dest)}`);
  }
}
