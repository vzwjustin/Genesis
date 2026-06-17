import { isSafeFetchUrl } from "../../utils/ssrfGuard.js";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";

export const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function getHeader(headers, name) {
  return headers?.get?.(name) || headers?.get?.(name.toLowerCase()) || headers?.get?.(name.toUpperCase()) || null;
}

function parseContentLength(headers) {
  const raw = getHeader(headers, "Content-Length");
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function isAllowedImageMime(mimeType) {
  if (!mimeType) return true;
  return String(mimeType).toLowerCase().split(";")[0].trim().startsWith("image/");
}

async function readArrayBufferWithLimit(response, maxBytes) {
  if (!response.body?.getReader) {
    const arrayBuffer = await response.arrayBuffer();
    return arrayBuffer.byteLength <= maxBytes ? arrayBuffer : null;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

/**
 * Fetch a remote image URL and return it as a base64 data URI.
 * Used when upstream providers (Codex, etc.) require inline base64 images
 * instead of remote URLs they cannot fetch.
 * Returns null if fetch fails.
 *
 * @param {string} imageUrl - HTTP(S) URL of the image
 * @param {object} options - { signal, timeoutMs, maxBytes }
 * @returns {Promise<{url: string, mimeType: string, bytes: number}|null>}
 */
export async function fetchImageAsBase64(imageUrl, options = {}) {
  const { signal, timeoutMs = 10000, proxyOptions = null, maxBytes = DEFAULT_MAX_IMAGE_BYTES } = options;
  if (!imageUrl || (!imageUrl.startsWith("http://") && !imageUrl.startsWith("https://"))) {
    return null;
  }
  if (!isSafeFetchUrl(imageUrl, { requireHttps: false, allowHttp: true })) {
    return null;
  }

  const controller = new AbortController();
  const timeout = signal ? null : setTimeout(() => controller.abort(), timeoutMs);
  const fetchSignal = signal || controller.signal;

  try {
    const response = await proxyAwareFetch(imageUrl, { signal: fetchSignal }, proxyOptions);
    if (!response.ok) return null;

    const mimeType = getHeader(response.headers, "Content-Type") || "image/jpeg";
    if (!isAllowedImageMime(mimeType)) return null;

    const contentLength = parseContentLength(response.headers);
    if (contentLength !== null && contentLength > maxBytes) return null;

    const arrayBuffer = await readArrayBufferWithLimit(response, maxBytes);
    if (!arrayBuffer) return null;

    const base64 = Buffer.from(arrayBuffer).toString("base64");
    return { url: `data:${mimeType};base64,${base64}`, mimeType, bytes: arrayBuffer.byteLength };
  } catch {
    return null;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
