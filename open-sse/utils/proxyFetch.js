import { Readable } from "stream";
import { MEMORY_CONFIG } from "../config/runtimeConfig.js";
import { dbg } from "./debugLog.js";
import { assertSafeResolvedHostname, isBlockedHostname } from "./ssrfGuard.js";
import { mergeAbortSignals } from "./abortSignal.js";
import { isKiroMitmHost, isHttp2Required } from "../../src/shared/constants/mitmToolHosts.js";

const originalFetch = globalThis.fetch;
const proxyDispatchers = new Map();
const SUPPORTED_PROXY_PROTOCOLS = new Set(["http:", "https:"]);
const MAX_UPSTREAM_REDIRECTS = 5;

/** Exact credential header names stripped on cross-origin redirect follows. */
const CREDENTIAL_HEADER_EXACT = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-api-key",
  "x-relay-auth",
  "api-key",
  "x-goog-api-key",
]);

/**
 * Whether a request header must be stripped before following a cross-origin redirect.
 * Browsers drop Authorization on cross-origin redirects; forwarding provider secrets
 * to an attacker-chosen host (which can pass the public-only SSRF guard) exfiltrates them.
 * @param {string} headerName
 * @returns {boolean}
 */
export function shouldStripCredentialHeaderOnRedirect(headerName) {
  const lower = String(headerName || "").toLowerCase();
  if (CREDENTIAL_HEADER_EXACT.has(lower)) return true;
  if (lower.endsWith("-api-key")) return true;
  if (lower.includes("authorization")) return true;
  if (lower.startsWith("x-") && (lower.includes("api-key") || lower.includes("auth-token") || lower.endsWith("-token"))) {
    return true;
  }
  return false;
}

/**
 * Normalize Fetch API HeadersInit to [name, value] pairs for redirect stripping.
 * @param {HeadersInit|Record<string, string>|Array<[string, string]>} headers
 * @returns {Array<[string, string]>}
 */
export function getRedirectHeaderEntries(headers) {
  if (!headers) return [];
  if (headers instanceof Headers) {
    return Array.from(headers.entries());
  }
  if (Array.isArray(headers)) {
    return headers;
  }
  return Object.entries(headers);
}

/**
 * Strip credential-bearing headers before following a cross-origin redirect.
 * @param {HeadersInit|Record<string, string>|Array<[string, string]>} headers
 * @returns {Record<string, string>}
 */
export function stripCredentialHeadersOnRedirect(headers) {
  const stripped = {};
  for (const [k, v] of getRedirectHeaderEntries(headers)) {
    if (shouldStripCredentialHeaderOnRedirect(k)) continue;
    stripped[k] = v;
  }
  return stripped;
}

// ─── TLS fingerprinting via got-scraping (browser-like JA3) ───────────────
// Disabled: not in use. Kept commented for future re-enable.
// Restore the original block to re-enable per-host JA3 spoofing.
/*
let _gotScraping = null;
let _gotScrapingChecked = false;
const _gotScrapingLoggedHosts = new Set();

async function getGotScraping() {
  if (_gotScrapingChecked) return _gotScraping;
  _gotScrapingChecked = true;
  try {
    const mod = await import("got-scraping");
    _gotScraping = typeof mod.gotScraping === "function" ? mod.gotScraping : null;
    if (_gotScraping) dbg("TLS", "got-scraping loaded (browser-like JA3 enabled)");
  } catch (e) {
    console.warn(`[ProxyFetch] got-scraping unavailable, falling back to native fetch: ${e.message}`);
    _gotScraping = null;
  }
  return _gotScraping;
}

async function gotScrapingFetch(url, options) {
  const gs = await getGotScraping();
  if (!gs) return null;

  const method = (options.method || "GET").toUpperCase();
  const headersInit = options.headers || {};
  const headers = headersInit instanceof Headers
    ? Object.fromEntries(headersInit.entries())
    : { ...headersInit };

  return new Promise((resolve, reject) => {
    let settled = false;
    const stream = gs.stream({
      url,
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : options.body,
      throwHttpErrors: false,
      retry: { limit: 0 },
      timeout: { request: undefined },
      followRedirect: false,
      decompress: true,
    });

    if (options.signal) {
      const onAbort = () => { try { stream.destroy(new Error("aborted")); } catch { } };
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    stream.once("response", (res) => {
      if (settled) return;
      settled = true;
      const resHeaders = new Headers();
      for (const [k, v] of Object.entries(res.headers || {})) {
        if (Array.isArray(v)) v.forEach((x) => resHeaders.append(k, String(x)));
        else if (v != null) resHeaders.set(k, String(v));
      }
      const body = Readable.toWeb(stream);
      resolve(new Response(body, { status: res.statusCode, statusText: res.statusMessage || "", headers: resHeaders }));
    });

    stream.once("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

async function tryGotScrapingFetch(url, options) {
  try {
    const res = await gotScrapingFetch(url, options);
    if (res) {
      try {
        const host = new URL(typeof url === "string" ? url : url.toString()).hostname;
        if (!_gotScrapingLoggedHosts.has(host)) {
          _gotScrapingLoggedHosts.add(host);
          dbg("TLS", `using got-scraping for ${host}`);
        }
      } catch { }
    }
    return res;
  } catch (e) {
    console.warn(`[ProxyFetch] got-scraping request failed, fallback to native fetch: ${e.message}`);
    return null;
  }
}
*/

// DNS cache — use Map to avoid prototype pollution via malformed hostnames
const DNS_CACHE = new Map();
const DNS_CACHE_MAX_SIZE = 256;
const MITM_BYPASS_HOSTS = [
  "cloudcode-pa.googleapis.com",
  "daily-cloudcode-pa.googleapis.com",
  "api.individual.githubcopilot.com",
  "api.github.com",
  "q.us-east-1.amazonaws.com",
  "codewhisperer.us-east-1.amazonaws.com",
  "api2.cursor.sh",
];
const DEFAULT_DNS_SERVERS = ["8.8.8.8"];
const DNS_SERVER_IP_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/;
const HTTPS_PORT = 443;
const HTTP_SUCCESS_MIN = 200;
const HTTP_SUCCESS_MAX = 300;

function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function extractDnsServersFromSettings(dnsToolEnabled) {
  return Object.entries(dnsToolEnabled || {})
    .filter(([key, enabled]) => enabled === true && DNS_SERVER_IP_PATTERN.test(key))
    .map(([key]) => key);
}

async function getMitmDnsServers() {
  try {
    const { getSettings } = await import("../../src/lib/db/repos/settingsRepo.js");
    const settings = await getSettings();
    const servers = extractDnsServersFromSettings(settings?.dnsToolEnabled);
    if (servers.length > 0) return servers;
    return DEFAULT_DNS_SERVERS;
  } catch (error) {
    console.error("[ProxyFetch] CRITICAL: Failed to load DNS resolver settings — MITM bypass DNS will fail closed:", error.message);
    return [];
  }
}

/**
 * Resolve real IP using configured external DNS (bypass system DNS)
 */
async function resolveRealIP(hostname) {
  const cached = DNS_CACHE.get(hostname);
  if (cached && Date.now() < cached.expiry) return cached.ip;

  try {
    const dns = await import("dns");
    const { promisify } = await import("util");
    const servers = await getMitmDnsServers();
    if (!servers.length) {
      console.error(`[ProxyFetch] No DNS resolvers configured for MITM bypass host: ${hostname}`);
      return null;
    }
    const resolver = new dns.Resolver();
    resolver.setServers(servers);
    const resolve4 = promisify(resolver.resolve4.bind(resolver));
    const addresses = await resolve4(hostname);
    // A NODATA result ([]) must not poison the cache with an undefined IP for the TTL.
    if (!addresses || addresses.length === 0) {
      console.warn(`[ProxyFetch] DNS returned no A records for ${hostname}`);
      return null;
    }
    // The bypass path connects to this IP directly, skipping the dispatcher's
    // connect-time SSRF guard — so re-assert the resolved address here. External
    // DNS returning a private/loopback/link-local IP (rebind or poisoning) must
    // not yield a server-side connection to an internal address.
    if (isBlockedHostname(String(addresses[0]))) {
      console.warn(`[ProxyFetch] External DNS for ${hostname} resolved to blocked IP ${addresses[0]} — refusing bypass`);
      return null;
    }
    if (DNS_CACHE.size >= DNS_CACHE_MAX_SIZE) {
      DNS_CACHE.delete(DNS_CACHE.keys().next().value);
    }
    DNS_CACHE.set(hostname, { ip: addresses[0], expiry: Date.now() + MEMORY_CONFIG.dnsCacheTtlMs });
    return addresses[0];
  } catch (error) {
    console.warn(`[ProxyFetch] DNS resolve failed for ${hostname}:`, error.message);
    return null;
  }
}

/**
 * Check if request should bypass MITM DNS redirect
 */
function hostnameMatchesMitmBypass(hostname, bypassHost) {
  // Exact host only. MITM_BYPASS_HOSTS is an enumerated list of production API
  // hostnames; a subdomain wildcard would let an attacker-controlled subdomain
  // (e.g. evil.api2.cursor.sh) skip the SSRF DNS guard and reach the raw-IP
  // bypass path, where its externally-resolved address is dialed directly.
  return hostname.toLowerCase() === bypassHost.toLowerCase();
}

function shouldBypassMitmDns(url) {
  try {
    const hostname = new URL(url).hostname;
    if (isKiroMitmHost(hostname)) return true;
    return MITM_BYPASS_HOSTS.some((host) => hostnameMatchesMitmBypass(hostname, host));
  } catch { return false; }
}

async function serializeBypassRequestBody(body) {
  if (body == null) return undefined;
  if (typeof body === "string") return body;
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === "object" && typeof body.pipe === "function") {
    const chunks = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  if (typeof body === "object" && typeof body.getReader === "function") {
    const reader = body.getReader();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
  return JSON.stringify(body);
}

function shouldBypassByNoProxy(targetUrl, noProxyValue) {
  const noProxy = normalizeString(noProxyValue);
  if (!noProxy) return false;

  let hostname;
  try { hostname = new URL(targetUrl).hostname.toLowerCase(); } catch { return false; }
  const patterns = noProxy.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);

  return patterns.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.startsWith(".")) return hostname.endsWith(pattern) || hostname === pattern.slice(1);
    return hostname === pattern || hostname.endsWith(`.${pattern}`);
  });
}

/**
 * Get proxy URL from environment
 */
function getEnvProxyUrl(targetUrl) {
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  if (shouldBypassByNoProxy(targetUrl, noProxy)) return null;

  let protocol;
  try { protocol = new URL(targetUrl).protocol; } catch { return null; }

  if (protocol === "https:") {
    return process.env.HTTPS_PROXY || process.env.https_proxy ||
      process.env.ALL_PROXY || process.env.all_proxy;
  }

  return process.env.HTTP_PROXY || process.env.http_proxy ||
    process.env.ALL_PROXY || process.env.all_proxy;
}

/**
 * Normalize proxy URL (allow host:port)
 */
function normalizeProxyUrl(proxyUrl, throwOnError = true) {
  const normalizedInput = normalizeString(proxyUrl);
  if (!normalizedInput) return null;

  try {
    const withProtocol = /^[a-z][a-z\d+\-.]*:\/\//i.test(normalizedInput)
      ? normalizedInput
      : `http://${normalizedInput}`;
    const parsed = new URL(withProtocol);
    if (!SUPPORTED_PROXY_PROTOCOLS.has(parsed.protocol)) {
      throw new Error("Proxy URL must use http or https");
    }
    if (!parsed.hostname) {
      throw new Error("Proxy URL host is required");
    }
    const normalized = parsed.toString();
    return parsed.pathname === "/" && !parsed.search && !parsed.hash
      ? normalized.replace(/\/$/, "")
      : normalized;
  } catch (error) {
    if (throwOnError) throw error;
    return null;
  }
}

function normalizeRuntimeProxyUrl(proxyUrl, source) {
  if (!normalizeString(proxyUrl)) return null;
  const normalized = normalizeProxyUrl(proxyUrl, false);
  if (!normalized) {
    console.warn(`[ProxyFetch] Ignoring invalid ${source} proxy URL`);
  }
  return normalized;
}

function hasApplicableEnvProxy(targetUrl) {
  return normalizeRuntimeProxyUrl(getEnvProxyUrl(targetUrl), "environment") !== null;
}

function resolveConnectionProxyUrl(targetUrl, proxyOptions) {
  const enabled = proxyOptions?.enabled === true || proxyOptions?.connectionProxyEnabled === true;
  if (!enabled) return null;

  const proxyUrlRaw = normalizeString(proxyOptions?.url ?? proxyOptions?.connectionProxyUrl);
  if (!proxyUrlRaw) return null;

  const noProxy = normalizeString(proxyOptions?.noProxy ?? proxyOptions?.connectionNoProxy);
  if (noProxy && shouldBypassByNoProxy(targetUrl, noProxy)) return null;

  const normalizedProxyUrl = normalizeProxyUrl(proxyUrlRaw, false);
  if (!normalizedProxyUrl) {
    if (proxyOptions?.strictProxy === true) {
      throw new Error("[ProxyFetch] Strict connection proxy URL is invalid");
    }
    console.warn("[ProxyFetch] Ignoring invalid connection proxy URL");
  }
  return normalizedProxyUrl;
}

/**
 * Create proxy dispatcher lazily (undici-compatible)
 */
async function getDispatcher(proxyUrl) {
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) return null;

  const existing = proxyDispatchers.get(normalized);
  if (existing) {
    // Refresh recency so eviction is LRU, not FIFO: a hot dispatcher should
    // outlive idle ones regardless of insertion order.
    proxyDispatchers.delete(normalized);
    proxyDispatchers.set(normalized, existing);
    return existing;
  }

  // Evict least-recently-used entry if max size reached
  if (proxyDispatchers.size >= MEMORY_CONFIG.proxyDispatchersMaxSize) {
    proxyDispatchers.delete(proxyDispatchers.keys().next().value);
  }
  // Store the in-flight construction promise so concurrent first-callers for the
  // same proxy share one ProxyAgent instead of each creating one and orphaning
  // the loser's connection pool. Drop the entry if construction rejects.
  const dispatcherPromise = (async () => {
    const { ProxyAgent } = await import("undici");
    return new ProxyAgent({ uri: normalized });
  })().catch((err) => {
    if (proxyDispatchers.get(normalized) === dispatcherPromise) {
      proxyDispatchers.delete(normalized);
    }
    throw err;
  });
  proxyDispatchers.set(normalized, dispatcherPromise);
  return dispatcherPromise;
}

/**
 * Create HTTPS request with manual socket connection (bypass DNS)
 */
async function createBypassRequest(parsedUrl, realIP, options) {
  const isHttps = parsedUrl.protocol === "https:";
  // Static string literals — a computed `import(cond ? "https" : "http")` makes
  // webpack build a context module that fails at runtime ("Cannot find module 'https'").
  const transportModule = isHttps ? await import("https") : await import("http");
  const netModule = await import("net");
  const transport = transportModule.default ?? transportModule;
  const net = netModule.default ?? netModule;
  const port = parsedUrl.port
    ? Number(parsedUrl.port)
    : (isHttps ? HTTPS_PORT : 80);

  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let req = null;
    let settled = false;
    let activeRes = null;

    const cleanup = () => {
      try { req?.destroy(); } catch { /* noop */ }
      try { activeRes?.destroy(); } catch { /* noop */ }
      try { socket.destroy(); } catch { /* noop */ }
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      cleanup();
      reject(err);
    };

    const onAbort = () => {
      if (settled) {
        cleanup();
        return;
      }
      fail(options.signal?.reason || new Error("aborted"));
    };

    if (options.signal) {
      if (options.signal.aborted) {
        fail(options.signal.reason || new Error("aborted"));
        return;
      }
      options.signal.addEventListener("abort", onAbort);
    }

    const BYPASS_CONNECT_TIMEOUT_MS = 60_000;
    socket.setTimeout(BYPASS_CONNECT_TIMEOUT_MS, () => {
      fail(new Error(`[ProxyFetch] Bypass connect timeout after ${BYPASS_CONNECT_TIMEOUT_MS}ms`));
    });

    socket.connect(port, realIP, () => {
      const reqOptions = {
        socket,
        // SNI + cert hostname are validated against the hostname the caller
        // asked for, not the IP we connected to. This keeps the DNS-bypass
        // (avoiding /etc/hosts MITM) while still rejecting on-path attackers
        // that present a different cert. The MITM_BYPASS_HOSTS targets are
        // all public-CA-issued (Google / GitHub / AWS / Cursor) so default
        // verification works without any extra trust store.
        ...(isHttps ? { servername: parsedUrl.hostname } : {}),
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || "POST",
        headers: {
          ...options.headers,
          Host: parsedUrl.hostname + (parsedUrl.port ? `:${parsedUrl.port}` : ""),
        },
      };

      req = transport.request(reqOptions, (res) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", onAbort);
        activeRes = res;

        const bodyChunks = [];
        let bodyEnded = false;
        let bodyError = null;
        // Set once the ReadableStream body getter starts draining. While streaming
        // we free each chunk after it is enqueued so memory is bounded to the
        // unconsumed backlog instead of the whole response. Buffered (json/text/
        // clone) consumers must not be mixed with the stream — materializeBody
        // throws if streamConsumed is set.
        let streamConsumed = false;

        const destroyOnAbort = () => {
          try { socket.destroy(); } catch { /* noop */ }
          try { activeRes?.destroy(); } catch { /* noop */ }
        };

        if (options.signal) {
          if (options.signal.aborted) {
            destroyOnAbort();
          } else {
            options.signal.addEventListener("abort", destroyOnAbort, { once: true });
          }
        }

        res.on("data", (chunk) => bodyChunks.push(Buffer.from(chunk)));
        res.on("end", () => { bodyEnded = true; });
        res.on("error", (err) => { bodyError = err; });

        const materializeBody = async () => {
          if (streamConsumed) {
            throw new Error("Body already consumed by the streaming reader");
          }
          if (bodyError) throw bodyError;
          if (bodyEnded) return Buffer.concat(bodyChunks);
          await new Promise((resolvePromise, rejectPromise) => {
            const onEnd = () => { cleanup(); resolvePromise(); };
            const onErr = (err) => { cleanup(); rejectPromise(err); };
            const cleanup = () => {
              res.off("end", onEnd);
              res.off("error", onErr);
            };
            if (bodyEnded) { cleanup(); resolvePromise(); return; }
            if (bodyError) { cleanup(); rejectPromise(bodyError); return; }
            res.on("end", onEnd);
            res.on("error", onErr);
          });
          return Buffer.concat(bodyChunks);
        };

        const buildFetchResponse = () => {
          const headers = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) {
              for (const item of value) headers.append(key, item);
            } else if (value != null) {
              headers.append(key, value);
            }
          }

          const response = {
            ok: res.statusCode >= HTTP_SUCCESS_MIN && res.statusCode < HTTP_SUCCESS_MAX,
            status: res.statusCode,
            statusText: res.statusMessage,
            headers,
            get body() {
              let offset = 0;
              streamConsumed = true;
              // Enqueue the chunk at `offset`, then release it so the buffered
              // backlog does not grow unbounded for the response's lifetime.
              const drain = (controller) => {
                const chunk = bodyChunks[offset];
                bodyChunks[offset] = null;
                offset++;
                controller.enqueue(new Uint8Array(chunk));
              };
              return new ReadableStream({
                pull(controller) {
                  if (bodyError) {
                    controller.error(bodyError);
                    return;
                  }
                  if (offset < bodyChunks.length) {
                    drain(controller);
                    return;
                  }
                  if (bodyEnded) {
                    controller.close();
                    return;
                  }
                  const onData = () => {
                    res.off("data", onData);
                    res.off("end", onEnd);
                    res.off("error", onErr);
                    if (offset < bodyChunks.length) {
                      drain(controller);
                    } else if (bodyEnded) {
                      controller.close();
                    }
                  };
                  const onEnd = () => {
                    res.off("data", onData);
                    res.off("end", onEnd);
                    res.off("error", onErr);
                    if (offset < bodyChunks.length) {
                      drain(controller);
                    } else {
                      controller.close();
                    }
                  };
                  const onErr = (err) => {
                    res.off("data", onData);
                    res.off("end", onEnd);
                    res.off("error", onErr);
                    controller.error(err);
                  };
                  res.on("data", onData);
                  res.on("end", onEnd);
                  res.on("error", onErr);
                },
              });
            },
            text: async () => (await materializeBody()).toString(),
            arrayBuffer: async () => {
              const buf = await materializeBody();
              return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
            },
            json: async () => {
              const text = (await materializeBody()).toString();
              try { return JSON.parse(text); } catch (e) {
                throw new Error(`Failed to parse JSON response (${res.statusCode}): ${text.slice(0, 200)}`);
              }
            },
            clone: () => buildFetchResponse(),
          };
          return response;
        };

        resolve(buildFetchResponse());
      });

      req.on("error", fail);
      serializeBypassRequestBody(options.body)
        .then((serialized) => {
          if (serialized != null) req.write(serialized);
          req.end();
        })
        .catch(fail);
    });

    socket.on("error", fail);
  });
}

/**
 * Create HTTP/2 request with real-IP pinning (bypass DNS) for hosts that require h2.
 * Similar to cursor executor's makeHttp2Request() but returns a fetch-like response object
 * consistent with createBypassRequest().
 */
async function createHttp2BypassRequest(parsedUrl, realIP, options) {
  const http2Module = await import("http2");
  const tlsModule = await import("tls");
  const http2 = http2Module.default ?? http2Module;
  const tls = tlsModule.default ?? tlsModule;

  const HTTP2_BYPASS_TIMEOUT_MS = 60000;
  const port = parsedUrl.port ? Number(parsedUrl.port) : HTTPS_PORT;

  const body = await serializeBypassRequestBody(options.body);

  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (fn) => (...args) => {
      if (settled) return;
      settled = true;
      clearTimeout(hangTimeout);
      try { client.close(); } catch { /* noop */ }
      fn(...args);
    };

    const fail = finish((err) => reject(err));

    const hangTimeout = setTimeout(finish(() => {
      reject(new Error("[ProxyFetch] HTTP/2 bypass request timed out"));
    }), HTTP2_BYPASS_TIMEOUT_MS);
    // Don't let the timeout timer hold the event loop open on its own.
    hangTimeout.unref?.();

    // Signal abort handling
    const onAbort = () => fail(options.signal?.reason || new Error("aborted"));
    if (options.signal) {
      if (options.signal.aborted) {
        // Clear the timer before the early return — otherwise it dangles for the
        // full timeout and, when it fires, hits `client` in the finish() TDZ.
        clearTimeout(hangTimeout);
        reject(options.signal.reason || new Error("aborted"));
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    const client = http2.connect(`https://${parsedUrl.host}`, {
      createConnection: () => tls.connect({
        host: realIP,
        port,
        servername: parsedUrl.hostname,
        ALPNProtocols: ["h2"],
      }),
    });

    client.on("error", fail);

    const method = (options.method || "POST").toUpperCase();
    const reqHeaders = {
      ":method": method,
      ":path": parsedUrl.pathname + parsedUrl.search,
      ":authority": parsedUrl.host,
      ":scheme": "https",
    };
    // Copy user headers, skipping pseudo-header collisions and host (use :authority)
    if (options.headers) {
      const hdrs = (options.headers instanceof Headers)
        ? Object.fromEntries(options.headers.entries())
        : options.headers;
      for (const [key, value] of Object.entries(hdrs)) {
        const lk = key.toLowerCase();
        if (lk === "host" || lk.startsWith(":")) continue;
        reqHeaders[lk] = value;
      }
    }

    const req = client.request(reqHeaders);

    let responseHeaders = {};
    const bodyChunks = [];
    let bodyEnded = false;
    let bodyError = null;
    let streamConsumed = false;

    const destroyOnAbort = () => {
      try { req.close(); } catch { /* noop */ }
      try { client.close(); } catch { /* noop */ }
    };

    const materializeBody = async () => {
      if (streamConsumed) {
        throw new Error("Body already consumed by the streaming reader");
      }
      if (bodyError) throw bodyError;
      if (bodyEnded) return Buffer.concat(bodyChunks);
      await new Promise((resolvePromise, rejectPromise) => {
        const onEnd = () => { cleanup(); resolvePromise(); };
        const onErr = (err) => { cleanup(); rejectPromise(err); };
        const cleanup = () => {
          req.off("end", onEnd);
          req.off("error", onErr);
        };
        if (bodyEnded) { cleanup(); resolvePromise(); return; }
        if (bodyError) { cleanup(); rejectPromise(bodyError); return; }
        req.on("end", onEnd);
        req.on("error", onErr);
      });
      return Buffer.concat(bodyChunks);
    };

    const buildFetchResponse = () => {
      const status = responseHeaders[":status"] || 0;
      const headers = new Headers();
      for (const [key, value] of Object.entries(responseHeaders)) {
        if (key.startsWith(":")) continue;
        if (Array.isArray(value)) {
          for (const item of value) headers.append(key, item);
        } else if (value != null) {
          headers.append(key, String(value));
        }
      }

      const response = {
        ok: status >= HTTP_SUCCESS_MIN && status < HTTP_SUCCESS_MAX,
        status,
        statusText: "",
        headers,
        get body() {
          let offset = 0;
          streamConsumed = true;
          const drain = (controller) => {
            const chunk = bodyChunks[offset];
            bodyChunks[offset] = null;
            offset++;
            controller.enqueue(new Uint8Array(chunk));
          };
          return new ReadableStream({
            pull(controller) {
              if (bodyError) {
                controller.error(bodyError);
                return;
              }
              if (offset < bodyChunks.length) {
                drain(controller);
                return;
              }
              if (bodyEnded) {
                controller.close();
                return;
              }
              const onData = () => {
                req.off("data", onData);
                req.off("end", onEnd);
                req.off("error", onErr);
                if (offset < bodyChunks.length) {
                  drain(controller);
                } else if (bodyEnded) {
                  controller.close();
                }
              };
              const onEnd = () => {
                req.off("data", onData);
                req.off("end", onEnd);
                req.off("error", onErr);
                if (offset < bodyChunks.length) {
                  drain(controller);
                } else {
                  controller.close();
                }
              };
              const onErr = (err) => {
                req.off("data", onData);
                req.off("end", onEnd);
                req.off("error", onErr);
                controller.error(err);
              };
              req.on("data", onData);
              req.on("end", onEnd);
              req.on("error", onErr);
            },
          });
        },
        text: async () => (await materializeBody()).toString(),
        arrayBuffer: async () => {
          const buf = await materializeBody();
          return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        },
        json: async () => {
          const text = (await materializeBody()).toString();
          try { return JSON.parse(text); } catch (e) {
            throw new Error(`Failed to parse JSON response (${status}): ${text.slice(0, 200)}`);
          }
        },
        clone: () => buildFetchResponse(),
      };
      return response;
    };

    req.on("response", (hdrs) => {
      if (settled) return;
      settled = true;
      clearTimeout(hangTimeout);
      options.signal?.removeEventListener("abort", onAbort);
      responseHeaders = hdrs;

      if (options.signal) {
        if (options.signal.aborted) {
          destroyOnAbort();
        } else {
          options.signal.addEventListener("abort", destroyOnAbort, { once: true });
        }
      }

      resolve(buildFetchResponse());
    });

    req.on("data", (chunk) => { bodyChunks.push(Buffer.from(chunk)); });
    req.on("end", () => {
      bodyEnded = true;
      try { client.close(); } catch { /* noop */ }
    });
    req.on("error", (err) => {
      bodyError = err;
      if (!settled) fail(err);
    });

    if (body != null) req.write(body);
    req.end();
  });
}

// Bound the time-to-first-byte (connect → response headers) of an upstream call.
// Without this a stalled upstream hangs the request forever, surfacing as the
// client's own "API timeout" (e.g. Claude Code) instead of a clean 5xx here.
// Cleared the moment headers arrive, so it never aborts a long-running stream body.
const DEFAULT_UPSTREAM_TIMEOUT_MS = 120000; // 2 min to first byte

function withUpstreamTimeout(options) {
  const ms = Number(options.timeoutMs ?? process.env.UPSTREAM_TIMEOUT_MS ?? DEFAULT_UPSTREAM_TIMEOUT_MS);
  if (!Number.isFinite(ms) || ms <= 0) {
    if (ms === 0) {
      console.warn("[ProxyFetch] UPSTREAM_TIMEOUT_MS=0 disables upstream timeout — stalled upstreams may hang indefinitely");
    }
    return { fetchOptions: options, done: () => {} };
  }
  const tc = new AbortController();
  const timer = setTimeout(
    () => tc.abort(new DOMException(`Upstream timeout: no response headers after ${ms}ms`, "TimeoutError")),
    ms
  );
  if (typeof timer.unref === "function") timer.unref();
  const merged = options.signal
    ? mergeAbortSignals([options.signal, tc.signal])
    : { signal: tc.signal, cleanup: () => {} };
  return {
    fetchOptions: { ...options, signal: merged.signal },
    done: () => {
      clearTimeout(timer);
      merged.cleanup?.();
    },
  };
}

/**
 * Fetch that follows redirects manually, re-validating each hop's hostname
 * against the SSRF guard. Without this, a validated initial host can 30x-redirect
 * to a private/metadata address (e.g. 169.254.169.254) and the default
 * redirect:"follow" would chase it, defeating assertSafeResolvedHostname.
 */
async function safeRedirectFetch(url, options, fetchImpl) {
  // The loopback policy is the CALLER's (derived from the originally-configured
  // provider host), never the redirect target's. Deriving allowLoopback from the
  // attacker-controlled Location host would let any upstream 30x-redirect to
  // http://localhost/ and pass the guard (SSRF to the router's own services).
  const { ssrfAllowLoopback = false, ...restOptions } = options || {};
  let currentUrl = typeof url === "string" ? url : url.toString();
  let currentOptions = { ...restOptions, redirect: "manual" };

  for (let hop = 0; hop <= MAX_UPSTREAM_REDIRECTS; hop++) {
    const res = await fetchImpl(currentUrl, currentOptions);
    // Only 3xx is a redirect; anything else (incl. undefined status from
    // non-standard Response-likes) is handed back untouched.
    const status = Number(res?.status);
    if (!(status >= 300 && status < 400)) return res;

    const location = res.headers?.get?.("location");
    if (!location) return res; // 3xx without Location — hand back as-is

    let nextUrl;
    try {
      nextUrl = new URL(location, currentUrl).toString();
    } catch {
      throw new Error("[ProxyFetch] Redirect to invalid URL blocked");
    }

    const nextHost = new URL(nextUrl).hostname;
    // allowLoopback comes from the caller's policy (ssrfAllowLoopback), NOT from
    // whether the redirect target itself is loopback. A non-loopback-origin chain
    // must never gain loopback access just because the Location points at localhost.
    try {
      await assertSafeResolvedHostname(nextHost, { allowLoopback: ssrfAllowLoopback });
    } catch (dnsError) {
      throw new Error(`[ProxyFetch] Redirect blocked by SSRF guard: ${dnsError.message}`);
    }

    // Drain the redirect response body to free the socket before re-issuing.
    try { await res.body?.cancel(); } catch { /* noop */ }

    // Cross-origin redirect: strip credential-bearing headers before following.
    // Per fetch spec browsers drop Authorization on cross-origin redirects;
    // forwarding the provider bearer/api-key/relay secret to an attacker-chosen
    // public host (which passes the private-only SSRF guard) would exfiltrate it.
    const originChanged = new URL(nextUrl).origin !== new URL(currentUrl).origin;
    if (originChanged && currentOptions.headers) {
      currentOptions = {
        ...currentOptions,
        headers: stripCredentialHeadersOnRedirect(currentOptions.headers),
      };
    }

    // Per fetch spec, 303 (and 301/302 for non-GET/HEAD) downgrade to GET and drop the body.
    const method = (currentOptions.method || "GET").toUpperCase();
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== "GET" && method !== "HEAD")) {
      const { body, ...rest } = currentOptions;
      // Drop the entity headers along with the body — a GET that still advertises
      // content-length/content-type of the discarded payload confuses upstreams.
      if (rest.headers) {
        const cleaned = {};
        for (const [k, v] of getRedirectHeaderEntries(rest.headers)) {
          const lk = k.toLowerCase();
          if (lk === "content-length" || lk === "content-type" || lk === "transfer-encoding") continue;
          cleaned[k] = v;
        }
        rest.headers = cleaned;
      }
      currentOptions = { ...rest, method: "GET" };
    }
    currentUrl = nextUrl;
  }

  throw new Error(`[ProxyFetch] Too many redirects (>${MAX_UPSTREAM_REDIRECTS})`);
}

// ─── DNS-rebind-safe dispatcher ───────────────────────────────────────────
// assertSafeResolvedHostname validates the hostname's resolved IPs, but undici
// then re-resolves independently when it connects. Across the ~60s DNS cache
// window an attacker can answer the guard with a public IP and the real connect
// with 169.254.169.254 (metadata) — classic DNS-rebind TOCTOU. This dispatcher
// re-asserts the address at connect-time via a custom `lookup`, so the IP that
// actually gets connected is the one that passed the block check. Reused per
// process (stateless), bounded by undici's own pool.
let _guardedDispatcherPromise = null;
async function getGuardedDispatcher() {
  // Cache the in-flight promise (not just the resolved Agent) so two concurrent
  // first-callers share one construction instead of each building an Agent and
  // orphaning the other's connection pool.
  if (!_guardedDispatcherPromise) {
    _guardedDispatcherPromise = (async () => {
      const dns = await import("node:dns");
      const { Agent } = await import("undici");
      return new Agent({
        connect: {
          lookup(hostname, opts, cb) {
            dns.lookup(hostname, opts, (err, address, family) => {
              if (err) return cb(err, address, family);
              // Re-assert the ACTUAL connect address — not a cached prior resolution.
              const addrs = Array.isArray(address)
                ? address.map((a) => a.address)
                : [address];
              for (const ip of addrs) {
                if (isBlockedHostname(String(ip))) {
                  return cb(new Error(`[ProxyFetch] Connect address blocked by SSRF guard: ${ip}`), address, family);
                }
              }
              cb(null, address, family);
            });
          },
        },
      });
    })().catch((err) => {
      // Don't cache a rejected promise — let the next call retry construction.
      _guardedDispatcherPromise = null;
      throw err;
    });
  }
  return _guardedDispatcherPromise;
}

/** Drain an abandoned fetch body without throwing when body/cancel is missing. */
export async function cancelResponseBody(response) {
  try {
    if (typeof response?.body?.cancel === "function") {
      await response.body.cancel();
    }
  } catch {
    // Best-effort socket release — never fail the retry path.
  }
}

export async function proxyAwareFetch(url, options = {}, proxyOptions = null) {
  const { fetchOptions, done } = withUpstreamTimeout(options);
  try {
    return await _proxyAwareFetch(url, fetchOptions, proxyOptions);
  } finally {
    done(); // clear the TTFB timer once headers resolve (or on error) — stream body is unbounded
  }
}

async function _proxyAwareFetch(url, options = {}, proxyOptions = null) {
  const targetUrl = typeof url === "string" ? url : url.toString();
  let originHost = "";
  try {
    originHost = new URL(targetUrl).hostname.toLowerCase();
  } catch { /* unparseable */ }

  let directIsLoopback = false;
  if (!shouldBypassMitmDns(targetUrl)) {
    try {
      const hostname = originHost || new URL(targetUrl).hostname;
      const allowLoopback = ["localhost", "127.0.0.1", "::1"].includes(hostname.toLowerCase());
      directIsLoopback = allowLoopback;
      await assertSafeResolvedHostname(hostname, { allowLoopback });
    } catch (dnsError) {
      throw new Error(`[ProxyFetch] DNS safety check failed: ${dnsError.message}`);
    }
  }

  const guardedFetch = async (u, o) => {
    const dispatcher = await getGuardedDispatcher();
    return originalFetch(u, { ...o, dispatcher });
  };

  // For direct (non-proxy) egress to a non-loopback host, attach the
  // connect-time guarded dispatcher so the IP actually dialed is re-checked —
  // closes the DNS-rebind window between the check above and the real connect.
  // Loopback providers (ollama/searxng) are intentionally allowed, so skip them.
  const directFetch = async (u, o) => {
    // Decide loopback per-HOP from the host actually being dialed, not the once-
    // computed origin closure. A loopback-origin provider (ollama) that redirects
    // to a different host — another localhost port or, across the DNS-cache window,
    // a rebound private address — must NOT skip the connect-time guarded dispatcher
    // just because the original target was loopback (rebind/loopback-pivot fix).
    let hopIsLoopback = false;
    try {
      const hopHost = new URL(typeof u === "string" ? u : u.toString()).hostname.toLowerCase();
      // Only skip the guarded dispatcher for the original loopback host — not
      // arbitrary localhost ports reached via redirect (loopback port pivot).
      hopIsLoopback = directIsLoopback
        && originHost
        && hopHost === originHost
        && ["localhost", "127.0.0.1", "::1"].includes(hopHost);
    } catch { /* unparseable URL — fall through to guarded path */ }
    if (hopIsLoopback) return originalFetch(u, o);
    let dispatcher;
    try {
      dispatcher = await getGuardedDispatcher();
    } catch (dispatcherError) {
      throw new Error(`[ProxyFetch] SSRF guard unavailable: ${dispatcherError.message}`);
    }
    // A block error raised inside the dispatcher's lookup MUST propagate — do
    // not wrap this in a try/catch that would retry plain fetch (fail-open).
    return originalFetch(u, { ...o, dispatcher });
  };

  const connectionProxyUrl = resolveConnectionProxyUrl(targetUrl, proxyOptions);
  const connectionProxyConfigured =
    (proxyOptions?.enabled === true || proxyOptions?.connectionProxyEnabled === true)
    && Boolean(normalizeString(proxyOptions?.url ?? proxyOptions?.connectionProxyUrl));
  const vercelRelayUrl = !connectionProxyUrl ? normalizeString(proxyOptions?.vercelRelayUrl) : null;

  // Precedence: per-connection proxy → environment proxy → relay/vercel pool → direct
  let proxyUrl = connectionProxyUrl;
  if (!proxyUrl) {
    const envProxyUrl = connectionProxyConfigured
      ? null
      : normalizeRuntimeProxyUrl(getEnvProxyUrl(targetUrl), "environment");
    proxyUrl = envProxyUrl;
  }

  // MITM DNS bypass before relay no_proxy/direct shortcuts — bypass hosts must
  // use external DNS (or proxy-side DNS), never system resolver via directFetch.
  if (shouldBypassMitmDns(targetUrl)) {
    const parsedUrl = new URL(targetUrl);
    if (proxyUrl) {
      try {
        const dispatcher = await getDispatcher(proxyUrl);
        return await safeRedirectFetch(url, options, (u, o) => originalFetch(u, { ...o, dispatcher }));
      } catch (proxyError) {
        if (proxyOptions?.strictProxy !== false) {
          throw new Error(`[ProxyFetch] Proxy required but failed: ${proxyError.message}`);
        }
        console.warn(`[ProxyFetch] Proxy failed, falling back to direct bypass: ${proxyError.message}`);
      }
    }
    const realIP = await resolveRealIP(parsedUrl.hostname);
    if (!realIP) {
      throw new Error(`[ProxyFetch] External DNS resolution failed for MITM bypass host: ${parsedUrl.hostname}`);
    }
    // HTTP/2-required hosts (e.g., api2.cursor.sh) need h2 session, not HTTP/1.1
    if (isHttp2Required(parsedUrl.hostname)) {
      return await createHttp2BypassRequest(parsedUrl, realIP, options);
    }
    return await createBypassRequest(parsedUrl, realIP, options);
  }

  // Per-connection no_proxy applies even when HTTPS_PROXY is set — honor direct
  // routing before relay/env proxy selection (relay no_proxy regression fix).
  const connectionNoProxy = normalizeString(proxyOptions?.noProxy ?? proxyOptions?.connectionNoProxy);
  if (connectionNoProxy && shouldBypassByNoProxy(targetUrl, connectionNoProxy)) {
    return safeRedirectFetch(url, options, directFetch);
  }

  if (!proxyUrl && vercelRelayUrl) {
    const parsed = new URL(targetUrl);
    const relayHeaders = {
      ...options.headers,
      "x-relay-target": `${parsed.protocol}//${parsed.host}`,
      "x-relay-path": `${parsed.pathname}${parsed.search}`,
    };
    const relayAuthSecret = normalizeString(proxyOptions?.relayAuthSecret);
    if (relayAuthSecret) relayHeaders["x-relay-auth"] = relayAuthSecret;
    await assertSafeResolvedHostname(new URL(vercelRelayUrl).hostname, { allowLoopback: false });
    return safeRedirectFetch(vercelRelayUrl, { ...options, headers: relayHeaders, ssrfAllowLoopback: false }, guardedFetch);
  }

  if (proxyUrl) {
    try {
      const dispatcher = await getDispatcher(proxyUrl);
      return await safeRedirectFetch(url, options, (u, o) => originalFetch(u, { ...o, dispatcher }));
    } catch (proxyError) {
      if (proxyOptions?.strictProxy !== false) {
        throw new Error(`[ProxyFetch] Proxy required but failed: ${proxyError.message}`);
      }
      console.warn(`[ProxyFetch] Proxy failed, falling back to direct (strictProxy=false): ${proxyError.message}`);
      return safeRedirectFetch(url, options, directFetch);
    }
  }

  return safeRedirectFetch(url, options, directFetch);
}

/**
 * Patched global fetch with env-proxy support and MITM DNS bypass
 */
async function patchedFetch(url, options = {}) {
  return proxyAwareFetch(url, options, null);
}

// Idempotency guard — only patch once to avoid wrapping multiple times
if (globalThis.fetch !== patchedFetch) {
  globalThis.fetch = patchedFetch;
}

export default patchedFetch;

/**
 * Tri-state strictProxy for proxyAwareFetch:
 * - undefined (unset): fail closed — do not fall back to direct on proxy failure
 * - true: fail closed (explicit)
 * - false: allow fallback to direct when proxy fails
 */
export function resolveStrictProxyOption(value) {
  if (value === false) return false;
  if (value === true) return true;
  return undefined;
}

/** Copy strictProxy from resolveConnectionProxyConfig only when that resolver set it. */
export function strictProxyFieldFromResolved(resolvedProxy) {
  if (
    !resolvedProxy
    || !Object.prototype.hasOwnProperty.call(resolvedProxy, "strictProxy")
    || resolvedProxy.strictProxy === undefined
  ) {
    return {};
  }
  return { strictProxy: resolvedProxy.strictProxy === true };
}

/**
 * Build proxy routing options from a connection credentials record (same shape as chatCore).
 */
export function buildProxyOptionsFromCredentials(credentials) {
  const psd = credentials?.providerSpecificData || {};
  return {
    connectionProxyEnabled: psd.connectionProxyEnabled === true,
    connectionProxyUrl: psd.connectionProxyUrl || "",
    connectionNoProxy: psd.connectionNoProxy || "",
    vercelRelayUrl: psd.vercelRelayUrl || "",
    relayAuthSecret: psd.relayAuthSecret || "",
    strictProxy: resolveStrictProxyOption(psd.strictProxy),
  };
}

export {
  resolveConnectionProxyUrl,
  getEnvProxyUrl,
  hasApplicableEnvProxy,
  shouldBypassMitmDns,
  shouldBypassByNoProxy,
  normalizeProxyUrl,
  resolveRealIP,
  extractDnsServersFromSettings,
  getMitmDnsServers,
  MITM_BYPASS_HOSTS,
};
