import fs from "node:fs";
import path from "node:path";
import { BACKUPS_DIR, ensureDirs } from "./paths.js";
import { timestampSlug, getAppVersion } from "./version.js";

const KEEP_BACKUPS = 5;
const BACKUP_DIR_MODE = 0o700;
const BACKUP_FILE_MODE = 0o600;

export function makeBackupDir(label) {
  ensureDirs();
  const ver = getAppVersion();
  const slug = `${label}-${ver}-${timestampSlug()}`;
  const dir = path.join(BACKUPS_DIR, slug);
  fs.mkdirSync(dir, { recursive: true, mode: BACKUP_DIR_MODE });
  try { fs.chmodSync(dir, BACKUP_DIR_MODE); } catch {}
  return dir;
}

export function backupFile(srcPath, destDir, destName = null) {
  if (!fs.existsSync(srcPath)) return null;
  const name = destName || path.basename(srcPath);
  const dest = path.join(destDir, name);
  fs.copyFileSync(srcPath, dest);
  try { fs.chmodSync(dest, BACKUP_FILE_MODE); } catch {}
  return dest;
}

/** Checkpoint WAL (if supported), then copy data.sqlite and any -wal/-shm sidecars. */
export function backupSqliteFile(adapter, srcPath, destDir, destName = null) {
  if (adapter && typeof adapter.checkpoint === "function") {
    try { adapter.checkpoint(); } catch {}
  }
  const main = backupFile(srcPath, destDir, destName);
  if (!main) return null;
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${srcPath}${suffix}`;
    if (fs.existsSync(sidecar)) backupFile(sidecar, destDir);
  }
  return main;
}

export function pruneOldBackups() {
  if (!fs.existsSync(BACKUPS_DIR)) return;
  const entries = fs.readdirSync(BACKUPS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const full = path.join(BACKUPS_DIR, e.name);
      // statSync can throw if the entry is removed mid-prune (TOCTOU); skip it.
      try { return { name: e.name, full, mtime: fs.statSync(full).mtimeMs }; }
      catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);

  for (const old of entries.slice(KEEP_BACKUPS)) {
    try { fs.rmSync(old.full, { recursive: true, force: true }); } catch {}
  }
}
