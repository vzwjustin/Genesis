import { spawn, execSync } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { getHeadroomStatus, invalidateHeadroomProbe } from "open-sse/rtk/headroom.js";

const DEFAULT_PORT = 8787;
const HEALTH_WAIT_MS = 30_000;
const HEALTH_POLL_MS = 1_000;

let headroomProcess = null;
let headroomBinary = null;
let startInProgress = false;

/** stderr is visible when 9router runs without --log (stdout is discarded). */
function logHeadroom(message) {
  console.warn(message);
}

function isAutoStartDisabled() {
  return process.env.HEADROOM_AUTO_START === "false";
}

function isCloudConfigured() {
  return !!process.env.HEADROOM_API_KEY?.trim();
}

function resolveHeadroomBinary() {
  if (headroomBinary) return headroomBinary;

  const candidates = [
    process.env.HEADROOM_BIN?.trim(),
    "headroom",
    join(homedir(), ".local", "bin", "headroom"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (candidate.includes("/")) {
        if (!existsSync(candidate)) continue;
        execSync(`"${candidate}" --version`, { stdio: "ignore", shell: true });
      } else {
        execSync(`${candidate} --version`, { stdio: "ignore" });
      }
      headroomBinary = candidate;
      return candidate;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

function resolveProxyPort() {
  const configured = process.env.HEADROOM_BASE_URL?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.port) return url.port;
      if (url.protocol === "https:") return "443";
      if (url.protocol === "http:") return "80";
    } catch {
      /* ignore malformed URL */
    }
  }
  return process.env.HEADROOM_PORT?.trim() || String(DEFAULT_PORT);
}

async function waitForReachable(timeoutMs = HEALTH_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    invalidateHeadroomProbe();
    const status = await getHeadroomStatus();
    if (status.reachable) return status;
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
  }
  return getHeadroomStatus();
}

export function stopHeadroomProxy() {
  if (!headroomProcess?.pid) return;
  try {
    headroomProcess.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  headroomProcess = null;
}

export async function autoStartHeadroomProxy() {
  if (startInProgress || headroomProcess) return;

  if (isAutoStartDisabled()) {
    logHeadroom("[InitApp] Headroom auto-start disabled (HEADROOM_AUTO_START=false)");
    return;
  }
  if (isCloudConfigured()) {
    logHeadroom("[InitApp] Headroom cloud configured — skipping local proxy");
    return;
  }

  const binary = resolveHeadroomBinary();
  if (!binary) {
    logHeadroom('[InitApp] Headroom CLI not found — install: pipx install "headroom-ai[proxy]"');
    return;
  }

  startInProgress = true;
  try {
    const existing = await getHeadroomStatus();
    if (existing.reachable) {
      logHeadroom(`[InitApp] Headroom proxy already reachable at ${existing.proxyUrl}`);
      return;
    }

    const port = resolveProxyPort();
    logHeadroom(`[InitApp] Starting Headroom proxy on port ${port} (${binary})...`);

    headroomProcess = spawn(binary, ["proxy", "--port", port], {
      detached: false,
      stdio: ["ignore", "ignore", "pipe"],
      shell: binary.includes("/"),
      env: {
        ...process.env,
        HEADROOM_PORT: port,
      },
    });

    headroomProcess.stderr?.on("data", (chunk) => {
      const line = chunk.toString().trim();
      if (line) logHeadroom(`[Headroom] ${line}`);
    });

    headroomProcess.on("exit", (code, signal) => {
      if (headroomProcess) {
        logHeadroom(`[Headroom] proxy exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
      }
      headroomProcess = null;
    });

    const status = await waitForReachable();
    if (status.reachable) {
      logHeadroom(`[InitApp] Headroom proxy ready at ${status.proxyUrl}`);
    } else {
      logHeadroom(`[InitApp] Headroom proxy started but not healthy yet at ${status.proxyUrl}`);
    }
  } catch (err) {
    logHeadroom(`[InitApp] Headroom auto-start failed: ${err.message}`);
    stopHeadroomProxy();
  } finally {
    startInProgress = false;
  }
}
