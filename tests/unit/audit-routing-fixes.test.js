/**
 * Regression tests for the routing/harness audit fixes:
 *  - native-passthrough guard on OpenAI chat wire
 *  - Kiro tool-call finish_reason + tool preservation
 *  - truncated cross-format stream fails closed (no fabricated terminal)
 *  - cross-origin redirect strips the x-key credential header
 *  - bound-but-unresolved proxy pool fails closed
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { shouldUseNativePassthrough } from "../../open-sse/utils/clientDetector.js";
import { convertKiroToOpenAI } from "../../open-sse/translator/response/kiro-to-openai.js";
import { buildKiroPayload } from "../../open-sse/translator/request/openai-to-kiro.js";
import { openaiToClaudeResponse } from "../../open-sse/translator/response/openai-to-claude.js";
import { openaiResponsesToOpenAIResponse } from "../../open-sse/translator/response/openai-responses.js";
import { shouldStripCredentialHeaderOnRedirect } from "../../open-sse/utils/proxyFetch.js";

describe("shouldUseNativePassthrough — OpenAI chat wire guard", () => {
  it("does NOT passthrough a native client's OpenAI chat body to a non-OpenAI provider", () => {
    expect(
      shouldUseNativePassthrough("claude", "claude", {
        body: { messages: [{ role: "user", content: "hi" }] },
        headers: {},
        pathname: "/v1/chat/completions",
      })
    ).toBe(false);
  });

  it("still passthroughs OpenAI client → OpenAI provider on /v1/chat/completions", () => {
    expect(
      shouldUseNativePassthrough("openai", "openai", {
        body: { messages: [{ role: "user", content: "hi" }] },
        headers: {},
        pathname: "/v1/chat/completions",
      })
    ).toBe(true);
  });
});

describe("convertKiroToOpenAI — tool_calls finish_reason", () => {
  it("reports finish_reason tool_calls after a toolUseEvent", () => {
    const state = {};
    convertKiroToOpenAI(
      { toolUseEvent: { toolUseId: "t1", name: "lookup", input: { q: "x" } } },
      state
    );
    const fin = convertKiroToOpenAI({ messageStopEvent: {} }, state);
    expect(fin.choices[0].finish_reason).toBe("tool_calls");
  });

  it("reports finish_reason stop when no tool calls were emitted", () => {
    const state = {};
    const fin = convertKiroToOpenAI({ messageStopEvent: {} }, state);
    expect(fin.choices[0].finish_reason).toBe("stop");
  });
});

describe("buildKiroPayload — tools survive a single-turn request", () => {
  it("attaches tools to the currentMessage sent upstream", () => {
    const body = {
      messages: [{ role: "user", content: "weather?" }],
      tools: [
        {
          type: "function",
          function: { name: "get_weather", parameters: { type: "object", properties: {} } },
        },
      ],
    };
    const payload = buildKiroPayload("kiro-model", body, false, {});
    const tools =
      payload.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools;
    expect(Array.isArray(tools)).toBe(true);
    expect(tools[0].toolSpecification.name).toBe("get_weather");
  });
});

describe("cross-format flush — fail closed on truncation", () => {
  it("openaiToClaudeResponse emits an error event (not message_stop) when truncated", () => {
    const state = { toolCalls: new Map() };
    openaiToClaudeResponse(
      { id: "chatcmpl-abc12345", model: "gpt-4", choices: [{ delta: { content: "hi" }, finish_reason: null }] },
      state
    );
    state.streamTruncated = true;
    const flush = openaiToClaudeResponse(null, state);
    expect(flush.find((e) => e.type === "error")).toBeTruthy();
    expect(flush.find((e) => e.type === "message_stop")).toBeUndefined();
  });

  it("openaiToClaudeResponse still emits message_stop on a clean (non-truncated) close", () => {
    const state = { toolCalls: new Map() };
    openaiToClaudeResponse(
      { id: "chatcmpl-abc12345", model: "gpt-4", choices: [{ delta: { content: "hi" }, finish_reason: null }] },
      state
    );
    state.streamTruncated = false;
    const flush = openaiToClaudeResponse(null, state);
    expect(flush.find((e) => e.type === "message_stop")).toBeTruthy();
    expect(flush.find((e) => e.type === "error")).toBeUndefined();
  });

  it("openaiResponsesToOpenAIResponse returns an error (not a finish chunk) when truncated", () => {
    const state = {};
    openaiResponsesToOpenAIResponse({ type: "response.output_text.delta", delta: "hi" }, state);
    state.streamTruncated = true;
    const flush = openaiResponsesToOpenAIResponse(null, state);
    expect(flush.error).toBeTruthy();
    expect(flush.choices).toBeUndefined();
  });
});

describe("redirect credential stripping", () => {
  it("strips the Black Forest Labs x-key header on cross-origin redirect", () => {
    expect(shouldStripCredentialHeaderOnRedirect("x-key")).toBe(true);
    expect(shouldStripCredentialHeaderOnRedirect("X-Key")).toBe(true);
  });
});

describe("resolveConnectionProxyConfig — bound pool fails closed", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("flags proxyRequiredUnavailable when the bound pool is inactive", async () => {
    vi.doMock("@/models", () => ({
      getProxyPoolById: vi.fn(async () => ({
        id: "p1",
        isActive: false,
        proxyUrl: "http://proxy:1",
        strictProxy: true,
      })),
    }));
    const { resolveConnectionProxyConfig } = await import("../../src/lib/network/connectionProxy.js");
    const cfg = await resolveConnectionProxyConfig({ proxyPoolId: "p1" });
    expect(cfg.source).toBe("pool_unresolved");
    expect(cfg.proxyRequiredUnavailable).toBe(true);
    expect(cfg.connectionProxyUrl).toBe("");
  });

  it("flags proxyRequiredUnavailable when the pool lookup throws", async () => {
    vi.doMock("@/models", () => ({
      getProxyPoolById: vi.fn(async () => {
        throw new Error("db down");
      }),
    }));
    const { resolveConnectionProxyConfig } = await import("../../src/lib/network/connectionProxy.js");
    const cfg = await resolveConnectionProxyConfig({ proxyPoolId: "p1" });
    expect(cfg.proxyRequiredUnavailable).toBe(true);
  });
});
