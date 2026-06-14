#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const cliDir = path.resolve(__dirname, "..");
const appDir = path.resolve(cliDir, "..");
const rootDir = path.resolve(appDir, "..");
const cliAppDir = path.join(cliDir, "app");
const buildHomeDir = path.join(cliDir, ".build-home");
const buildDistDirName = ".next-cli-build";
const buildDistDir = path.join(appDir, buildDistDirName);

// Exclude patterns for files/folders we don't want to copy
const EXCLUDE_PATTERNS = [
  "@img",           // Sharp image processing (not needed with unoptimized images)
  "sharp",          // Sharp core lib (not needed with unoptimized images)
  "detect-libc",    // Sharp dependency
  "logs",           // Runtime logs
  ".env",           // Environment files
  ".env.local",
  ".env.*.local",
  "*.log",          // Log files
  "tmp",            // Temp files
  ".DS_Store",      // macOS files
];

function shouldExclude(name) {
  return EXCLUDE_PATTERNS.some(pattern => {
    if (pattern.includes("*")) {
      const regex = new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
      return regex.test(name);
    }
    return name === pattern;
  });
}

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) {
    console.warn(`Warning: Source ${src} does not exist`);
    return;
  }
  
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (shouldExclude(entry.name)) {
      continue;
    }

    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    // Skip broken symlinks (common in workspace setups)
    try {
      fs.accessSync(srcPath);
    } catch {
      continue;
    }

    if (entry.isDirectory()) {
      copyRecursive(srcPath, destPath);
    } else if (entry.isSymbolicLink()) {
      // Resolve and copy target (avoid linking outside bundle)
      try {
        const real = fs.realpathSync(srcPath);
        if (fs.statSync(real).isDirectory()) {
          copyRecursive(real, destPath);
        } else {
          fs.copyFileSync(real, destPath);
        }
      } catch {}
    } else {
      try {
        fs.copyFileSync(srcPath, destPath);
      } catch {}
    }
  }
}

function findStandaloneApp(standaloneRootToUse) {
  const candidates = [
    standaloneRootToUse,
    path.join(standaloneRootToUse, "app"),
  ];

  if (fs.existsSync(standaloneRootToUse)) {
    for (const entry of fs.readdirSync(standaloneRootToUse, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        candidates.push(path.join(standaloneRootToUse, entry.name));
      }
    }
  }

  return candidates.find((candidate) => fs.existsSync(path.join(candidate, "server.js")));
}

console.log("📦 Building Genesis CLI package with Next.js...\n");

fs.mkdirSync(buildHomeDir, { recursive: true });
fs.mkdirSync(path.join(buildHomeDir, "AppData", "Roaming"), { recursive: true });
fs.mkdirSync(path.join(buildHomeDir, "AppData", "Local"), { recursive: true });

// Step 0: Keep cli/package.json and app/package.json on the same version (never downgrade).
function parseCoreVersion(version) {
  const match = String(version || "").trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareCoreVersions(a, b) {
  const pa = parseCoreVersion(a);
  const pb = parseCoreVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

function writePackageVersion(pkgPath, pkg, version) {
  if (pkg.version === version) return false;
  pkg.version = version;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  return true;
}

console.log("0️⃣  Syncing package versions...");
const cliPkgPath = path.join(cliDir, "package.json");
const appPkgPath = path.join(appDir, "package.json");
const cliPkg = JSON.parse(fs.readFileSync(cliPkgPath, "utf8"));
const appPkg = JSON.parse(fs.readFileSync(appPkgPath, "utf8"));
const targetVersion = compareCoreVersions(appPkg.version, cliPkg.version) > 0
  ? appPkg.version
  : cliPkg.version;

if (compareCoreVersions(appPkg.version, cliPkg.version) > 0) {
  console.log(`⚠️  cli/package.json (${cliPkg.version}) is behind app/package.json (${appPkg.version})`);
}

const cliChanged = writePackageVersion(cliPkgPath, cliPkg, targetVersion);
const appChanged = writePackageVersion(appPkgPath, appPkg, targetVersion);

if (cliChanged || appChanged) {
  console.log(`✅ Version synced to ${targetVersion}\n`);
} else {
  console.log(`✅ Version already synced: ${targetVersion}\n`);
}

// Clear stale webpack cache so open-sse/ and other out-of-src edits are picked up.
const webpackCacheDir = path.join(buildDistDir, "cache", "webpack");
if (fs.existsSync(webpackCacheDir)) {
  console.log("🧹 Clearing stale CLI webpack cache (.next-cli-build/cache/webpack)...");
  fs.rmSync(webpackCacheDir, { recursive: true, force: true });
  console.log("✅ Purged stale webpack cache\n");
}

// Step 1: Build app with Next.js (workspace tracing root → traced node_modules in standalone).
console.log("1️⃣  Building Next.js app...");
try {
  execSync("npm run build", {
    stdio: "inherit",
    cwd: appDir,
    env: {
      ...process.env,
      HOME: buildHomeDir,
      USERPROFILE: buildHomeDir,
      APPDATA: path.join(buildHomeDir, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(buildHomeDir, "AppData", "Local"),
      NEXT_DIST_DIR: buildDistDirName,
      NEXT_TRACING_ROOT_MODE: "workspace",
    }
  });
  console.log("✅ Next.js build completed\n");
} catch (error) {
  console.error("❌ Next.js build failed");
  process.exit(1);
}

// Step 2: Clean old app/cli/app if exists
console.log("2️⃣  Cleaning old app/cli/app...");
if (fs.existsSync(cliAppDir)) {
  fs.rmSync(cliAppDir, { recursive: true, force: true });
}
console.log("✅ Cleaned\n");

// Step 3: Copy Next.js standalone build to app/cli/app.
// Newer Next.js standalone output writes server.js/package.json plus .next/, src/, and
// node_modules/ directly under .next/standalone. Older builds may still use a nested app/.
console.log("3️⃣  Copying Next.js standalone build to app/cli/app...");
const standaloneRoot = path.join(appDir, ".next", "standalone");
const standaloneRootResolved = path.join(buildDistDir, "standalone");
const standaloneRootToUse = fs.existsSync(standaloneRootResolved) ? standaloneRootResolved : standaloneRoot;
const standaloneApp = findStandaloneApp(standaloneRootToUse);
if (!standaloneApp) {
  console.error("❌ Next.js standalone build not found under .next/standalone");
  console.error("Expected .next/standalone/server.js, .next/standalone/app/server.js, or a workspace-nested server.js");
  process.exit(1);
}
copyRecursive(standaloneApp, cliAppDir);

// Older nested-app layout stores traced node_modules at standalone root.
const standaloneNodeModules = path.join(standaloneRootToUse, "node_modules");
if (standaloneApp !== standaloneRootToUse && fs.existsSync(standaloneNodeModules)) {
  copyRecursive(standaloneNodeModules, path.join(cliAppDir, "node_modules"));
}
console.log("✅ Copied standalone build\n");

// Step 3b: Ensure sql.js (pure JS fallback) bundled in app/cli/app/node_modules.
// Strip better-sqlite3 (native) — it lives in ~/.genesis/runtime to avoid
// Windows EBUSY during global CLI updates. node:sqlite (Node ≥22.5) is also
// available as a no-install middle tier.
console.log("3️⃣ b Configuring SQLite drivers...");
function ensureModuleInBundle(pkg) {
  const dest = path.join(cliAppDir, "node_modules", pkg);
  if (fs.existsSync(dest)) {
    console.log(`✅ ${pkg} already bundled`);
    return;
  }
  const candidates = [
    path.join(appDir, "node_modules", pkg),
    path.join(rootDir, "node_modules", pkg),
  ];
  const src = candidates.find((p) => fs.existsSync(p));
  if (!src) {
    console.warn(`⚠️  ${pkg} not found locally — bundle will rely on node:sqlite or runtime install`);
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  copyRecursive(src, dest);
  console.log(`✅ Bundled ${pkg}`);
}
ensureModuleInBundle("sql.js");
const betterDir = path.join(cliAppDir, "node_modules", "better-sqlite3");
if (fs.existsSync(betterDir)) {
  fs.rmSync(betterDir, { recursive: true, force: true });
  console.log("✅ Stripped better-sqlite3 (lives in ~/.genesis/runtime)");
}
console.log("");

// Step 4: Copy static files
console.log("4️⃣  Copying static files...");
const staticSrc = path.join(appDir, ".next", "static");
const staticSrcResolved = path.join(buildDistDir, "static");
const staticDest = path.join(cliAppDir, buildDistDirName, "static");
if (fs.existsSync(staticSrcResolved) || fs.existsSync(staticSrc)) {
  const staticActual = fs.existsSync(staticSrcResolved) ? staticSrcResolved : staticSrc;
  copyRecursive(staticActual, staticDest);
  // Also copy to standalone/.next/static so cli.js server can serve /_next/static/
  const standaloneStaticDest = path.join(standaloneRootToUse, ".next", "static");
  copyRecursive(staticActual, standaloneStaticDest);
  console.log("✅ Copied static files\n");
} else {
  console.log("⏭️  No static files found\n");
}

// Step 5: Copy public folder if exists
console.log("5️⃣  Copying public folder...");
const publicSrc = path.join(appDir, "public");
const publicDest = path.join(cliAppDir, "public");
if (fs.existsSync(publicSrc)) {
  copyRecursive(publicSrc, publicDest);
  // Also copy to standalone/public so cli.js server can serve public assets
  const standalonePublicDest = path.join(standaloneRootToUse, "public");
  copyRecursive(publicSrc, standalonePublicDest);
  console.log("✅ Copied public folder\n");
} else {
  console.log("⏭️  No public folder found\n");
}

// Step 6: Copy vendor-chunks (required for production)
console.log("6️⃣  Copying vendor-chunks...");
const vendorChunksSrc = path.join(appDir, ".next", "server", "vendor-chunks");
const vendorChunksSrcResolved = path.join(buildDistDir, "server", "vendor-chunks");
const vendorChunksDest = path.join(cliAppDir, buildDistDirName, "server", "vendor-chunks");
if (fs.existsSync(vendorChunksSrcResolved) || fs.existsSync(vendorChunksSrc)) {
  copyRecursive(fs.existsSync(vendorChunksSrcResolved) ? vendorChunksSrcResolved : vendorChunksSrc, vendorChunksDest);
  console.log("✅ Copied vendor-chunks\n");
} else {
  console.log("⏭️  No vendor-chunks found\n");
}

// Step 7: Copy MITM server files + shared constants (not bundled by Next.js standalone)
console.log("7️⃣  Copying MITM server files...");
const sharedSrc = path.join(appDir, "src", "shared");
if (fs.existsSync(sharedSrc)) {
  const standaloneSharedDest = path.join(standaloneRootToUse, "src", "shared");
  copyRecursive(sharedSrc, standaloneSharedDest);
  copyRecursive(sharedSrc, path.join(cliAppDir, "src", "shared"));
}
const mitmSrc = path.join(appDir, "src", "mitm");
const mitmDest = path.join(cliAppDir, "src", "mitm");
if (fs.existsSync(mitmSrc)) {
  copyRecursive(mitmSrc, mitmDest);
  // Also copy to standalone/src/mitm so cli.js server can load all mitm modules
  const standaloneMitmDest = path.join(standaloneRootToUse, "src", "mitm");
  copyRecursive(mitmSrc, standaloneMitmDest);
  console.log("✅ Copied MITM files\n");
} else {
  console.log("⏭️  No MITM files found\n");
}

// Step 7b: Copy standalone updater (headless Node process for install progress)
console.log("7️⃣ b Copying updater files...");
const updaterSrc = path.join(appDir, "src", "lib", "updater");
const updaterDest = path.join(cliAppDir, "src", "lib", "updater");
if (fs.existsSync(updaterSrc)) {
  copyRecursive(updaterSrc, updaterDest);
  console.log("✅ Copied updater files\n");
} else {
  console.log("⏭️  No updater files found\n");
}

// Step 8: Build MITM server (config driven - see app/cli/scripts/buildMitm.js)
console.log("8️⃣  Building MITM server...");
try {
  execSync("node scripts/buildMitm.js", { stdio: "inherit", cwd: cliDir });
  console.log("✅ MITM server build completed\n");
} catch (error) {
  console.error("❌ MITM build failed");
  process.exit(1);
}

console.log("✨ CLI package build completed!");
console.log(`📁 Output: ${cliAppDir}`);

try {
  const { execSync: exec } = require("child_process");
  const size = exec(`du -sh "${cliAppDir}"`, { encoding: "utf8" }).trim();
  console.log(`📊 Package size: ${size.split("\t")[0]}`);
} catch (e) {
  // Silent fail on size check
}
