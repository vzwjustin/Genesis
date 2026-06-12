/**
 * Extreme byte-identical Claude cache audit — every protected region must survive
 * snapshot → pipeline mutations → verify unchanged (JSON.stringify per item).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  snapshotCacheProtectedBody,
  verifyCacheProtectedBody,
  hasAnthropicCacheBreakpoints,
} from "../../open-sse/rtk/cacheBoundary.js";
import { cleanAnthropicToolDefinitions } from "../../open-sse/translator/helpers/claudeHelper.js";
import { applyCloaking } from "../../open-sse/utils/claudeCloaking.js";

const OAUTH = "sk-ant-oat-audit-token";

function assertByteIdenticalProtected(body, snapshot) {
  expect(snapshot).not.toBeNull();
  expect(verifyCacheProtectedBody(body, snapshot)).toBe(true);
}

describe("snapshot coverage — all cache marker locations", () => {
  it("captures string system even when only messages carry cache_control", () => {
    const body = {
      system: "static system prompt",
      messages: [
        { role: "user", content: "cached", cache_control: { type: "ephemeral" } },
        { role: "user", content: "tail" },
      ],
    };
    const snap = snapshotCacheProtectedBody(body);
    expect(snap.systemString).toBe("static system prompt");
    assertByteIdenticalProtected(body, snap);
  });

  it("captures system[], tools[], messages[], and input[] prefixes", () => {
    const body = {
      system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }],
      tools: [{ name: "t", type: "function", cache_control: { type: "ephemeral" }, input_schema: {} }],
      messages: [{ role: "user", content: "m", cache_control: { type: "ephemeral" } }],
      input: [{ type: "message", role: "user", cache_control: { type: "ephemeral" }, content: [] }],
    };
    const snap = snapshotCacheProtectedBody(body);
    expect(snap.system[0]).not.toBeNull();
    expect(snap.tools[0]).not.toBeNull();
    expect(snap.messages[0]).not.toBeNull();
    expect(snap.input[0]).not.toBeNull();
    assertByteIdenticalProtected(body, snap);
  });

  it("detects nested content block cache_control in messages", () => {
    const block = { type: "text", text: "nested", cache_control: { type: "ephemeral", ttl: "5m" } };
    const body = {
      messages: [
        { role: "assistant", content: [block] },
        { role: "user", content: "after" },
      ],
    };
    const snap = snapshotCacheProtectedBody(body);
    expect(JSON.parse(snap.messages[0])).toEqual(body.messages[0]);
    body.messages[1].content = "mutated tail is ok";
    assertByteIdenticalProtected(body, snap);
  });
});

describe("verify fails closed on any protected drift", () => {
  it("rejects single-byte content change in cached message", () => {
    const body = {
      messages: [
        { role: "user", content: "exact", cache_control: { type: "ephemeral" } },
        { role: "user", content: "tail" },
      ],
    };
    const snap = snapshotCacheProtectedBody(body);
    body.messages[0].content = "exacT";
    expect(verifyCacheProtectedBody(body, snap)).toBe(false);
  });

  it("rejects cache_control key reordering (JSON.stringify sensitive)", () => {
    const body = {
      messages: [{ role: "user", content: "x", cache_control: { type: "ephemeral", ttl: "1h" } }],
    };
    const snap = snapshotCacheProtectedBody(body);
    body.messages[0].cache_control = { ttl: "1h", type: "ephemeral" };
    expect(verifyCacheProtectedBody(body, snap)).toBe(false);
  });

  it("rejects protected tool model prefix rewrite", () => {
    const body = {
      tools: [{ type: "bash", name: "Bash", model: "cc/claude-opus-4-6", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "hi" }],
    };
    const snap = snapshotCacheProtectedBody(body);
    body.tools[0].model = "claude-opus-4-6";
    expect(verifyCacheProtectedBody(body, snap)).toBe(false);
  });

  it("rejects deletion of snapshotted tools[] when body loses tools", () => {
    const body = {
      tools: [{ name: "a", cache_control: { type: "ephemeral" }, input_schema: {} }],
      messages: [{ role: "user", content: "hi" }],
    };
    const snap = snapshotCacheProtectedBody(body);
    delete body.tools;
    expect(verifyCacheProtectedBody(body, snap)).toBe(false);
  });
});

describe("cross-format translation — fail closed", () => {
  it("rejects Claude→OpenAI when client owns cache breakpoints", async () => {
    const { translateRequest } = await import("../../open-sse/translator/index.js");
    const { FORMATS } = await import("../../open-sse/translator/formats.js");
    const body = {
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "hi", cache_control: { type: "ephemeral" } }],
    };
    expect(() => translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI, "claude-sonnet-4-5", body, false, null, "openai"))
      .toThrow(/cache_control breakpoints/);
  });
});

describe("metadata snapshot", () => {
  it("verify fails when metadata drifts after snapshot", () => {
    const body = {
      metadata: { user_id: "client-sent" },
      messages: [{ role: "user", content: "hi", cache_control: { type: "ephemeral" } }],
    };
    const snap = snapshotCacheProtectedBody(body);
    body.metadata = { user_id: "proxy-injected" };
    expect(verifyCacheProtectedBody(body, snap)).toBe(false);
  });
});

describe("tool cleaning — strict byte identity on protected prefix", () => {
  it("strips cc/ on uncached tail built-in tools while cached prefix stays identical", () => {
    const tools = [
      { type: "web_search_20250305", name: "web_search", model: "cc/claude-opus-4-6", cache_control: { type: "ephemeral" } },
      { type: "web_search_20250305", name: "web_search_tail", model: "cc/claude-opus-4-6" },
    ];
    const out = cleanAnthropicToolDefinitions(tools, "claude", { preserveClientCache: true });
    expect(out[0]).toEqual(tools[0]);
    expect(out[1].model).toBe("claude-opus-4-6");
  });
  it("preserveClientCache returns exact tool objects including cc/ model", () => {
    const tools = [
      { type: "web_search_20250305", name: "web_search", model: "cc/claude-opus-4-6", cache_control: { type: "ephemeral" } },
      { type: "function", name: "fn", model: "strip-me", input_schema: {} },
    ];
    const out = cleanAnthropicToolDefinitions(tools, "claude", { preserveClientCache: true });
    expect(out[0]).toEqual(tools[0]);
    expect(out[1].model).toBeUndefined();
    expect(out[1].type).toBeUndefined();
  });
});

describe("OAuth cloaking — protected regions untouched", () => {
  it("applyCloaking does not mutate system/messages/tools when breakpoints exist", () => {
    const body = {
      model: "claude-sonnet-4-5",
      system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "hi", cache_control: { type: "ephemeral" } }],
      tools: [{ name: "Read", type: "function", model: "cc/claude-opus-4-6", cache_control: { type: "ephemeral" }, input_schema: {} }],
    };
    const snap = snapshotCacheProtectedBody(body);
    const out = applyCloaking(structuredClone(body), OAUTH, "sess-audit");
    assertByteIdenticalProtected(out, snap);
  });
});

describe("handleChatCore — end-to-end protected region survival", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("dispatches with byte-identical cache regions after full passthrough pipeline", async () => {
    vi.doMock("open-sse/services/provider.js", () => ({
      detectFormat: () => "claude",
      getTargetFormat: () => "claude",
    }));
    vi.doMock("open-sse/translator/index.js", () => ({
      translateRequest: vi.fn((body) => structuredClone(body)),
    }));
    vi.doMock("open-sse/translator/formats.js", () => ({
      FORMATS: { CLAUDE: "claude", OPENAI: "openai", GEMINI: "gemini", GEMINI_CLI: "gemini-cli", ANTIGRAVITY: "antigravity" },
    }));
    vi.doMock("open-sse/utils/stream.js", () => ({ COLORS: { red: "", reset: "" } }));
    vi.doMock("open-sse/utils/streamHandler.js", () => ({
      createStreamController: () => ({ signal: new AbortController().signal, handleComplete: () => {}, handleError: () => {} }),
    }));
    vi.doMock("open-sse/services/tokenRefresh.js", () => ({ refreshWithRetry: vi.fn() }));
    vi.doMock("open-sse/utils/requestLogger.js", () => ({
      createRequestLogger: () => ({
        logClientRawRequest: () => {},
        logRawRequest: () => {},
        logTargetRequest: () => {},
        logError: () => {},
      }),
    }));
    vi.doMock("open-sse/config/providerModels.js", () => ({
      getModelTargetFormat: () => null,
      getModelStrip: () => [],
      PROVIDER_ID_TO_ALIAS: {},
    }));
    vi.doMock("open-sse/utils/error.js", () => ({
      createErrorResult: (status, msg, _u, opts) => ({ success: false, status, error: msg, ...opts }),
      parseUpstreamError: vi.fn(),
      formatProviderError: (err) => err.message,
      VALIDATION_ERROR_TYPES: {},
      PROXY_INTERNAL_ERROR_CODES: {
        COMPRESSION_RESTORE_FAILED: "compression_restore_failed",
        CACHE_INTEGRITY_FAILED: "cache_integrity_failed",
      },
    }));
    vi.doMock("open-sse/config/runtimeConfig.js", () => ({
      HTTP_STATUS: { BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, BAD_GATEWAY: 502 },
      MEMORY_CONFIG: { sessionTtlMs: 7200000, sessionCleanupIntervalMs: 1800000 },
    }));
    vi.doMock("open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: () => null }));
    vi.doMock("@/lib/usageDb.js", () => ({
      trackPendingRequest: vi.fn(),
      appendRequestLog: vi.fn(() => Promise.resolve()),
      saveRequestDetail: vi.fn(() => Promise.resolve()),
    }));
    vi.doMock("open-sse/handlers/chatCore/requestDetail.js", () => ({
      buildRequestDetail: () => ({}),
      extractRequestConfig: () => ({}),
    }));
    vi.doMock("open-sse/handlers/chatCore/sseToJsonHandler.js", () => ({ handleForcedSSEToJson: vi.fn(() => null) }));
    vi.doMock("open-sse/handlers/chatCore/nonStreamingHandler.js", () => ({
      handleNonStreamingResponse: vi.fn(() => ({ success: true, response: new Response("{}") })),
    }));
    vi.doMock("open-sse/handlers/chatCore/streamingHandler.js", () => ({
      handleStreamingResponse: vi.fn(() => ({ success: true, response: new Response("{}") })),
      buildOnStreamComplete: () => ({ onStreamComplete: () => {} }),
    }));
    vi.doMock("open-sse/utils/toolDeduper.js", () => ({ dedupeTools: (tools) => ({ tools, stripped: [] }) }));
    vi.doMock("open-sse/rtk/index.js", () => ({
      compressMessages: vi.fn(() => null),
      formatRtkLog: vi.fn(() => null),
    }));
    vi.doMock("open-sse/rtk/caveman.js", () => ({ injectCaveman: vi.fn() }));
    vi.doMock("open-sse/rtk/headroom.js", () => ({ compressWithHeadroom: vi.fn(() => Promise.resolve(null)) }));
    vi.doMock("@/lib/compressionStats.js", () => ({
      recordCompressionStats: vi.fn(() => Promise.resolve()),
      saveCompressionStats: vi.fn(() => Promise.resolve()),
    }));
    vi.doMock("open-sse/utils/clientDetector.js", () => ({
      detectClientTool: () => "claude",
      isNativePassthrough: () => true,
    }));

    let dispatchedBody = null;
    vi.doMock("open-sse/executors/index.js", () => ({
      getExecutor: () => ({
        execute: vi.fn((opts) => {
          dispatchedBody = structuredClone(opts.body);
          return Promise.resolve({
            response: { ok: true, status: 200, headers: new Map() },
            url: "https://api.anthropic.com/v1/messages",
            headers: {},
            transformedBody: opts.body,
          });
        }),
        noAuth: false,
      }),
    }));

    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

    const pristine = {
      model: "claude/claude-sonnet-4-20250514",
      system: [
        { type: "text", text: "cached system", cache_control: { type: "ephemeral", ttl: "1h" } },
        { type: "text", text: "uncached tail" },
      ],
      messages: [
        { role: "user", content: "Hello" },
        {
          role: "assistant",
          content: [{ type: "text", text: "cached turn", cache_control: { type: "ephemeral" } }],
        },
        { role: "user", content: "uncached user tail ".repeat(20) },
      ],
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          model: "cc/claude-opus-4-6",
          cache_control: { type: "ephemeral" },
        },
        { type: "function", name: "my_fn", model: "keep-prefix", input_schema: { type: "object", properties: {} } },
      ],
      stream: false,
    };
    const snap = snapshotCacheProtectedBody(pristine);
    expect(hasAnthropicCacheBreakpoints(pristine)).toBe(true);

    const result = await handleChatCore({
      body: pristine,
      modelInfo: { provider: "claude", model: "claude-sonnet-4-20250514" },
      credentials: { accessToken: "test-token" },
      log: { debug: () => {}, info: () => {}, warn: () => {} },
      rtkEnabled: true,
      cavemanEnabled: true,
      cavemanLevel: "full",
      headroomEnabled: true,
      passthroughCompression: true,
      clientRawRequest: { headers: { "user-agent": "claude-cli/1.0" }, body: "{}", endpoint: "/v1/messages" },
    });

    expect(result.success).toBe(true);
    expect(dispatchedBody).not.toBeNull();
    assertByteIdenticalProtected(dispatchedBody, snap);
    expect(dispatchedBody.model).toBe("claude-sonnet-4-20250514");
  });

  it("preserves client model id when modelInfo resolves a different alias", async () => {
    vi.resetModules();
    vi.doMock("open-sse/services/provider.js", () => ({
      detectFormat: () => "claude",
      getTargetFormat: () => "claude",
    }));
    vi.doMock("open-sse/translator/index.js", () => ({
      translateRequest: vi.fn((body) => structuredClone(body)),
    }));
    vi.doMock("open-sse/translator/formats.js", () => ({
      FORMATS: { CLAUDE: "claude", OPENAI: "openai", GEMINI: "gemini", GEMINI_CLI: "gemini-cli", ANTIGRAVITY: "antigravity" },
    }));
    vi.doMock("open-sse/utils/stream.js", () => ({ COLORS: { red: "", reset: "" } }));
    vi.doMock("open-sse/utils/streamHandler.js", () => ({
      createStreamController: () => ({ signal: new AbortController().signal, handleComplete: () => {}, handleError: () => {} }),
    }));
    vi.doMock("open-sse/services/tokenRefresh.js", () => ({ refreshWithRetry: vi.fn() }));
    vi.doMock("open-sse/utils/requestLogger.js", () => ({
      createRequestLogger: () => ({
        logClientRawRequest: () => {},
        logRawRequest: () => {},
        logTargetRequest: () => {},
        logError: () => {},
      }),
    }));
    vi.doMock("open-sse/config/providerModels.js", () => ({
      getModelTargetFormat: () => null,
      getModelStrip: () => [],
      PROVIDER_ID_TO_ALIAS: {},
    }));
    vi.doMock("open-sse/utils/error.js", () => ({
      createErrorResult: (status, msg) => ({ success: false, status, error: msg }),
      parseUpstreamError: vi.fn(),
      formatProviderError: (err) => err.message,
      VALIDATION_ERROR_TYPES: {},
      PROXY_INTERNAL_ERROR_CODES: { CACHE_INTEGRITY_FAILED: "cache_integrity_failed" },
    }));
    vi.doMock("open-sse/config/runtimeConfig.js", () => ({
      HTTP_STATUS: { BAD_REQUEST: 400, BAD_GATEWAY: 502 },
      MEMORY_CONFIG: { sessionTtlMs: 7200000, sessionCleanupIntervalMs: 1800000 },
    }));
    vi.doMock("open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: () => null }));
    vi.doMock("@/lib/usageDb.js", () => ({
      trackPendingRequest: vi.fn(),
      appendRequestLog: vi.fn(() => Promise.resolve()),
      saveRequestDetail: vi.fn(() => Promise.resolve()),
    }));
    vi.doMock("open-sse/handlers/chatCore/requestDetail.js", () => ({
      buildRequestDetail: () => ({}),
      extractRequestConfig: () => ({}),
    }));
    vi.doMock("open-sse/handlers/chatCore/sseToJsonHandler.js", () => ({ handleForcedSSEToJson: vi.fn(() => null) }));
    vi.doMock("open-sse/handlers/chatCore/nonStreamingHandler.js", () => ({
      handleNonStreamingResponse: vi.fn(() => ({ success: true, response: new Response("{}") })),
    }));
    vi.doMock("open-sse/handlers/chatCore/streamingHandler.js", () => ({
      handleStreamingResponse: vi.fn(() => ({ success: true, response: new Response("{}") })),
      buildOnStreamComplete: () => ({ onStreamComplete: () => {} }),
    }));
    vi.doMock("open-sse/utils/toolDeduper.js", () => ({ dedupeTools: (tools) => ({ tools, stripped: [] }) }));
    vi.doMock("open-sse/rtk/index.js", () => ({ compressMessages: vi.fn(), formatRtkLog: vi.fn() }));
    vi.doMock("open-sse/rtk/caveman.js", () => ({ injectCaveman: vi.fn() }));
    vi.doMock("open-sse/rtk/headroom.js", () => ({ compressWithHeadroom: vi.fn(() => Promise.resolve(null)) }));
    vi.doMock("@/lib/compressionStats.js", () => ({
      recordCompressionStats: vi.fn(() => Promise.resolve()),
      saveCompressionStats: vi.fn(() => Promise.resolve()),
    }));
    vi.doMock("open-sse/utils/clientDetector.js", () => ({
      detectClientTool: () => "claude",
      isNativePassthrough: () => true,
    }));

    let dispatchedBody = null;
    vi.doMock("open-sse/executors/index.js", () => ({
      getExecutor: () => ({
        execute: vi.fn((opts) => {
          dispatchedBody = structuredClone(opts.body);
          return Promise.resolve({
            response: { ok: true, status: 200, headers: new Map() },
            url: "https://api.anthropic.com/v1/messages",
            headers: {},
            transformedBody: opts.body,
          });
        }),
        noAuth: false,
      }),
    }));

    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    const body = {
      model: "claude/claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hi", cache_control: { type: "ephemeral" } }],
      stream: false,
    };

    await handleChatCore({
      body,
      modelInfo: { provider: "claude", model: "claude-sonnet-4-5" },
      credentials: { accessToken: "test-token" },
      log: { debug: () => {}, info: () => {}, warn: () => {} },
      rtkEnabled: true,
      passthroughCompression: true,
      clientRawRequest: { headers: { "user-agent": "claude-cli/1.0" }, body: "{}", endpoint: "/v1/messages" },
    });

    expect(dispatchedBody.model).toBe("claude-sonnet-4-20250514");
  });
});
