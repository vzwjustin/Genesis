import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";

/**
 * OAuth HTTP helper — routes through proxyAwareFetch (env proxy, MITM bypass DNS).
 * OAuth setup has no per-connection proxy context; pass null proxyOptions.
 */
export async function oauthFetch(url, init = {}) {
  return proxyAwareFetch(url, init, null);
}

/**
 * OAuth fetch with AbortController timeout (device-code polling, etc.).
 */
export async function oauthFetchWithTimeout(url, init = {}, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    return await oauthFetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
