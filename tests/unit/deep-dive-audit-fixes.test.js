/**
 * Regression tests for deep-dive audit fixes (batch 2).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixToolUseOrdering } from "../../open-sse/translator/helpers/claudeHelper.js";
import { claudeToOpenAIRequest } from "../../open-sse/translator/request/claude-to-openai.js";
import { isRegisteredProviderId } from "../../src/sse/utils/providerRegistry.js";
import { mergeAbortSignals } from "../../open-sse/utils/abortSignal.js";

const root = dirname(fileURLToPath(import.meta.url));

describe("fixToolUseOrdering — tool_result isolation", () => {
  it("does not merge consecutive user messages when either contains tool_result", () => {
    const input = [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      { role: "user", content: [{ type: "text", text: "follow up" }] },
    ];
    const out = fixToolUseOrdering(input);
    expect(out).toHaveLength(2);
    expect(out[0].content.some((b) => b.type === "tool_result")).toBe(true);
    expect(out[1].content.some((b) => b.type === "text")).toBe(true);
  });
});

describe("claudeToOpenAIRequest — built-in tools", () => {
  it("preserves non-function Anthropic built-in tools", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    };
    const out = claudeToOpenAIRequest("gpt-4o", body, false);
    expect(out.tools[0].type).toBe("web_search_20250305");
    expect(out.tools[0].function).toBeUndefined();
  });
});

describe("providerRegistry", () => {
  it("rejects unknown provider ids", () => {
    expect(isRegisteredProviderId("totally-unknown-provider")).toBe(false);
  });

  it("accepts known providers and compatible prefixes", () => {
    expect(isRegisteredProviderId("openai")).toBe(true);
    expect(isRegisteredProviderId("openai-compatible-node-1")).toBe(true);
  });
});

describe("mergeAbortSignals", () => {
  it("returns a single signal when only one input is provided", () => {
    const ctrl = new AbortController();
    expect(mergeAbortSignals([ctrl.signal]).signal).toBe(ctrl.signal);
  });
});

describe("chatCore — caveman cache integrity gate", () => {
  it("skips caveman when cacheIntegrityFailed", () => {
    const src = readFileSync(join(root, "../../open-sse/handlers/chatCore.js"), "utf8");
    expect(src).toMatch(/cavemanEnabled.*cacheIntegrityFailed/s);
  });
});

describe("proxyFetch — connection NO_PROXY blocks env proxy", () => {
  it("source prevents env proxy when connection proxy is configured", () => {
    const src = readFileSync(join(root, "../../open-sse/utils/proxyFetch.js"), "utf8");
    expect(src).toContain("connectionProxyConfigured");
  });
});

describe("health route", () => {
  it("reports db status", () => {
    const src = readFileSync(join(root, "../../src/app/api/health/route.js"), "utf8");
    expect(src).toContain("db:");
  });

  it("returns 503 only for db failure; optional telemetry fails open", () => {
    const src = readFileSync(join(root, "../../src/app/api/health/route.js"), "utf8");
    expect(src).toContain("status: dbOk ? 200 : 503");
    expect(src).toContain("degraded");
    expect(src).not.toMatch(/catch\s*\{[^}]*body\.ok\s*=\s*false/s);
  });
});

describe("settings PATCH keys", () => {
  it("allows mitmRouterBaseUrl and dnsToolEnabled", () => {
    const src = readFileSync(join(root, "../../src/app/api/settings/route.js"), "utf8");
    expect(src).toContain('"mitmRouterBaseUrl"');
    expect(src).toContain('"dnsToolEnabled"');
  });
});
