/**
 * Regression tests for bug-hunt audit fixes (SSRF, streaming, combo, proxy).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { AzureExecutor } from "../../open-sse/executors/azure.js";
import openaiCompatNode from "../../open-sse/handlers/embeddingProviders/openaiCompatNode.js";
import { resolveOllamaLocalHost } from "../../open-sse/config/providers.js";
import {
  assertSafeResolvedHostname,
  validateProviderBaseUrl,
} from "../../open-sse/utils/ssrfGuard.js";
import { detectClientTool } from "../../open-sse/utils/clientDetector.js";
import {
  isProviderAccountsExhaustedResponse,
  handleComboChat,
} from "../../open-sse/services/combo.js";
import { unavailableResponse, PROXY_EXHAUSTED_HEADER } from "../../open-sse/utils/error.js";

const root = dirname(fileURLToPath(import.meta.url));
const noopLog = { info() {}, warn() {}, error() {} };

describe("SSRF — executor and embedding baseUrl validation", () => {
  it("DefaultExecutor rejects private compatible-node baseUrl", () => {
    const executor = new DefaultExecutor("openai-compatible-test");
    expect(() => executor.buildUrl("gpt-4", false, 0, {
      providerSpecificData: { baseUrl: "https://169.254.169.254/v1" },
    })).toThrow(/not allowed/);
  });

  it("DefaultExecutor allows public compatible-node baseUrl", () => {
    const executor = new DefaultExecutor("openai-compatible-test");
    const url = executor.buildUrl("gpt-4", false, 0, {
      providerSpecificData: { baseUrl: "https://api.example.com/v1" },
    });
    expect(url).toBe("https://api.example.com/v1/chat/completions");
  });

  it("openaiCompatNode rejects metadata host", () => {
    expect(() => openaiCompatNode.buildUrl("text-embedding-3-small", {
      providerSpecificData: { baseUrl: "https://metadata.google.internal/v1" },
    })).toThrow(/not allowed/);
  });

  it("resolveOllamaLocalHost allows default localhost", () => {
    expect(resolveOllamaLocalHost(null)).toBe("http://localhost:11434");
  });

  it("resolveOllamaLocalHost rejects metadata IP for custom baseUrl", () => {
    expect(() => resolveOllamaLocalHost({
      providerSpecificData: { baseUrl: "http://169.254.169.254:11434" },
    })).toThrow(/not allowed/);
  });

  it("resolveOllamaLocalHost allows custom loopback baseUrl", () => {
    expect(resolveOllamaLocalHost({
      providerSpecificData: { baseUrl: "http://127.0.0.1:11434" },
    })).toBe("http://127.0.0.1:11434");
  });

  it("AzureExecutor rejects private azureEndpoint", () => {
    const executor = new AzureExecutor();
    expect(() => executor.buildUrl("gpt-4", false, 0, {
      providerSpecificData: { azureEndpoint: "https://192.168.1.1" },
    })).toThrow(/not allowed/);
  });

  it("DefaultExecutor source uses validateProviderBaseUrl", () => {
    const src = readFileSync(join(root, "../../open-sse/executors/default.js"), "utf8");
    expect(src).toContain("validateProviderBaseUrl");
  });
});

describe("SSRF — DNS rebinding guard", () => {
  it("assertSafeResolvedHostname rejects localhost literal", async () => {
    await expect(assertSafeResolvedHostname("127.0.0.1")).rejects.toThrow(/not allowed/);
  });

  it("assertSafeResolvedHostname allows loopback when configured", async () => {
    await expect(assertSafeResolvedHostname("127.0.0.1", { allowLoopback: true })).resolves.toBeUndefined();
  });

  it("validateProviderBaseUrl blocks literal private IPs", () => {
    expect(() => validateProviderBaseUrl("https://10.0.0.1")).toThrow(/not allowed/);
  });

  it("DNS cache stores resolved addresses, not authorization decisions", () => {
    const src = readFileSync(join(root, "../../open-sse/utils/ssrfGuard.js"), "utf8");
    expect(src).toContain("{ addresses, expiry:");
    expect(src).not.toMatch(/\{\s*safe,\s*expiry:/);
  });
});

describe("clientDetector — Copilot heuristics", () => {
  it("does not classify x-initiator alone as github-copilot", () => {
    expect(detectClientTool({ "x-initiator": "user" }, {})).toBeNull();
  });

  it("classifies x-initiator with copilot user-agent", () => {
    expect(detectClientTool({
      "x-initiator": "user",
      "user-agent": "GitHubCopilotChat/0.38.0",
    }, {})).toBe("github-copilot");
  });
});

describe("combo account exhaustion — Retry-After requires proxy marker", () => {
  it("returns false for upstream 401 with Retry-After but no proxy marker", async () => {
    const response = new Response(JSON.stringify({ error: { message: "unauthorized" } }), {
      status: 401,
      headers: { "Retry-After": "30", "Content-Type": "application/json" },
    });
    expect(await isProviderAccountsExhaustedResponse(response)).toBe(false);
  });

  it("returns true for proxy-marked 401 with Retry-After", async () => {
    const response = new Response(JSON.stringify({ error: { message: "rate limited" } }), {
      status: 401,
      headers: {
        "Retry-After": "30",
        [PROXY_EXHAUSTED_HEADER]: "1",
        "Content-Type": "application/json",
      },
    });
    expect(await isProviderAccountsExhaustedResponse(response)).toBe(true);
  });

  it("unavailableResponse includes proxy exhaustion header", () => {
    const future = new Date(Date.now() + 30_000).toISOString();
    const response = unavailableResponse(503, "All accounts unavailable", future, "reset after 30s");
    expect(response.headers.get(PROXY_EXHAUSTED_HEADER)).toBe("1");
  });

  it("handleComboChat advances on proxy-marked 401 with Retry-After", async () => {
    const callOrder = [];
    const handleSingleModel = async (_body, model) => {
      callOrder.push(model);
      if (model === "openai/gpt-4o") {
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 401,
          headers: {
            "Retry-After": "60",
            [PROXY_EXHAUSTED_HEADER]: "1",
            "Content-Type": "application/json",
          },
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    };

    const result = await handleComboChat({
      body: { messages: [] },
      models: ["openai/gpt-4o", "anthropic/claude-sonnet"],
      handleSingleModel,
      log: noopLog,
    });

    expect(callOrder).toEqual(["openai/gpt-4o", "anthropic/claude-sonnet"]);
    expect(result.status).toBe(200);
  });
});

describe("stream error fail-closed", () => {
  it("grok-web streaming catch uses controller.error", () => {
    const src = readFileSync(join(root, "../../open-sse/executors/grok-web.js"), "utf8");
    expect(src).toContain("controller.error");
    expect(src).not.toMatch(/finish_reason:\s*"stop".*Stream error/s);
  });

  it("perplexity-web streaming catch uses controller.error", () => {
    const src = readFileSync(join(root, "../../open-sse/executors/perplexity-web.js"), "utf8");
    expect(src).toContain("controller.error");
    expect(src).not.toMatch(/finish_reason:\s*"stop".*Stream error/s);
  });
});

describe("proxyFetch hardening", () => {
  it("createBypassRequest wires abort signal without removing listener on success", () => {
    const src = readFileSync(join(root, "../../open-sse/utils/proxyFetch.js"), "utf8");
    expect(src).toContain("addEventListener(\"abort\", onAbort");
    expect(src).toContain("removeEventListener(\"abort\", onAbort)");
    expect(src).not.toMatch(/finish\(\(res\)/);
    expect(src).toContain("assertSafeResolvedHostname");
  });

  it("per-connection proxy failure does not fall back to direct", () => {
    const src = readFileSync(join(root, "../../open-sse/utils/proxyFetch.js"), "utf8");
    expect(src).toContain("connectionProxyUrl");
    expect(src).toMatch(/strictProxy === true \|\| connectionProxyUrl/);
  });
});
