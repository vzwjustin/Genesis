const { exec, spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { log, err } = require("../logger");
const { TOOL_HOSTS } = require("../../shared/constants/mitmToolHosts.js");
const { runElevatedPowerShell, isAdmin } = require("../winElevated.js");

/**
 * Atomic-ish write for Windows hosts file with rollback on failure.
 * Strategy: write `.new` sibling → rename current to `.bak` → rename `.new` to target.
 * If anything fails mid-way, restore from `.bak`. Same-volume renames are atomic on NTFS.
 */
function atomicWriteHostsWin(target, originalContent, newContent) {
  const tmpNew = `${target}.genesis.new`;
  const tmpBak = `${target}.genesis.bak`;
  try {
    fs.writeFileSync(tmpNew, newContent, "utf8");
    try { fs.unlinkSync(tmpBak); } catch { /* none */ }
    fs.renameSync(target, tmpBak);
    try {
      fs.renameSync(tmpNew, target);
    } catch (e) {
      // Rollback: restore original
      try { fs.renameSync(tmpBak, target); } catch { fs.writeFileSync(target, originalContent, "utf8"); }
      throw e;
    }
    try { fs.unlinkSync(tmpBak); } catch { /* best effort */ }
  } finally {
    try { fs.unlinkSync(tmpNew); } catch { /* already moved or never created */ }
  }
}

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
/** Ownership marker — only lines containing this are managed on add/remove. */
const MANAGED_HOSTS_MARKER = "# genesis-mitm";
const HOSTS_FILE = IS_WIN
  ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "drivers", "etc", "hosts")
  : "/etc/hosts";

/** True when `sudo` exists (e.g. missing on minimal Docker images like Alpine). */
function isSudoAvailable() {
  if (IS_WIN) return false;
  try {
    execSync("command -v sudo", { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function canRunSudoWithoutPassword() {
  if (IS_WIN || !isSudoAvailable()) return true;
  try {
    execSync("sudo -n true", { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function isSudoPasswordRequired() {
  return !IS_WIN && isSudoAvailable() && !canRunSudoWithoutPassword();
}

/**
 * Execute command with sudo password via stdin (macOS/Linux only).
 * Without sudo in PATH (containers), runs via sh — same user, no elevation.
 */
function execWithPassword(command, password) {
  return new Promise((resolve, reject) => {
    const useSudo = isSudoAvailable();
    const child = useSudo
      ? spawn("sudo", ["-S", "sh", "-c", command], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
      : spawn("sh", ["-c", command], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });

    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `Exit code ${code}`));
    });

    if (useSudo) {
      child.stdin.write(`${password}\n`);
      child.stdin.end();
    }
  });
}

/**
 * Trim trailing blank lines/whitespace, ensure file ends with exactly one newline.
 */
function normalizeHostsContent(content) {
  const eol = IS_WIN ? "\r\n" : "\n";
  return content.replace(/[\r\n\s]+$/g, "") + eol;
}

/**
 * Flush DNS cache (macOS/Linux)
 */
async function flushDNS(sudoPassword) {
  if (IS_WIN) return; // Windows flushes inline via ipconfig
  if (IS_MAC) {
    await execWithPassword("dscacheutil -flushcache && killall -HUP mDNSResponder", sudoPassword);
  } else {
    await execWithPassword("resolvectl flush-caches 2>/dev/null || true", sudoPassword);
  }
}

/**
 * True if a single hosts-file line maps the given hostname as an exact token.
 * Whole-file `String.includes(host)` is wrong: e.g. "cloudcode-pa.googleapis.com"
 * is a substring of "daily-cloudcode-pa.googleapis.com" (both managed hosts), which
 * caused false "active" status, blocked self-heal, and substring-based deletions.
 */
function hostsLineMatchesHost(line, host) {
  const noComment = String(line || "").split("#")[0];
  const tokens = noComment.trim().split(/\s+/).filter(Boolean);
  // tokens[0] is the IP; the hostname must appear as a subsequent exact token.
  return tokens.slice(1).includes(host);
}

function isManagedHostsLine(line) {
  return String(line || "").includes(MANAGED_HOSTS_MARKER);
}

function managedHostsLineMatchesHost(line, host) {
  return isManagedHostsLine(line) && hostsLineMatchesHost(line, host);
}

function formatManagedHostsEntry(host) {
  return `127.0.0.1 ${host} ${MANAGED_HOSTS_MARKER}`;
}

/** Remove only genesis-mitm–tagged lines that map any of the given hosts. */
function filterOutManagedHosts(content, hostsToRemove) {
  const eol = String(content || "").includes("\r\n") ? "\r\n" : "\n";
  return content.split(/\r?\n/)
    .filter(l => !(isManagedHostsLine(l) && hostsToRemove.some(h => hostsLineMatchesHost(l, h))))
    .join(eol);
}

/** True if any line in the hosts content maps the hostname as an exact token. */
function hostsContentHasHost(content, host) {
  return String(content || "").split(/\r?\n/).some(l => hostsLineMatchesHost(l, host));
}

function hostsContentHasManagedHost(content, host) {
  return String(content || "").split(/\r?\n/).some(l => managedHostsLineMatchesHost(l, host));
}

/**
 * Check if DNS entry exists for a specific host
 */
function checkDNSEntry(host = null) {
  try {
    const hostsContent = fs.readFileSync(HOSTS_FILE, "utf8");
    if (host) return hostsContentHasHost(hostsContent, host);
    // Legacy: check all antigravity hosts (backward compat)
    return TOOL_HOSTS.antigravity.every(h => hostsContentHasHost(hostsContent, h));
  } catch {
    return false;
  }
}

/**
 * Check DNS status per tool — returns { [tool]: boolean }
 */
function checkAllDNSStatus() {
  try {
    const hostsContent = fs.readFileSync(HOSTS_FILE, "utf8");
    const result = {};
    for (const [tool, hosts] of Object.entries(TOOL_HOSTS)) {
      result[tool] = hosts.every(h => hostsContentHasHost(hostsContent, h));
    }
    return result;
  } catch {
    return Object.fromEntries(Object.keys(TOOL_HOSTS).map(t => [t, false]));
  }
}

/**
 * Add DNS entries for a specific tool
 */
async function addDNSEntry(tool, sudoPassword) {
  const hosts = TOOL_HOSTS[tool];
  if (!hosts) throw new Error(`Unknown tool: ${tool}`);

  const entriesToAdd = hosts.filter(h => !checkDNSEntry(h));
  if (entriesToAdd.length === 0) {
    log(`🌐 DNS ${tool}: already active`);
    return;
  }

  try {
    if (IS_WIN) {
      // Read → trim → append → atomic write (Node-side, no CLI size limit)
      const current = fs.readFileSync(HOSTS_FILE, "utf8");
      const trimmed = current.replace(/[\r\n\s]+$/g, "");
      const toAppend = entriesToAdd.map(formatManagedHostsEntry).join("\r\n");
      const next = `${trimmed}\r\n${toAppend}\r\n`;
      atomicWriteHostsWin(HOSTS_FILE, current, next);
      await runElevatedPowerShell("ipconfig /flushdns | Out-Null");
    } else {
      const current = fs.readFileSync(HOSTS_FILE, "utf8");
      const trimmed = current.replace(/[\r\n\s]+$/g, "");
      const toAppend = entriesToAdd.map(formatManagedHostsEntry).join("\n");
      const next = `${trimmed}\n${toAppend}\n`;
      // Use tee via sudo to overwrite atomically — escape single quotes in content
      const escaped = next.replace(/'/g, "'\\''");
      // Write to a temp file then atomically rename — a `tee` straight onto
      // HOSTS_FILE truncates first, so an interrupt mid-write leaves it empty/partial.
      await execWithPassword(`printf '%s' '${escaped}' | tee ${HOSTS_FILE}.genesis.tmp > /dev/null && chmod 644 ${HOSTS_FILE}.genesis.tmp && mv -f ${HOSTS_FILE}.genesis.tmp ${HOSTS_FILE}`, sudoPassword);
      await flushDNS(sudoPassword);
    }
    log(`🌐 DNS ${tool}: ✅ added ${entriesToAdd.join(", ")}`);
  } catch (error) {
    const msg = error.message?.includes("incorrect password") ? "Wrong sudo password" : `Failed to add DNS entry: ${error.message}`;
    throw new Error(msg);
  }
}

/**
 * Remove DNS entries for a specific tool
 */
async function removeDNSEntry(tool, sudoPassword) {
  const hosts = TOOL_HOSTS[tool];
  if (!hosts) throw new Error(`Unknown tool: ${tool}`);

  const entriesToRemove = hosts.filter(h => {
    try {
      const hostsContent = fs.readFileSync(HOSTS_FILE, "utf8");
      return hostsContentHasManagedHost(hostsContent, h);
    } catch {
      return false;
    }
  });
  if (entriesToRemove.length === 0) {
    log(`🌐 DNS ${tool}: already inactive`);
    return;
  }

  try {
    if (IS_WIN) {
      const current = fs.readFileSync(HOSTS_FILE, "utf8");
      const next = normalizeHostsContent(filterOutManagedHosts(current, entriesToRemove));
      atomicWriteHostsWin(HOSTS_FILE, current, next);
      await runElevatedPowerShell("ipconfig /flushdns | Out-Null");
    } else {
      const current = fs.readFileSync(HOSTS_FILE, "utf8");
      const next = normalizeHostsContent(filterOutManagedHosts(current, entriesToRemove));
      const escaped = next.replace(/'/g, "'\\''");
      // Write to a temp file then atomically rename — a `tee` straight onto
      // HOSTS_FILE truncates first, so an interrupt mid-write leaves it empty/partial.
      await execWithPassword(`printf '%s' '${escaped}' | tee ${HOSTS_FILE}.genesis.tmp > /dev/null && chmod 644 ${HOSTS_FILE}.genesis.tmp && mv -f ${HOSTS_FILE}.genesis.tmp ${HOSTS_FILE}`, sudoPassword);
      await flushDNS(sudoPassword);
    }
    log(`🌐 DNS ${tool}: ✅ removed ${entriesToRemove.join(", ")}`);
  } catch (error) {
    const msg = error.message?.includes("incorrect password") ? "Wrong sudo password" : `Failed to remove DNS entry: ${error.message}`;
    throw new Error(msg);
  }
}

/**
 * Remove ALL tool DNS entries (used when stopping server)
 */
async function removeAllDNSEntries(sudoPassword) {
  for (const tool of Object.keys(TOOL_HOSTS)) {
    try {
      await removeDNSEntry(tool, sudoPassword);
    } catch (e) {
      err(`DNS ${tool}: failed to remove — ${e.message}`);
    }
  }
}

/**
 * Sync removal of ALL tool DNS entries — for use during process shutdown
 * when async ops aren't safe. Assumes caller already has root/admin rights.
 */
function removeAllDNSEntriesSync() {
  try {
    if (!fs.existsSync(HOSTS_FILE)) return;
    const allHosts = Object.values(TOOL_HOSTS).flat();
    const content = fs.readFileSync(HOSTS_FILE, "utf8");
    const next = normalizeHostsContent(filterOutManagedHosts(content, allHosts));
    if (next === content) return;
    fs.writeFileSync(HOSTS_FILE, next, "utf8");
    if (IS_WIN) {
      try { execSync("ipconfig /flushdns", { windowsHide: true, stdio: "ignore" }); } catch { /* ignore */ }
    } else if (IS_MAC) {
      try { execSync("dscacheutil -flushcache && killall -HUP mDNSResponder", { stdio: "ignore" }); } catch { /* ignore */ }
    } else {
      try { execSync("resolvectl flush-caches 2>/dev/null || true", { stdio: "ignore" }); } catch { /* ignore */ }
    }
  } catch { /* best effort during shutdown */ }
}

module.exports = {
  TOOL_HOSTS,
  MANAGED_HOSTS_MARKER,
  addDNSEntry,
  removeDNSEntry,
  removeAllDNSEntries,
  removeAllDNSEntriesSync,
  execWithPassword,
  isSudoAvailable,
  canRunSudoWithoutPassword,
  isSudoPasswordRequired,
  checkDNSEntry,
  checkAllDNSStatus,
  hostsLineMatchesHost,
  isManagedHostsLine,
  managedHostsLineMatchesHost,
  formatManagedHostsEntry,
  filterOutManagedHosts,
  hostsContentHasManagedHost,
  normalizeHostsContent,
};
