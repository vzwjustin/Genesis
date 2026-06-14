/**
 * Claude-specific prompt cache preservation tests.
 *
 * Anthropic KV cache requires byte-identical cache_control regions. These tests
 * lock the contract for Claude Code / claude-cli flows across:
 *   - snapshotCacheProtectedBody / verifyCacheProtectedBody
 *   - prepareClaudeRequest (preserveClientCache early exit)
 *   - cleanAnthropicToolDefinitions + fixToolUseOrdering
 *   - handleChatCore passthrough dispatch
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  snapshotCacheProtectedBody,
  verifyCacheProtectedBody,
  hasAnthropicCacheBreakpoints,
  shouldSkipMessageForCache,
  findLastCacheBoundary,
} from "../../open-sse/rtk/cacheBoundary.js";
import {
  cleanAnthropicToolDefinitions,
  fixToolUseOrdering,
  prepareClaudeRequest,
} from "../../open-sse/translator/helpers/claudeHelper.js";
import { applyCloaking } from "../../open-sse/utils/claudeCloaking.js";
import { compressMessages } from "../../open-sse/rtk/index.js";

const OAUTH = "sk-ant-oat-claude-cache-test";

function assertCachePreserved(mutate, { label = "mutation" } = {}) {
  const body = buildClaudeCodeCachedBody();
  const snap = snapshotCacheProtectedBody(body);
  expect(snap).not.toBeNull();
  mutate(body);
  expect(verifyCacheProtectedBody(body, snap)).toBe(true);
  void label;
}

/** Body matching cache-byte-identical.test.js passthrough E2E fixture. */
function buildPassthroughPristineBody(overrides = {}) {
  return {
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
    ...overrides,
  };
}

/** Richer Claude Code layout for prepareClaudeRequest / tool-cleaning tests. */
function buildClaudeCodeCachedBody(overrides = {}) {
  return {
    model: "claude-sonnet-4-20250514",
    max_tokens: 8192,
    stream: false,
    system: [
      { type: "text", text: "You are Claude Code.", cache_control: { type: "ephemeral", ttl: "1h" } },
      { type: "text", text: "Uncached system tail." },
    ],
    tools: [
      {
        type: "web_search_20250305",
        name: "web_search",
        model: "cc/claude-opus-4-6",
        cache_control: { type: "ephemeral" },
      },
      {
        name: "Read",
        type: "function",
        model: "cc/gpt-4o",
        input_schema: { type: "object", properties: { path: { type: "string" } } },
      },
      {
        name: "Bash",
        type: "function",
        description: "Run shell",
        input_schema: { type: "object", properties: { command: { type: "string" } } },
      },
    ],
    messages: [
      { role: "user", content: "First user turn." },
      {
        role: "assistant",
        content: [{ type: "text", text: "Cached assistant turn.", cache_control: { type: "ephemeral" } }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_1", content: "file contents" },
          { type: "text", text: "Follow-up question." },
        ],
      },
    ],
    ...overrides,
  };
}

describe("Claude cache — snapshot contract", () => {
  it("detects Claude Code layout with system, tools, and nested message cache_control", () => {
    const body = buildClaudeCodeCachedBody();
    expect(hasAnthropicCacheBreakpoints(body)).toBe(true);
    const snap = snapshotCacheProtectedBody(body);
    expect(snap.system[0]).not.toBeNull();
    expect(snap.tools[0]).not.toBeNull();
    expect(snap.messages[1]).not.toBeNull();
  });

  it("allows mutating uncached system tail and post-boundary messages", () => {
    assertCachePreserved((body) => {
      body.system[1].text = "edited tail";
      body.messages[2].content[1].text = "edited follow-up";
    });
  });

  it("preserves protected client tools byte-identical (no model/type strip)", () => {
    const tool = {
      name: "Read",
      type: "function",
      model: "cc/gpt-4o",
      cache_control: { type: "ephemeral" },
      input_schema: { type: "object", properties: { path: { type: "string" } } },
    };
    const body = { tools: [tool], messages: [{ role: "user", content: "hi", cache_control: { type: "ephemeral" } }] };
    const snap = snapshotCacheProtectedBody(body);
    body.tools[0] = cleanAnthropicToolDefinitions([tool], "claude", { preserveClientCache: true })[0];
    expect(body.tools[0]).toEqual(tool);
    expect(verifyCacheProtectedBody(body, snap)).toBe(true);
  });

  it("rejects protected built-in tool model prefix normalization", () => {
    const body = buildClaudeCodeCachedBody();
    const snap = snapshotCacheProtectedBody(body);
    body.tools[0].model = "claude-opus-4-6";
    expect(verifyCacheProtectedBody(body, snap)).toBe(false);
  });

  it("rejects protected built-in Fable model remapping", () => {
    const body = {
      tools: [{ type: "web_search_20250305", name: "web_search", model: "Claude Fable 5", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "hi" }],
    };
    const snap = snapshotCacheProtectedBody(body);
    body.tools[0].model = "claude-opus-4-8";
    expect(verifyCacheProtectedBody(body, snap)).toBe(false);
  });

  it("rejects protected system block text drift", () => {
    const body = buildClaudeCodeCachedBody();
    const snap = snapshotCacheProtectedBody(body);
    body.system[0].text = "tampered system";
    expect(verifyCacheProtectedBody(body, snap)).toBe(false);
  });

  it("rejects protected assistant content drift on cached text blocks", () => {
    const body = buildClaudeCodeCachedBody();
    const snap = snapshotCacheProtectedBody(body);
    body.messages[1].content[0].text = "tampered assistant";
    expect(verifyCacheProtectedBody(body, snap)).toBe(false);
  });
});

describe("Claude cache — prepareClaudeRequest preserveClientCache", () => {
  it("preserves protected regions through full prepareClaudeRequest with OAuth", () => {
    const body = buildClaudeCodeCachedBody();
    const snap = snapshotCacheProtectedBody(body);
    const out = prepareClaudeRequest(structuredClone(body), "claude", OAUTH, "conn-cache-test");
    expect(verifyCacheProtectedBody(out, snap)).toBe(true);
  });

  it("does not inject proxy cache_control on last assistant when client owns layout", () => {
    const body = buildClaudeCodeCachedBody();
    const out = prepareClaudeRequest(structuredClone(body), "claude");
    const assistantBlocks = out.messages[1].content;
    const textBlock = assistantBlocks.find((b) => b.type === "text");
    expect(textBlock.cache_control).toEqual({ type: "ephemeral" });
    expect(textBlock.cache_control._proxyInjected).toBeUndefined();
  });

  it("does not rewrite assistant content on cached messages", () => {
    const body = buildClaudeCodeCachedBody();
    const out = prepareClaudeRequest(structuredClone(body), "claude");
    expect(out.messages[1].content[0].text).toBe("Cached assistant turn.");
    expect(out.messages[1].content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("leaves cached tools byte-identical through prepareClaudeRequest", () => {
    const body = buildClaudeCodeCachedBody();
    const snap = snapshotCacheProtectedBody(body);
    const out = prepareClaudeRequest(structuredClone(body), "claude");
    expect(out.tools[0]).toEqual(body.tools[0]);
    expect(out.tools[1].model).toBeUndefined();
    expect(out.tools[1].type).toBeUndefined();
    expect(verifyCacheProtectedBody(out, snap)).toBe(true);
  });

  it("applies fixToolUseOrdering only to messages after the cache floor", () => {
    const body = buildClaudeCodeCachedBody({
      messages: [
        {
          role: "assistant",
          cache_control: { type: "ephemeral" },
          content: [
            { type: "tool_use", id: "t1", name: "Read", input: {} },
            { type: "text", text: "protected trailing text" },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t2", name: "Bash", input: {} },
            { type: "text", text: "strip me on tail" },
          ],
        },
        { role: "user", content: "forces tail length > 1" },
      ],
    });
    const snap = snapshotCacheProtectedBody(body);
    const out = prepareClaudeRequest(structuredClone(body), "claude");
    expect(out.messages[0].content).toHaveLength(2);
    expect(out.messages[0].content[1].text).toBe("protected trailing text");
    expect(out.messages[1].content.some((b) => b.type === "text")).toBe(false);
    expect(verifyCacheProtectedBody(out, snap)).toBe(true);
  });

  it("skips message/tool rewriting when no cache breakpoints (proxy-owned cache path)", () => {
    const body = {
      model: "claude-sonnet-4-5",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
      ],
      tools: [{ type: "function", name: "fn", model: "strip-me", input_schema: {} }],
    };
    expect(hasAnthropicCacheBreakpoints(body)).toBe(false);
    const out = prepareClaudeRequest(structuredClone(body), "claude");
    const assistant = out.messages.find((m) => m.role === "assistant");
    const lastText = assistant.content.find((b) => b.type === "text");
    expect(lastText.cache_control).toEqual({ type: "ephemeral" });
    expect(out.tools[0].model).toBeUndefined();
  });
});

describe("Claude cache — tool cleaning and ordering invariants", () => {
  it("protects all tools at or before the last cached tool index", () => {
    const tools = [
      { name: "before", type: "function", model: "x", input_schema: {} },
      { name: "cached", type: "function", model: "y", cache_control: { type: "ephemeral" }, input_schema: {} },
      { name: "after", type: "function", model: "z", input_schema: {} },
    ];
    const body = { tools, messages: [{ role: "user", content: "hi", cache_control: { type: "ephemeral" } }] };
    const snap = snapshotCacheProtectedBody(body);
    body.tools = cleanAnthropicToolDefinitions(tools, "claude", { preserveClientCache: true });
    expect(verifyCacheProtectedBody(body, snap)).toBe(true);
    expect(body.tools[0]).toEqual(tools[0]);
    expect(body.tools[1]).toEqual(tools[1]);
    expect(body.tools[2].model).toBeUndefined();
  });

  it("fixToolUseOrdering skips cached-prefix messages entirely", () => {
    const messages = [
      {
        role: "assistant",
        cache_control: { type: "ephemeral" },
        content: [
          { type: "tool_use", id: "t1", name: "Read", input: {} },
          { type: "text", text: "must remain" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t2", name: "Bash", input: {} },
          { type: "text", text: "removed on uncached tail" },
        ],
      },
    ];
    const floor = findLastCacheBoundary(messages);
    expect(floor).toBe(0);
    const out = fixToolUseOrdering(structuredClone(messages));
    expect(out[0].content).toHaveLength(2);
    expect(out[1].content.some((b) => b.type === "text")).toBe(false);
  });

  it("fixToolUseOrdering preserves string content on cache-protected messages", () => {
    const messages = [
      { role: "user", content: "cached string turn", cache_control: { type: "ephemeral" } },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Bash", input: {} },
          { type: "text", text: "strip me" },
        ],
      },
    ];
    const body = { messages, tools: [{ name: "Bash", type: "function", input_schema: {} }] };
    const snap = snapshotCacheProtectedBody(body);
    body.messages = fixToolUseOrdering(structuredClone(messages));
    expect(verifyCacheProtectedBody(body, snap)).toBe(true);
    expect(body.messages[0].content).toBe("cached string turn");
  });

  it("RTK compression never touches messages at or before cache floor", () => {
    const body = buildClaudeCodeCachedBody({
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "cached payload" }],
          cache_control: { type: "ephemeral" },
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t2", content: "x".repeat(8000) }],
        },
      ],
    });
    const snap = snapshotCacheProtectedBody(body);
    const floor = findLastCacheBoundary(body.messages);
    expect(shouldSkipMessageForCache(0, body.messages, floor)).toBe(true);
    compressMessages(body, true, null);
    expect(verifyCacheProtectedBody(body, snap)).toBe(true);
    expect(body.messages[0].content[0].content).toBe("cached payload");
  });
});

describe("Claude cache — OAuth cloaking", () => {
  it("applyCloaking is a no-op when client owns cache breakpoints", () => {
    const body = buildClaudeCodeCachedBody();
    const snap = snapshotCacheProtectedBody(body);
    const out = applyCloaking(structuredClone(body), OAUTH, "session-claude-cache");
    expect(out).toEqual(body);
    expect(out.metadata).toBeUndefined();
    expect(verifyCacheProtectedBody(out, snap)).toBe(true);
  });

  it("applyCloaking injects metadata only when no cache breakpoints exist", () => {
    const body = {
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "hi" }],
    };
    const out = applyCloaking(structuredClone(body), OAUTH, "session-no-cache");
    expect(out.metadata?.user_id).toBeDefined();
  });
});

describe("Claude cache — handleChatCore passthrough dispatch", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function runPassthroughChatCore({ body, stream = false, credentials = { accessToken: "test-token" } } = {}) {
    const compressSpy = vi.fn(() => null);
    let dispatchedBody = null;

    vi.doMock("open-sse/services/provider.js", () => ({
      detectFormat: () => "claude",
      getTargetFormat: () => "claude",
    }));
    vi.doMock("open-sse/translator/index.js", () => ({
      translateRequest: vi.fn((b) => structuredClone(b)),
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
    vi.doMock("open-sse/rtk/index.js", () => ({
      compressMessages: compressSpy,
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
    const requestBody = body ?? buildPassthroughPristineBody({ stream });
    const snap = snapshotCacheProtectedBody(requestBody);

    const result = await handleChatCore({
      body: requestBody,
      modelInfo: { provider: "claude", model: "claude-sonnet-4-20250514" },
      credentials,
      log: { debug: () => {}, info: () => {}, warn: () => {} },
      rtkEnabled: true,
      cavemanEnabled: true,
      cavemanLevel: "full",
      headroomEnabled: true,
      passthroughCompression: true,
      clientRawRequest: { headers: { "user-agent": "claude-cli/2.0.0" }, body: "{}", endpoint: "/v1/messages" },
    });

    return { result, dispatchedBody, snap, compressSpy };
  }

  it("preserves cache regions through passthrough dispatch (non-streaming)", async () => {
    const { result, dispatchedBody, snap } = await runPassthroughChatCore();
    expect(result.success).toBe(true);
    expect(verifyCacheProtectedBody(dispatchedBody, snap)).toBe(true);
  });

  it("preserves cache regions through passthrough dispatch (streaming)", async () => {
    const { result, dispatchedBody, snap } = await runPassthroughChatCore({ stream: true });
    expect(result.success).toBe(true);
    expect(verifyCacheProtectedBody(dispatchedBody, snap)).toBe(true);
  });

  it("skips RTK compression when client owns cache_control layout", async () => {
    const { compressSpy } = await runPassthroughChatCore();
    expect(compressSpy).not.toHaveBeenCalled();
  });

  it("preserves client model id instead of swapping to modelInfo alias", async () => {
    const body = buildPassthroughPristineBody();
    const { dispatchedBody } = await runPassthroughChatCore({ body });
    expect(dispatchedBody.model).toBe("claude-sonnet-4-20250514");
  });

  it("applies OAuth passthrough cloaking as no-op when cache breakpoints exist", async () => {
    const { dispatchedBody, snap } = await runPassthroughChatCore({
      credentials: { accessToken: OAUTH },
    });
    expect(verifyCacheProtectedBody(dispatchedBody, snap)).toBe(true);
    expect(dispatchedBody.metadata).toBeUndefined();
  });

  it("does not normalize plain string messages when no tool_use blocks exist", async () => {
    const body = buildClaudeCodeCachedBody({
      messages: [
        { role: "user", content: "Hello", cache_control: { type: "ephemeral" } },
        { role: "assistant", content: "Hi there!" },
      ],
    });
    const { dispatchedBody } = await runPassthroughChatCore({ body });
    expect(dispatchedBody.messages[0].content).toBe("Hello");
    expect(dispatchedBody.messages[1].content).toBe("Hi there!");
  });

  it("preserves cached string messages when tool_use exists only in uncached tail", async () => {
    const body = buildClaudeCodeCachedBody({
      messages: [
        { role: "user", content: "cached opener", cache_control: { type: "ephemeral" } },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tu_tail", name: "Bash", input: { command: "ls" } },
            { type: "text", text: "after tool" },
          ],
        },
      ],
    });
    const snap = snapshotCacheProtectedBody(body);
    const { result, dispatchedBody } = await runPassthroughChatCore({ body });
    expect(result.success).toBe(true);
    expect(verifyCacheProtectedBody(dispatchedBody, snap)).toBe(true);
    expect(dispatchedBody.messages[0].content).toBe("cached opener");
  });
});
