import { ProxyAgent, fetch as undiciFetch } from "undici";
import { assertSafeFetchUrl, assertSafeResolvedHostname } from "open-sse/utils/ssrfGuard.js";

const DEFAULT_TEST_URL = "https://google.com/";
const DEFAULT_TIMEOUT_MS = 8000;

function getErrorMessage(err) {
  if (!err) return "Unknown error";
  const base = err?.message || String(err);
  const causeCode = err?.cause?.code || err?.code;
  const causeMessage = err?.cause?.message;

  if (causeMessage && causeMessage !== base) {
    return causeCode ? `${base}: ${causeMessage} (${causeCode})` : `${base}: ${causeMessage}`;
  }

  if (causeCode && !base.includes(causeCode)) {
    return `${base} (${causeCode})`;
  }

  return base;
}

function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

// The undici ProxyAgent only supports http/https proxies. Restrict the
// user-supplied proxy endpoint to those schemes at the application level so
// validation does not depend solely on the library's own parsing.
const SUPPORTED_PROXY_SCHEMES = new Set(["http:", "https:"]);

export async function testProxyUrl({ proxyUrl, testUrl, timeoutMs } = {}) {
  const normalizedProxyUrl = normalizeString(proxyUrl);
  if (!normalizedProxyUrl) {
    return { ok: false, status: 400, error: "proxyUrl is required" };
  }

  const normalizedTestUrl = normalizeString(testUrl) || DEFAULT_TEST_URL;
  try {
    assertSafeFetchUrl(normalizedTestUrl, { requireHttps: false, allowHttp: true });
  } catch (err) {
    return { ok: false, status: 400, error: err.message || "Invalid test URL" };
  }
  const timeoutMsRaw = Number(timeoutMs);
  const normalizedTimeoutMs =
    Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
      ? Math.min(timeoutMsRaw, 30000)
      : DEFAULT_TIMEOUT_MS;

  let parsedProxyUrl;
  try {
    parsedProxyUrl = new URL(normalizedProxyUrl);
  } catch {
    return { ok: false, status: 400, error: "Invalid proxy URL" };
  }
  if (!SUPPORTED_PROXY_SCHEMES.has(parsedProxyUrl.protocol)) {
    return {
      ok: false,
      status: 400,
      error: `Unsupported proxy scheme: ${parsedProxyUrl.protocol}`,
    };
  }

  try {
    await assertSafeResolvedHostname(parsedProxyUrl.hostname, { allowLoopback: false });
  } catch (err) {
    return { ok: false, status: 400, error: err.message || "Proxy host is not allowed" };
  }

  let dispatcher;

  try {
    try {
      dispatcher = new ProxyAgent({ uri: normalizedProxyUrl });
    } catch (err) {
      return {
        ok: false,
        status: 400,
        error: `Invalid proxy URL: ${err?.message || String(err)}`,
      };
    }

    const controller = new AbortController();
    const startedAt = Date.now();
    const timer = setTimeout(() => controller.abort(), normalizedTimeoutMs);

    try {
      const res = await undiciFetch(normalizedTestUrl, {
        method: "HEAD",
        dispatcher,
        signal: controller.signal,
        headers: {
          "User-Agent": "Genesis",
        },
      });

      return {
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        url: normalizedTestUrl,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (err) {
      const message =
        err?.name === "AbortError"
          ? "Proxy test timed out"
          : getErrorMessage(err);
      return { ok: false, status: 500, error: message };
    } finally {
      clearTimeout(timer);
    }
  } finally {
    try {
      await dispatcher?.close?.();
    } catch {
      // ignore
    }
  }
}
