/**
 * Round 19 — internal API helper, combo account exhaustion, MCP registry hardening
 * No mocks: pure Response probes + source inspection.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  handleComboChat,
  isProviderAccountsExhaustedResponse,
  isModelResolutionFailureResponse,
} from "../../open-sse/services/combo.js";
import { PROXY_EXHAUSTED_HEADER } from "../../open-sse/utils/error.js";

const noopLog = { info() {}, warn() {}, error() {} };
const root = dirname(fileURLToPath(import.meta.url));

describe("isProviderAccountsExhaustedResponse", () => {
  it("returns true for 401/403 with Retry-After and proxy exhaustion marker", async () => {
    const withRetry = (status) =>
      new Response(JSON.stringify({ error: { message: "unauthorized" } }), {
        status,
        headers: {
          "Retry-After": "30",
          [PROXY_EXHAUSTED_HEADER]: "1",
          "Content-Type": "application/json",
        },
      });
    expect(await isProviderAccountsExhaustedResponse(withRetry(401))).toBe(true);
    expect(await isProviderAccountsExhaustedResponse(withRetry(403))).toBe(true);
  });

  it("returns false for 401/403 with Retry-After but no proxy marker", async () => {
    const withRetry = (status) =>
      new Response(JSON.stringify({ error: { message: "unauthorized" } }), {
        status,
        headers: { "Retry-After": "30", "Content-Type": "application/json" },
      });
    expect(await isProviderAccountsExhaustedResponse(withRetry(401))).toBe(false);
    expect(await isProviderAccountsExhaustedResponse(withRetry(403))).toBe(false);
  });

  it("returns true for known proxy exhaustion messages", async () => {
    const messages = [
      "All accounts unavailable for provider openai",
      "No more accounts available",
      "Token refresh failed for connection abc",
      "No active credentials for provider: claude",
    ];
    for (const message of messages) {
      const response = new Response(JSON.stringify({ error: { message } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
      expect(await isProviderAccountsExhaustedResponse(response)).toBe(true);
    }
  });

  it("returns false for bare upstream 401/403 without proxy signals", async () => {
    for (const status of [401, 403]) {
      const response = new Response(JSON.stringify({ error: { message: "unauthorized" } }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
      expect(await isProviderAccountsExhaustedResponse(response)).toBe(false);
    }
  });

  it("returns false for non-auth status codes", async () => {
    const response = new Response(JSON.stringify({ error: { message: "All accounts unavailable" } }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
    expect(await isProviderAccountsExhaustedResponse(response)).toBe(false);
  });
});

describe("isModelResolutionFailureResponse — broken combo message", () => {
  it("returns true for combo with no valid model targets", async () => {
    const response = new Response(
      JSON.stringify({ error: { message: 'Combo "empty" has no valid model targets configured.' } }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
    expect(await isModelResolutionFailureResponse(response)).toBe(true);
  });
});

describe("handleComboChat — provider account exhaustion advances", () => {
  it("advances past 401 with Retry-After to next model", async () => {
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

  it("advances past 401 with All accounts unavailable message", async () => {
    const callOrder = [];
    const handleSingleModel = async (_body, model) => {
      callOrder.push(model);
      if (model === "openai/gpt-4o") {
        return new Response(JSON.stringify({ error: { message: "All accounts unavailable" } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
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

  it("does NOT advance on bare 401 without proxy exhaustion signals", async () => {
    const callOrder = [];
    const handleSingleModel = async (_body, model) => {
      callOrder.push(model);
      return new Response(JSON.stringify({ error: { message: "unauthorized" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    };

    const result = await handleComboChat({
      body: { messages: [] },
      models: ["openai/gpt-4o", "anthropic/claude-sonnet"],
      handleSingleModel,
      log: noopLog,
    });

    expect(callOrder).toEqual(["openai/gpt-4o"]);
    expect(result.status).toBe(401);
  });
});

describe("internalApi shared helper", () => {
  const apiRoot = join(root, "../../src");

  it("models/test and test-models routes use internalApi helpers", () => {
    const modelsTest = readFileSync(join(apiRoot, "app/api/models/test/route.js"), "utf8");
    expect(modelsTest).toContain("internalApiPost");
    expect(modelsTest).not.toMatch(/\bfetch\s*\(/);

    const testModels = readFileSync(join(apiRoot, "app/api/providers/[id]/test-models/route.js"), "utf8");
    expect(testModels).toContain("internalApiGet");
    expect(testModels).toContain("internalApiPost");
    expect(testModels).not.toMatch(/\bfetch\s*\(/);
  });

  it("internalApi uses loopback origin, CLI token, and JSON fail-closed parsing", () => {
    const src = readFileSync(join(apiRoot, "lib/internalApi.js"), "utf8");
    expect(src).toContain("127.0.0.1");
    expect(src).toContain("x-9r-cli-token");
    expect(src).toContain("[internalApi] Failed to load API keys:");
    expect(src).toContain('parseError = "Invalid JSON response"');
    expect(src).toContain('parseError = "Empty response body"');
  });
});

describe("cowork MCP registry pagination hardening", () => {
  it("route source includes cursor loop guard, partial results, and stale cache fallback", () => {
    const src = readFileSync(
      join(root, "../../src/app/api/cli-tools/cowork-mcp-registry/route.js"),
      "utf8"
    );
    expect(src).toContain("seenCursors");
    expect(src).toContain("partial");
    expect(src).toContain("stale: true");
    expect(src).toContain("proxyAwareFetch");
    expect(src).toContain("nextCursor === cursor");
  });
});
