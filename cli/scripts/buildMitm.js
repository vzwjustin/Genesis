const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

// ── Build config ─────────────────────────────────────────
const BUILD_CONFIG = {
  bundle: true,
  minify: true,
  cleanPlainFiles: true,
};
// ─────────────────────────────────────────────────────────

const cliDir = path.resolve(__dirname, "..");
const appDir = path.resolve(cliDir, "..");
const cliMitmDir = path.join(cliDir, "app", "src", "mitm");
// Bundle everything — no externals. This keeps MITM runtime self-contained so
// it can be copied to DATA_DIR/runtime/ and spawned from there (escapes
// node_modules file locks that block `npm i -g genesis@latest` on Windows).
// better-sqlite3 loads from ~/.genesis/runtime/node_modules via NODE_PATH at MITM spawn.
const EXTERNALS = ["better-sqlite3"];
const ENTRIES = ["server.js"];
const MITM_RUNTIME_ASSETS = ["sql-wasm.wasm"];

async function buildEntry(entry) {
  const mitmSrc = path.join(appDir, "src", "mitm");
  const output = path.join(cliMitmDir, entry);

  const buildPlugin = {
    name: "build-plugin",
    setup(build) {
      // Stub .git file scanned by esbuild
      build.onResolve({ filter: /\.git/ }, args => ({ path: args.path, namespace: "git-stub" }));
      build.onLoad({ filter: /.*/, namespace: "git-stub" }, () => ({ contents: "module.exports={}", loader: "js" }));

      // Runtime-only drivers pulled transitively via proxyFetch → settingsRepo → driver.
      // MITM always runs under Node; stub Bun/Node native drivers so the bundle builds.
      build.onResolve({ filter: /^bun:sqlite$/ }, () => ({ path: "bun:sqlite", namespace: "runtime-driver-stub" }));
      build.onResolve({ filter: /^node:sqlite$/ }, () => ({ path: "node:sqlite", namespace: "runtime-driver-stub" }));
      build.onLoad({ filter: /.*/, namespace: "runtime-driver-stub" }, () => ({
        contents: `throw new Error("Native SQLite driver unavailable in MITM bundle");`,
        loader: "js",
      }));
    },
  };

  const steps = [];

  if (BUILD_CONFIG.bundle) {
    await esbuild.build({
      entryPoints: [path.join(mitmSrc, entry)],
      bundle: true,
      minify: BUILD_CONFIG.minify,
      platform: "node",
      target: "node18",
      external: EXTERNALS,
      plugins: [buildPlugin],
      outfile: output,
    });
    steps.push("bundled");
    if (BUILD_CONFIG.minify) steps.push("minified");
  }

  console.log(`✅ ${steps.join(" + ")} → ${output}`);
}

function resolveSqlWasmSource() {
  const candidates = [
    path.join(appDir, "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
    path.join(cliDir, "app", "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
    path.join(cliDir, "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function copyMitmRuntimeAssets() {
  const wasmSrc = resolveSqlWasmSource();
  if (!wasmSrc) {
    console.warn("⚠️  sql-wasm.wasm not found — MITM sql.js fallback will fail if better-sqlite3 is unavailable");
    return;
  }
  for (const name of MITM_RUNTIME_ASSETS) {
    fs.copyFileSync(wasmSrc, path.join(cliMitmDir, name));
  }
  console.log(`✅ Copied MITM runtime assets → ${cliMitmDir}`);
}

async function run() {
  const flags = Object.entries(BUILD_CONFIG).filter(([, v]) => v).map(([k]) => k).join(", ");
  console.log(`⚙️  Config: ${flags}`);

  for (const entry of ENTRIES) await buildEntry(entry);

  if (BUILD_CONFIG.cleanPlainFiles) {
    const keep = new Set([...ENTRIES, ...MITM_RUNTIME_ASSETS]);
    for (const name of fs.readdirSync(cliMitmDir)) {
      if (!keep.has(name)) fs.rmSync(path.join(cliMitmDir, name), { recursive: true, force: true });
    }
    console.log("✅ Removed plain MITM files from CLI bundle");
  }

  copyMitmRuntimeAssets();
}

run().catch((e) => { console.error(e); process.exit(1); });
