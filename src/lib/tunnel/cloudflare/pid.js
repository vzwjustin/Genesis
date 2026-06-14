import fs from "fs";
import path from "path";
import { TUNNEL_DIR, ensureTunnelDir } from "../shared/state.js";

const PID_FILE = path.join(TUNNEL_DIR, "cloudflared.pid");

export function savePid(pid) {
  // spawn() can fail (sync or via 'error' event) leaving pid undefined; writing
  // "undefined" would throw on .toString() and later parse as NaN.
  if (typeof pid !== "number" || !Number.isInteger(pid)) return;
  ensureTunnelDir();
  fs.writeFileSync(PID_FILE, pid.toString());
}

export function loadPid() {
  try {
    if (fs.existsSync(PID_FILE)) return parseInt(fs.readFileSync(PID_FILE, "utf8"));
  } catch { /* ignore */ }
  return null;
}

export function clearPid() {
  try {
    if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
  } catch { /* ignore */ }
}
