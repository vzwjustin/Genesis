import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { HTTP_STATUS, FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";
import {
  generateCursorBody,
  parseConnectRPCFrame,
  extractTextFromResponse
} from "../utils/cursorProtobuf.js";
import { buildCursorHeaders } from "../utils/cursorChecksum.js";
import { estimateUsage } from "../utils/usageTracking.js";
import { FORMATS } from "../translator/formats.js";
import { proxyAwareFetch, shouldBypassMitmDns, resolveRealIP, hasApplicableEnvProxy, getEnvProxyUrl } from "../utils/proxyFetch.js";
import {
  sanitizeComposerVisibleText,
  createStreamingComposerSanitizer,
  extractComposerThinkingAnswer,
  extractComposerThinkingRawVisible,
  RedactedToolContentProcessor,
} from "../utils/composerRedactedTools.js";
import { throwOnCacheViolation } from "../rtk/cacheBoundary.js";
import { isHttp2Required } from "../../src/shared/constants/mitmToolHosts.js";
import zlib from "zlib";
import net from "net";

/** Cap Cursor upstream bodies before protobuf transform (memory safety). */
const CURSOR_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

function assertCursorBodyWithinCap(totalBytes) {
  if (totalBytes > CURSOR_MAX_RESPONSE_BYTES) {
    throw new Error(`Cursor response body exceeds ${CURSOR_MAX_RESPONSE_BYTES} byte limit`);
  }
}

async function readFetchBodyWithCap(response, maxBytes) {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new Error(`Cursor response body exceeds ${maxBytes} byte limit`);
  }
  const buf = Buffer.from(await response.arrayBuffer());
  assertCursorBodyWithinCap(buf.length);
  return buf;
}

function createAbortError() {
  const err = new Error("Request aborted");
  err.name = "AbortError";
  return err;
}

// Detect cloud environment
const isCloudEnv = () => {
  if (typeof caches !== "undefined" && typeof caches === "object") return true;
  if (typeof EdgeRuntime !== "undefined") return true;
  return false;
};

// Lazy import http2 + tls (only in Node.js environment)
let http2 = null;
let tls = null;
if (!isCloudEnv()) {
  try {
    http2 = await import("http2");
    tls = await import("tls");
  } catch {
    // http2/tls not available
  }
}

const COMPRESS_FLAG = {
  NONE: 0x00,
  GZIP: 0x01,
  TRAILER: 0x02,
  GZIP_TRAILER: 0x03
};

const CURSOR_STREAM_DEBUG = process.env.CURSOR_STREAM_DEBUG === "1";
const debugLog = (...args) => {
  if (CURSOR_STREAM_DEBUG) console.log(...args);
};

function isComposerModel(model) {
  const modelId = String(model || "").split("/").pop();
  return /^composer(?:-|$)/i.test(modelId);
}

function visibleComposerContentFromThinking(thinking, options) {
  return extractComposerThinkingRawVisible(thinking, options);
}

function appendParsedRedactedTools(toolCalls, parsedToolCalls) {
  for (const tc of parsedToolCalls || []) {
    toolCalls.push({
      id: `call_redacted_${toolCalls.length}`,
      type: "function",
      function: { name: tc.name, arguments: tc.arguments },
    });
  }
}

function pushAssistantContentChunk(chunks, responseId, created, model, rawText, roleState) {
  const cleanText = sanitizeComposerVisibleText(rawText);
  if (!cleanText) return "";
  chunks.push(
    `data: ${JSON.stringify({
      id: responseId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta:
            !roleState.emitted
              ? ((roleState.emitted = true), { role: "assistant", content: cleanText })
              : { content: cleanText },
          finish_reason: null,
        },
      ],
    })}\n\n`
  );
  return cleanText;
}

function processComposerThinkingDelta(thinkingProcessor, totalThinking, emittedVisibleLen, options) {
  const visible = visibleComposerContentFromThinking(totalThinking, options);
  if (visible.length <= emittedVisibleLen) {
    return { emittedVisibleLen, text: "", toolCalls: [] };
  }
  const delta = visible.slice(emittedVisibleLen);
  const { text, toolCalls } = thinkingProcessor.processChunk(delta);
  return { emittedVisibleLen: visible.length, text, toolCalls };
}

function emitRedactedToolCallChunks(chunks, responseId, created, model, parsedToolCalls, toolCalls, toolCallsMap, emittedToolCallIds, finalizedIds) {
  const seen = new Set();
  for (const tc of parsedToolCalls || []) {
    const sig = `${tc.name}\0${tc.arguments}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    const id = `call_redacted_${Date.now()}_${toolCalls.length}`;
    const toolCallIndex = toolCalls.length;
    const entry = {
      id,
      type: "function",
      index: toolCallIndex,
      function: { name: tc.name, arguments: tc.arguments },
    };
    toolCalls.push(entry);
    toolCallsMap.set(id, entry);
    finalizedIds.add(id);
    emittedToolCallIds.add(id);
    chunks.push(
      `data: ${JSON.stringify({
        id: responseId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: toolCallIndex,
              id,
              type: "function",
              function: { name: tc.name, arguments: tc.arguments },
            }],
          },
          finish_reason: null,
        }],
      })}\n\n`
    );
  }
}

function decompressPayload(payload, flags) {
  // Check if payload is JSON error (starts with {"error")
  if (payload.length > 10 && payload[0] === 0x7b && payload[1] === 0x22) {
    try {
      const text = payload.toString("utf-8");
      if (text.startsWith('{"error"')) {
        debugLog(`[DECOMPRESS] Detected JSON error, skipping decompression`);
        return payload;
      }
    } catch {}
  }

  if (
    flags === COMPRESS_FLAG.GZIP ||
    flags === COMPRESS_FLAG.TRAILER ||
    flags === COMPRESS_FLAG.GZIP_TRAILER
  ) {
    // Primary: try gzip decompression (standard gzip header 0x1f 0x8b)
    try {
      return zlib.gunzipSync(payload);
    } catch (gzipErr) {
      // Fallback: TRAILER and GZIP_TRAILER frames sometimes use raw zlib deflate format
      try {
        return zlib.inflateSync(payload);
      } catch (deflateErr) {
        // Last resort: try raw deflate (no zlib header)
        try {
          return zlib.inflateRawSync(payload);
        } catch (rawErr) {
          debugLog(
            `[DECOMPRESS ERROR] flags=${flags}, payloadSize=${payload.length}, gzip=${gzipErr.message}, deflate=${deflateErr.message}, raw=${rawErr.message}`
          );
          debugLog(
            `[DECOMPRESS ERROR] First 50 bytes (hex):`,
            payload.slice(0, 50).toString("hex")
          );
          // Frame claimed compression but no codec decoded it. Returning the raw
          // compressed bytes here leaks gzip into the protobuf parser → garbage
          // content (mojibake) reaches the client. Drop the frame instead; callers
          // guard with `if (!payload) continue`.
          return null;
        }
      }
    }
  }
  return payload;
}

function createErrorResponse(jsonError) {
  const errorMsg = jsonError?.error?.details?.[0]?.debug?.details?.title
    || jsonError?.error?.details?.[0]?.debug?.details?.detail
    || jsonError?.error?.message
    || "API Error";
  
  const isRateLimit = jsonError?.error?.code === "resource_exhausted";
  
  return new Response(JSON.stringify({
    error: {
      message: errorMsg,
      type: isRateLimit ? "rate_limit_error" : "api_error",
      code: jsonError?.error?.details?.[0]?.debug?.error || "unknown"
    }
  }), {
    status: isRateLimit ? HTTP_STATUS.RATE_LIMITED : HTTP_STATUS.BAD_REQUEST,
    headers: { "Content-Type": "application/json" }
  });
}

const CURSOR_REIMPORT_MSG =
  "Cursor token expired — re-import from Cursor IDE (Providers → Cursor → Import).";

export class CursorExecutor extends BaseExecutor {
  constructor() {
    super("cursor", PROVIDERS.cursor);
    this.supportsTokenRefresh = false;
  }

  parseError(response, bodyText) {
    if (response.status === HTTP_STATUS.UNAUTHORIZED || response.status === HTTP_STATUS.FORBIDDEN) {
      return {
        status: response.status,
        message: CURSOR_REIMPORT_MSG,
        code: "cursor_reimport_required",
      };
    }
    return { status: response.status, message: bodyText || `HTTP ${response.status}` };
  }

  buildUrl() {
    return `${this.config.baseUrl}${this.config.chatPath}`;
  }

  buildHeaders(credentials) {
    const accessToken = credentials.accessToken;
    const machineId = credentials.providerSpecificData?.machineId;
    const ghostMode = credentials.providerSpecificData?.ghostMode !== false;

    if (!machineId) {
      throw new Error("Machine ID is required for Cursor API");
    }

    return buildCursorHeaders(accessToken, machineId, ghostMode);
  }

  transformRequest(model, body, stream, credentials) {
    // Messages are already translated by chatCore (claude→openai→cursor)
    // Do NOT call buildCursorRequest again — double-translation drops tool_results
    const messages = body.messages || [];
    const tools = body.tools || [];
    const reasoningEffort = body.reasoning_effort || null;
    // Detect Claude Code UA to force Agent mode (issue #643)
    const ua = credentials?.rawHeaders?.["user-agent"] || "";
    const forceAgentMode = ua.includes("claude-cli") || ua.includes("claude-code") || ua.includes("Claude Code");
    return generateCursorBody(messages, model, tools, reasoningEffort, forceAgentMode);
  }

  async makeFetchRequest(url, headers, body, signal, proxyOptions = null) {
    const connectCtrl = new AbortController();
    const timeoutMs = this.config?.timeoutMs || FETCH_CONNECT_TIMEOUT_MS;
    const connectTimer = setTimeout(() => connectCtrl.abort(new Error("fetch connect timeout")), timeoutMs);
    const mergedSignal = signal ? AbortSignal.any([signal, connectCtrl.signal]) : connectCtrl.signal;

    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: await readFetchBodyWithCap(response, CURSOR_MAX_RESPONSE_BYTES),
    };
  }

  makeHttp2Request(url, headers, body, signal, realIP = null) {
    if (!http2) {
      throw new Error("http2 module not available");
    }

    const HTTP2_TIMEOUT_MS = 60000; // 60s max — prevent hung sessions

    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      // MITM DNS bypass: when a real IP is supplied (host is in MITM_BYPASS_HOSTS so
      // system DNS may be spoofed via /etc/hosts), connect the TLS socket to that IP
      // while keeping SNI + :authority = hostname. Cursor's ALB only speaks HTTP/2 on
      // this Connect-RPC endpoint and rejects HTTP/1.1 with 464, so we must stay on h2
      // instead of falling back to the HTTP/1.1 bypass fetch.
      const connectOpts = {};
      if (realIP && tls) {
        connectOpts.createConnection = () => tls.connect({
          host: realIP,
          port: Number(urlObj.port) || 443,
          servername: urlObj.hostname,
          ALPNProtocols: ["h2"],
        });
      }
      const client = http2.connect(`https://${urlObj.host}`, connectOpts);
      const chunks = [];
      let responseHeaders = {};
      let settled = false;

      // Ensure client is always closed on settle
      const finish = (fn) => (...args) => {
        if (settled) return;
        settled = true;
        clearTimeout(hangTimeout);
        client.close();
        fn(...args);
      };

      // Hard timeout: close session if server never responds
      const hangTimeout = setTimeout(finish(() => {
        reject(new Error("HTTP/2 request timed out"));
      }), HTTP2_TIMEOUT_MS);

      client.on("error", finish(reject));

      const req = client.request({
        ":method": "POST",
        ":path": urlObj.pathname,
        ":authority": urlObj.host,
        ":scheme": "https",
        ...headers
      });

      req.on("response", (hdrs) => { responseHeaders = hdrs; });
      req.on("data", (chunk) => {
        chunks.push(chunk);
        const total = chunks.reduce((sum, c) => sum + c.length, 0);
        if (total > CURSOR_MAX_RESPONSE_BYTES) {
          finish(() => reject(new Error(`Cursor response body exceeds ${CURSOR_MAX_RESPONSE_BYTES} byte limit`)))();
        }
      });
      req.on("end", finish(() => {
        resolve({
          status: responseHeaders[":status"],
          headers: responseHeaders,
          body: Buffer.concat(chunks)
        });
      }));
      req.on("error", finish(reject));

      if (signal) {
        // Cancel the in-flight request stream (not just the session) so an
        // aborted upload/response is torn down promptly.
        const onAbort = finish(() => { try { req.close(); } catch { /* noop */ } reject(createAbortError()); });
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      req.write(body);
      req.end();
    });
  }

  makeHttp2ProxyRequest(url, headers, body, signal, proxyOptions) {
    if (!http2 || !tls) {
      throw new Error("http2/tls modules not available for CONNECT tunnel");
    }

    const HTTP2_PROXY_TIMEOUT_MS = 30000; // 30s connect + TLS handshake timeout
    const HTTP2_REQUEST_TIMEOUT_MS = 60000; // 60s request timeout
    const MAX_CONNECT_RESPONSE_BYTES = 64 * 1024; // cap proxy CONNECT response header size

    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const targetHost = urlObj.hostname;
      const targetPort = Number(urlObj.port) || 443;

      // Resolve proxy URL from proxyOptions, falling back to env proxy.
      const proxyUrlRaw = proxyOptions?.url || proxyOptions?.connectionProxyUrl;
      let proxyUrl;
      try {
        const raw = proxyUrlRaw || "";
        if (!raw) throw new Error("empty proxy url");
        proxyUrl = new URL(/^[a-z][a-z\d+\-.]*:\/\//i.test(raw) ? raw : `http://${raw}`);
      } catch {
        const envProxy = getEnvProxyUrl(url);
        if (!envProxy) {
          return reject(new Error("No proxy URL available for HTTP/2-over-CONNECT tunnel"));
        }
        proxyUrl = new URL(envProxy);
      }

      const proxyHost = proxyUrl.hostname;
      const proxyIsTls = proxyUrl.protocol === "https:";
      const proxyPort = Number(proxyUrl.port) || (proxyIsTls ? 443 : 80);

      let settled = false;
      let socket = null;
      let tlsSocket = null;
      let client = null;
      let requestTimeout = null;

      // Always tear down every socket/session on settle so a timeout/abort/error
      // never leaks the proxy TCP socket, the tunnel TLS socket, or the h2 session.
      const cleanup = () => {
        clearTimeout(connectTimeout);
        if (requestTimeout) clearTimeout(requestTimeout);
        try { client?.close(); } catch { /* noop */ }
        try { tlsSocket?.destroy(); } catch { /* noop */ }
        try { socket?.destroy(); } catch { /* noop */ }
      };

      const finish = (fn) => (...args) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(...args);
      };

      const connectTimeout = setTimeout(finish(() => {
        reject(new Error("HTTP/2-over-CONNECT: CONNECT tunnel timed out"));
      }), HTTP2_PROXY_TIMEOUT_MS);

      if (signal) {
        if (signal.aborted) {
          return finish(reject)(createAbortError());
        }
        signal.addEventListener("abort", finish(() => reject(createAbortError())), { once: true });
      }

      // Build the CONNECT request. Include Proxy-Authorization when the proxy URL
      // carries credentials — RFC 7235 proxies reject an unauthenticated CONNECT
      // with 407, which would make every authenticated proxy unusable.
      let connectRequest =
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
        `Host: ${targetHost}:${targetPort}\r\n`;
      if (proxyUrl.username) {
        const user = decodeURIComponent(proxyUrl.username);
        const pass = decodeURIComponent(proxyUrl.password || "");
        const cred = Buffer.from(`${user}:${pass}`).toString("base64");
        connectRequest += `Proxy-Authorization: Basic ${cred}\r\n`;
      }
      connectRequest += "\r\n";

      const onProxyConnected = () => socket.write(connectRequest);

      // Open the connection to the proxy. HTTPS proxies (TLS-terminating /
      // ssl_bump / corporate forward proxies) require a TLS handshake to the
      // proxy itself before the plaintext CONNECT line — a bare TCP socket to
      // such a proxy gets a TLS alert and the tunnel can never be established.
      if (proxyIsTls) {
        socket = tls.connect({ host: proxyHost, port: proxyPort, servername: proxyHost }, onProxyConnected);
      } else {
        socket = net.connect(proxyPort, proxyHost, onProxyConnected);
      }

      socket.on("error", finish(reject));

      // Wait for the proxy CONNECT response, terminated by CRLFCRLF. Cap the
      // buffer so a misbehaving proxy can't grow it without bound (OOM).
      let connectResponse = "";
      const onData = (chunk) => {
        connectResponse += chunk.toString("latin1");
        if (connectResponse.length > MAX_CONNECT_RESPONSE_BYTES) {
          finish(reject)(new Error("HTTP/2-over-CONNECT: proxy CONNECT response too large"));
          return;
        }
        if (connectResponse.indexOf("\r\n\r\n") === -1) return;
        socket.removeListener("data", onData);

        const statusLine = connectResponse.split("\r\n")[0];
        const statusCode = Number.parseInt(statusLine.split(" ")[1] || "", 10);
        if (!Number.isInteger(statusCode)) {
          finish(reject)(new Error(`HTTP/2-over-CONNECT: malformed proxy response "${statusLine}"`));
          return;
        }
        if (statusCode !== 200) {
          finish(reject)(new Error(`HTTP/2-over-CONNECT: proxy returned ${statusCode}`));
          return;
        }

        // Wrap the tunnel with TLS to the target and negotiate ALPN h2. The
        // connect timeout stays armed through the TLS handshake; it is swapped
        // for the request timeout only once the h2 request actually starts.
        tlsSocket = tls.connect({
          socket,
          servername: targetHost,
          ALPNProtocols: ["h2"],
        }, () => {
          if (tlsSocket.alpnProtocol !== "h2") {
            finish(reject)(new Error(`HTTP/2-over-CONNECT: ALPN negotiated '${tlsSocket.alpnProtocol}' instead of 'h2'`));
            return;
          }

          clearTimeout(connectTimeout);
          requestTimeout = setTimeout(finish(() => {
            reject(new Error("HTTP/2-over-CONNECT: request timed out"));
          }), HTTP2_REQUEST_TIMEOUT_MS);

          client = http2.connect(`https://${targetHost}`, {
            createConnection: () => tlsSocket,
          });
          client.on("error", finish(reject));

          const chunks = [];
          let responseHeaders = {};

          const req = client.request({
            ":method": "POST",
            ":path": urlObj.pathname,
            ":authority": urlObj.host,
            ":scheme": "https",
            ...headers,
          });

          req.on("response", (hdrs) => { responseHeaders = hdrs; });
          let received = 0;
          req.on("data", (chunk) => {
            received += chunk.length;
            // Cap the buffered response, mirroring the direct HTTP/2 path — a
            // malicious or runaway upstream over the proxy tunnel must not OOM.
            if (received > CURSOR_MAX_RESPONSE_BYTES) {
              finish(() => reject(new Error(`Cursor response body exceeds ${CURSOR_MAX_RESPONSE_BYTES} byte limit`)))();
              return;
            }
            chunks.push(chunk);
          });
          req.on("end", finish(() => {
            resolve({
              status: responseHeaders[":status"],
              headers: responseHeaders,
              body: Buffer.concat(chunks),
            });
          }));
          req.on("error", finish(reject));

          req.write(body);
          req.end();
        });

        tlsSocket.on("error", finish((err) => {
          reject(new Error(`HTTP/2-over-CONNECT: TLS error: ${err.message}`));
        }));
      };
      socket.on("data", onData);
    });
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null, passthrough = false, cacheProtectedSnapshot = null }) {
    const url = this.buildUrl();
    const headers = this.buildHeaders(credentials);
    if (!Buffer.isBuffer(body)) {
      throwOnCacheViolation(body, cacheProtectedSnapshot, "cursor pre-protobuf");
    }
    // Passthrough (passthru) mode: body must already be provider-native (protobuf Buffer).
    let transformedBody;
    if (passthrough) {
      if (!Buffer.isBuffer(body)) {
        throw new Error("Cursor passthrough requires a provider-native Buffer body");
      }
      transformedBody = body;
    } else {
      transformedBody = this.transformRequest(model, body, stream, credentials);
    }

    if (signal?.aborted) {
      throw createAbortError();
    }

    try {
      // DNS bypass alone does NOT force fetch: Cursor's endpoint is HTTP/2-only and
      // returns 464 over HTTP/1.1, so for bypass hosts we resolve the real IP and keep
      // HTTP/2, pinning the socket to it.
      // A CONNECT-capable proxy (per-connection or environment HTTP/HTTPS proxy)
      // can carry the HTTP/2 tunnel. A vercel-style relay cannot: it forwards via
      // x-relay-target headers over an ordinary fetch and must take the fetch path,
      // otherwise a relay-only config would h2-connect directly to the MITM-poisoned
      // system-DNS address instead of going through the relay.
      const usingConnectProxy = proxyOptions?.enabled === true
        || proxyOptions?.connectionProxyEnabled === true
        || hasApplicableEnvProxy(url);
      const usingRelay = !!proxyOptions?.vercelRelayUrl;
      const usingProxy = usingConnectProxy || usingRelay;
      const needsDnsBypass = shouldBypassMitmDns(url);
      let bypassIP = null;
      const usingNativeHttp2Transport = this.makeHttp2Request === CursorExecutor.prototype.makeHttp2Request;
      if (needsDnsBypass && !usingProxy && http2 && usingNativeHttp2Transport) {
        try {
          bypassIP = await resolveRealIP(new URL(url).hostname);
        } catch (dnsErr) {
          // DNS failed — fail closed with clear error (don't silently fall to HTTP/1.1)
          throw new Error("External DNS resolution failed for api2.cursor.sh — cannot establish HTTP/2 bypass connection");
        }
        if (!bypassIP) {
          throw new Error("External DNS resolution failed for api2.cursor.sh — cannot establish HTTP/2 bypass connection");
        }
      }
      const hostname = new URL(url).hostname;
      const shouldForceFetch = (usingConnectProxy && !isHttp2Required(hostname))
        || usingRelay
        || (!usingProxy && needsDnsBypass && !bypassIP && usingNativeHttp2Transport);

      let response;
      if (usingConnectProxy && http2 && isHttp2Required(hostname)) {
        // HTTP/2-over-CONNECT for Cursor through a CONNECT-capable proxy
        response = await this.makeHttp2ProxyRequest(url, headers, transformedBody, signal, proxyOptions);
      } else if (http2 && !shouldForceFetch) {
        response = await this.makeHttp2Request(url, headers, transformedBody, signal, bypassIP);
      } else {
        response = await this.makeFetchRequest(url, headers, transformedBody, signal, proxyOptions);
      }
      const status = Number(response.status);

      if (status !== 200) {
        if (passthrough) {
          const contentType = response.headers?.["content-type"]
            || response.headers?.get?.("content-type")
            || "application/octet-stream";
          return {
            response: new Response(response.body, { status, headers: { "Content-Type": contentType } }),
            url,
            headers,
            transformedBody: body,
          };
        }

        const isAuthError = status === HTTP_STATUS.UNAUTHORIZED || status === HTTP_STATUS.FORBIDDEN;
        const errorResponse = new Response(JSON.stringify({
          error: {
            message: isAuthError ? CURSOR_REIMPORT_MSG : `[${status}]: ${response.body?.toString() || "Unknown error"}`,
            type: isAuthError ? "authentication_error" : "invalid_request_error",
            code: isAuthError ? "cursor_reimport_required" : "",
          }
        }), {
          status,
          headers: { "Content-Type": "application/json" }
        });
        return { response: errorResponse, url, headers, transformedBody: body };
      }

      // Passthrough mode: return raw upstream bytes without any protobuf→SSE/JSON conversion.
      // The caller is expected to handle the provider-native binary response directly.
      if (passthrough) {
        const rawResponse = new Response(response.body, {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" }
        });
        return { response: rawResponse, url, headers, transformedBody: body };
      }

      const transformedResponse = stream !== false
        ? this.transformProtobufToSSE(response.body, model, body)
        : this.transformProtobufToJSON(response.body, model, body);

      return { response: transformedResponse, url, headers, transformedBody: body };
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError" || error?.message === "Request aborted") {
        throw error;
      }
      const errorResponse = new Response(JSON.stringify({
        error: {
          message: error.message,
          type: "connection_error",
          code: ""
        }
      }), {
        status: HTTP_STATUS.SERVER_ERROR,
        headers: { "Content-Type": "application/json" }
      });
      return { response: errorResponse, url, headers, transformedBody: body };
    }
  }

  transformProtobufToJSON(buffer, model, body) {
    const responseId = `chatcmpl-cursor-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    let offset = 0;
    let totalContent = "";
    let totalThinking = "";
    const toolCalls = [];
    const toolCallsMap = new Map(); // Track streaming tool calls by ID
    const finalizedIds = new Set();
    let frameCount = 0;
    const textProcessor = new RedactedToolContentProcessor();
    const thinkingVisibleProcessor = new RedactedToolContentProcessor();
    let accumulatedText = "";
    let accumulatedThinkingText = "";
    let emittedThinkingVisibleLen = 0;

    debugLog(`[CURSOR BUFFER] Total length: ${buffer.length} bytes`);

    while (offset < buffer.length) {
      if (offset + 5 > buffer.length) {
        debugLog(
          `[CURSOR BUFFER] Reached end, offset=${offset}, remaining=${buffer.length - offset}`
        );
        break;
      }

      const flags = buffer[offset];
      const length = buffer.readUInt32BE(offset + 1);

      debugLog(
        `[CURSOR BUFFER] Frame ${frameCount + 1}: flags=0x${flags.toString(16).padStart(2, "0")}, length=${length}`
      );

      if (offset + 5 + length > buffer.length) {
        debugLog(
          `[CURSOR BUFFER] Incomplete frame, offset=${offset}, length=${length}, buffer.length=${buffer.length}`
        );
        break;
      }

      let payload = buffer.slice(offset + 5, offset + 5 + length);
      offset += 5 + length;
      frameCount++;

      payload = decompressPayload(payload, flags);
      if (!payload) {
        debugLog(`[CURSOR BUFFER] Frame ${frameCount}: decompression failed, skipping`);
        continue;
      }

      // Check for JSON error frames (byte guard: skip toString on non-JSON frames)
      if (payload.length > 0 && payload[0] === 0x7b) {
        try {
          const text = payload.toString("utf-8");
          if (text.includes('"error"')) {
            const hasContent = totalContent || toolCallsMap.size > 0;
            debugLog(
              `[CURSOR BUFFER] Error frame (hasContent=${hasContent}): ${text.slice(0, 500)}`
            );
            if (hasContent) {
              break;
            }
            return createErrorResponse(JSON.parse(text));
          }
        } catch {}
      }

      const result = extractTextFromResponse(new Uint8Array(payload));
      debugLog(`[CURSOR DECODED] Frame ${frameCount}:`, result);

      if (result.error) {
        const hasContent = totalContent || toolCallsMap.size > 0;
        debugLog(`[CURSOR BUFFER] Decoded error (hasContent=${hasContent}): ${result.error}`);
        if (hasContent) {
          break;
        }
        return new Response(
          JSON.stringify({
            error: {
              message: result.error,
              type: "rate_limit_error",
              code: "rate_limited"
            }
          }),
          {
            status: HTTP_STATUS.RATE_LIMITED,
            headers: { "Content-Type": "application/json" }
          }
        );
      }

      if (result.toolCall) {
        const tc = result.toolCall;

        if (toolCallsMap.has(tc.id)) {
          // Accumulate arguments for existing tool call
          const existing = toolCallsMap.get(tc.id);
          existing.function.arguments += tc.function.arguments;
          existing.isLast = tc.isLast;
        } else {
          // New tool call
          toolCallsMap.set(tc.id, { ...tc });
        }

        // Push to final array when isLast is true
        if (tc.isLast) {
          const finalToolCall = toolCallsMap.get(tc.id);
          finalizedIds.add(tc.id);
          toolCalls.push({
            id: finalToolCall.id,
            type: finalToolCall.type,
            function: {
              name: finalToolCall.function.name,
              arguments: finalToolCall.function.arguments
            }
          });
        }
      }

      if (result.text) {
        const { text, toolCalls: chunkTools } = textProcessor.processChunk(result.text);
        accumulatedText += text;
        appendParsedRedactedTools(toolCalls, chunkTools);
      }
      if (result.thinking) {
        totalThinking += result.thinking;
        if (isComposerModel(model)) {
          const thinkingDelta = processComposerThinkingDelta(
            thinkingVisibleProcessor,
            totalThinking,
            emittedThinkingVisibleLen
          );
          emittedThinkingVisibleLen = thinkingDelta.emittedVisibleLen;
          accumulatedThinkingText += thinkingDelta.text;
          appendParsedRedactedTools(toolCalls, thinkingDelta.toolCalls);
        }
      }
    }

    const flushedText = textProcessor.flush();
    accumulatedText += flushedText.text;
    appendParsedRedactedTools(toolCalls, flushedText.toolCalls);

    const thinkingFlush = thinkingVisibleProcessor.flush();
    accumulatedThinkingText += thinkingFlush.text;
    appendParsedRedactedTools(toolCalls, thinkingFlush.toolCalls);

    const finalContent = sanitizeComposerVisibleText(
      accumulatedText.trimEnd()
        || accumulatedThinkingText.trimEnd()
        || (isComposerModel(model) ? extractComposerThinkingAnswer(totalThinking, { allowPreFinalFallback: true }) : "")
    );

    debugLog(
      `[CURSOR BUFFER] Parsed ${frameCount} frames, toolCallsMap size: ${toolCallsMap.size}, finalized toolCalls: ${toolCalls.length}`
    );

    // Finalize all remaining tool calls in map (in case stream ended without isLast=true)
    for (const [id, tc] of toolCallsMap.entries()) {
      // Check if already in final array
      if (!finalizedIds.has(id)) {
        debugLog(`[CURSOR BUFFER] Finalizing incomplete tool call: ${id}, isLast=${tc.isLast}`);
        toolCalls.push({
          id: tc.id,
          type: tc.type,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments
          }
        });
      }
    }

    debugLog(`[CURSOR BUFFER] Final toolCalls count: ${toolCalls.length}`);


    const message = {
      role: "assistant",
      content: finalContent || null
    };

    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
    }

    const usage = estimateUsage(body, finalContent.length, FORMATS.OPENAI);

    const completion = {
      id: responseId,
      object: "chat.completion",
      created,
      model,
      choices: [{
        index: 0,
        message,
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop"
      }],
      usage
    };

    return new Response(JSON.stringify(completion), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  transformProtobufToSSE(buffer, model, body) {
    const responseId = `chatcmpl-cursor-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    const chunks = [];
    let offset = 0;
    let totalContent = "";
    let totalThinking = "";
    let emittedComposerThinkingVisibleLen = 0;
    const roleState = { emitted: false };
    const toolCalls = [];
    const toolCallsMap = new Map(); // Track streaming tool calls by ID
    const finalizedIds = new Set();
    const emittedToolCallIds = new Set();
    let frameCount = 0;
    const contentProcessor = new RedactedToolContentProcessor();
    const thinkingVisibleProcessor = new RedactedToolContentProcessor();
    const visibleSanitizer = createStreamingComposerSanitizer();

    debugLog(`[CURSOR BUFFER SSE] Total length: ${buffer.length} bytes`);

    while (offset < buffer.length) {
      if (offset + 5 > buffer.length) {
        debugLog(
          `[CURSOR BUFFER SSE] Reached end, offset=${offset}, remaining=${buffer.length - offset}`
        );
        break;
      }

      const flags = buffer[offset];
      const length = buffer.readUInt32BE(offset + 1);

      debugLog(
        `[CURSOR BUFFER SSE] Frame ${frameCount + 1}: flags=0x${flags.toString(16).padStart(2, "0")}, length=${length}`
      );

      if (offset + 5 + length > buffer.length) {
        debugLog(
          `[CURSOR BUFFER SSE] Incomplete frame, offset=${offset}, length=${length}, buffer.length=${buffer.length}`
        );
        break;
      }

      let payload = buffer.slice(offset + 5, offset + 5 + length);
      offset += 5 + length;
      frameCount++;

      payload = decompressPayload(payload, flags);
      if (!payload) {
        debugLog(`[CURSOR BUFFER SSE] Frame ${frameCount}: decompression failed, skipping`);
        continue;
      }

      // Check for JSON error frames (byte-guard: only decode if starts with '{')
      if (payload[0] === 0x7b) {
        try {
          const text = payload.toString("utf-8");
          if (text.includes('"error"')) {
            const hasContent = chunks.length > 0 || totalContent || toolCallsMap.size > 0;
            debugLog(
              `[CURSOR BUFFER SSE] Error frame (hasContent=${hasContent}): ${text.slice(0, 500)}`
            );
            if (hasContent) {
              break;
            }
            return createErrorResponse(JSON.parse(text));
          }
        } catch {}
      }

      const result = extractTextFromResponse(new Uint8Array(payload));
      debugLog(`[CURSOR DECODED SSE] Frame ${frameCount}:`, result);

      if (result.error) {
        const hasContent = chunks.length > 0 || totalContent || toolCallsMap.size > 0;
        debugLog(`[CURSOR BUFFER SSE] Decoded error (hasContent=${hasContent}): ${result.error}`);
        if (hasContent) {
          break;
        }
        return new Response(
          JSON.stringify({
            error: {
              message: result.error,
              type: "rate_limit_error",
              code: "rate_limited"
            }
          }),
          {
            status: HTTP_STATUS.RATE_LIMITED,
            headers: { "Content-Type": "application/json" }
          }
        );
      }

      if (result.toolCall) {
        const tc = result.toolCall;

        if (!roleState.emitted) {
          roleState.emitted = true;
          chunks.push(
            `data: ${JSON.stringify({
              id: responseId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: "" },
                  finish_reason: null
                }
              ]
            })}\n\n`
          );
        }

        if (toolCallsMap.has(tc.id)) {
          // Accumulate arguments for existing tool call
          const existing = toolCallsMap.get(tc.id);
          existing.function.arguments += tc.function.arguments;
          existing.isLast = tc.isLast;
          // Mark finalized once isLast=true is received for this tool call.
          if (tc.isLast) finalizedIds.add(tc.id);

          // Stream the delta arguments. Per OpenAI streaming spec the tool name
          // (and id) belong only to the FIRST delta of a tool call; repeating
          // them on continuation arg-deltas makes strict clients concatenate the
          // name (e.g. "ReadRead") or reject the stream. Emit arguments only.
          if (tc.function.arguments) {
            emittedToolCallIds.add(tc.id);
            chunks.push(
              `data: ${JSON.stringify({
                id: responseId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: existing.index,
                          function: {
                            arguments: tc.function.arguments
                          }
                        }
                      ]
                    },
                    finish_reason: null
                  }
                ]
              })}\n\n`
            );
          }
        } else {
          // New tool call - assign index and add to map.
          // Only mark finalizedIds when isLast=true arrives (may be this first frame or
          // a later delta frame). The sweep at the end handles streams that terminate
          // before isLast is received, without double-pushing to toolCalls.
          const toolCallIndex = toolCalls.length;
          if (tc.isLast) finalizedIds.add(tc.id);
          toolCalls.push({ ...tc, index: toolCallIndex });
          toolCallsMap.set(tc.id, { ...tc, index: toolCallIndex });

          // Stream initial tool call with name
          emittedToolCallIds.add(tc.id);
          chunks.push(
            `data: ${JSON.stringify({
              id: responseId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: toolCallIndex,
                        id: tc.id,
                        type: "function",
                        function: {
                          name: tc.function.name,
                          arguments: tc.function.arguments
                        }
                      }
                    ]
                  },
                  finish_reason: null
                }
              ]
            })}\n\n`
          );
        }
      }

      if (result.text) {
        const { text: procText, toolCalls: textToolCalls } = contentProcessor.processChunk(result.text);
        emitRedactedToolCallChunks(
          chunks, responseId, created, model, textToolCalls,
          toolCalls, toolCallsMap, emittedToolCallIds, finalizedIds
        );
        const cleanText = visibleSanitizer.sanitizeChunk(procText);
        if (cleanText) {
          totalContent += cleanText;
          chunks.push(
            `data: ${JSON.stringify({
              id: responseId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta:
                    !roleState.emitted
                      ? ((roleState.emitted = true), { role: "assistant", content: cleanText })
                      : { content: cleanText },
                  finish_reason: null
                }
              ]
            })}\n\n`
          );
        }
      }

      if (result.thinking) {
        totalThinking += result.thinking;
        if (isComposerModel(model)) {
          const thinkingDelta = processComposerThinkingDelta(
            thinkingVisibleProcessor,
            totalThinking,
            emittedComposerThinkingVisibleLen
          );
          emittedComposerThinkingVisibleLen = thinkingDelta.emittedVisibleLen;
          emitRedactedToolCallChunks(
            chunks, responseId, created, model, thinkingDelta.toolCalls,
            toolCalls, toolCallsMap, emittedToolCallIds, finalizedIds
          );
          const added = pushAssistantContentChunk(
            chunks, responseId, created, model, visibleSanitizer.sanitizeChunk(thinkingDelta.text), roleState
          );
          totalContent += added;
        } else {
          chunks.push(
            `data: ${JSON.stringify({
              id: responseId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta:
                    !roleState.emitted
                      ? ((roleState.emitted = true), { role: "assistant", reasoning_content: result.thinking })
                      : { reasoning_content: result.thinking },
                  finish_reason: null
                }
              ]
            })}\n\n`
          );
        }
      }
    }

    debugLog(
      `[CURSOR BUFFER SSE] Parsed ${frameCount} frames, toolCallsMap size: ${toolCallsMap.size}, toolCalls array: ${toolCalls.length}`
    );

    const tail = contentProcessor.flush();
    emitRedactedToolCallChunks(
      chunks, responseId, created, model, tail.toolCalls,
      toolCalls, toolCallsMap, emittedToolCallIds, finalizedIds
    );
    const tailText = visibleSanitizer.sanitizeChunk(tail.text);
    if (tailText) {
      totalContent += tailText;
      chunks.push(
        `data: ${JSON.stringify({
          id: responseId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta:
                !roleState.emitted
                  ? ((roleState.emitted = true), { role: "assistant", content: tailText })
                  : { content: tailText },
              finish_reason: null
            }
          ]
        })}\n\n`
      );
    }

    const thinkingTail = thinkingVisibleProcessor.flush();
    emitRedactedToolCallChunks(
      chunks, responseId, created, model, thinkingTail.toolCalls,
      toolCalls, toolCallsMap, emittedToolCallIds, finalizedIds
    );
    const thinkingTailText = pushAssistantContentChunk(
      chunks, responseId, created, model, visibleSanitizer.sanitizeChunk(thinkingTail.text), roleState
    );
    totalContent += thinkingTailText;

    if (isComposerModel(model) && totalThinking) {
      const fallbackAnswer = extractComposerThinkingAnswer(totalThinking, { allowPreFinalFallback: true });
      if (fallbackAnswer.length > emittedComposerThinkingVisibleLen) {
        const fallbackDelta = processComposerThinkingDelta(
          thinkingVisibleProcessor,
          totalThinking,
          emittedComposerThinkingVisibleLen,
          { allowPreFinalFallback: true }
        );
        emittedComposerThinkingVisibleLen = fallbackDelta.emittedVisibleLen;
        emitRedactedToolCallChunks(
          chunks, responseId, created, model, fallbackDelta.toolCalls,
          toolCalls, toolCallsMap, emittedToolCallIds, finalizedIds
        );
        totalContent += pushAssistantContentChunk(
          chunks, responseId, created, model, visibleSanitizer.sanitizeChunk(fallbackDelta.text), roleState
        );
      }
    }

    const pendingVisible = visibleSanitizer.flush();
    if (pendingVisible) {
      totalContent += pushAssistantContentChunk(
        chunks, responseId, created, model, pendingVisible, roleState
      );
    }

    // Finalize remaining tool calls where isLast=true never arrived (stream terminated early).
    // Tool calls already pushed to toolCalls on first encounter must not be pushed again.
    for (const [id, tc] of toolCallsMap.entries()) {
      if (!finalizedIds.has(id)) {
        debugLog(`[CURSOR BUFFER SSE] Finalizing incomplete tool call: ${id}, isLast=${tc.isLast}`);
        if (!emittedToolCallIds.has(id)) {
          // Rare: tool call entered map but never had a streaming chunk emitted.
          // Push and emit now so it appears in the response.
          const toolCallIndex = toolCalls.length;
          toolCalls.push({
            id: tc.id,
            type: tc.type,
            index: toolCallIndex,
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments
            }
          });
          chunks.push(
            `data: ${JSON.stringify({
              id: responseId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: toolCallIndex,
                        id: tc.id,
                        type: "function",
                        function: {
                          name: tc.function.name,
                          arguments: tc.function.arguments
                        }
                      }
                    ]
                  },
                  finish_reason: null
                }
              ]
            })}\n\n`
          );
        }
        // else: already in toolCalls + streamed; isLast just never arrived.
        // All accumulated arg deltas were already sent to the client.
      }
    }

    if (chunks.length === 0 && toolCalls.length === 0) {
      chunks.push(
        `data: ${JSON.stringify({
          id: responseId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "" },
              finish_reason: null
            }
          ]
        })}\n\n`
      );
    }

    const usage = estimateUsage(body, totalContent.length, FORMATS.OPENAI);

    chunks.push(
      `data: ${JSON.stringify({
        id: responseId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop"
          }
        ],
        usage
      })}\n\n`
    );
    chunks.push("data: [DONE]\n\n");

    return new Response(chunks.join(""), {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      }
    });
  }

  needsRefresh() {
    return false;
  }

  async refreshCredentials() {
    // Cursor OAuth tokens are long-lived and are managed exclusively by the Cursor
    // application. Programmatic refresh is not supported via the API. If a 401/403 is
    // returned, the user must re-authenticate through the Cursor application.
    return null;
  }
}

export default CursorExecutor;
