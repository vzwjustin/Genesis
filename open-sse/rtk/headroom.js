const DEFAULT_PROXY_URL = "http://localhost:8787";
const PROBE_TTL_MS = 30_000;
const COMPRESS_TIMEOUT_MS = 5_000;

let compressFn = null;
let compressLoaded = false;
const probeCache = { reachable: false, ts: 0 };

async function loadCompress() {
  if (compressLoaded) return compressFn;
  compressLoaded = true;
  try {
    const mod = await import("headroom-ai");
    compressFn = mod.compress ?? mod.default?.compress ?? null;
  } catch {
    compressFn = null;
  }
  return compressFn;
}

async function probeProxy() {
  const now = Date.now();
  if (now - probeCache.ts < PROBE_TTL_MS) return probeCache.reachable;
  const baseUrl = process.env.HEADROOM_BASE_URL || DEFAULT_PROXY_URL;
  try {
    const res = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(1500),
      cache: "no-store",
    });
    probeCache.reachable = res.ok;
  } catch {
    probeCache.reachable = false;
  }
  probeCache.ts = now;
  return probeCache.reachable;
}

// Invalidate probe cache immediately (e.g. after a compression failure)
function invalidateProbe() {
  probeCache.ts = 0;
}

/**
 * Compress body.messages via headroom proxy.
 * Returns { before, after, saved } on success, null if skipped/unavailable.
 */
export async function compressWithHeadroom(body, model) {
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length < 2) return null;

  const compress = await loadCompress();
  if (!compress) return null;

  if (!(await probeProxy())) return null;

  const before = JSON.stringify(messages).length;
  try {
    const result = await Promise.race([
      compress(messages, { model }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("headroom timeout")), COMPRESS_TIMEOUT_MS)
      ),
    ]);
    if (!result?.messages) return null;
    body.messages = result.messages;
    const after = JSON.stringify(result.messages).length;
    return { before, after, saved: before - after };
  } catch {
    invalidateProbe();
    return null;
  }
}

export async function getHeadroomStatus() {
  const baseUrl = process.env.HEADROOM_BASE_URL || DEFAULT_PROXY_URL;
  const installed = !!(await loadCompress());
  const reachable = installed ? await probeProxy() : false;
  return { installed, reachable, proxyUrl: baseUrl };
}
