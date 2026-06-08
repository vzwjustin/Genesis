/**
 * Round 8 bug-hunt regression tests
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { formatRetryAfter } from "../../open-sse/services/accountFallback.js";
import { handleComboChat } from "../../open-sse/services/combo.js";
const mockLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const handleChatCore = vi.fn();
vi.mock("../../open-sse/handlers/chatCore.js", () => ({
  handleChatCore: (...args) => handleChatCore(...args),
}));

describe("formatRetryAfter minimum delay", () => {
  it("never returns reset after 0s for expired timestamps", () => {
    const past = new Date(Date.now() - 5000).toISOString();
    expect(formatRetryAfter(past)).toBe("reset after 1s");
  });

  it("never returns reset after 0s for timestamps at now", () => {
    const now = new Date().toISOString();
    expect(formatRetryAfter(now)).toBe("reset after 1s");
  });
});

describe("combo exhaustion without rate-limit metadata", () => {
  it("returns Retry-After >= 1 when no model supplied retry metadata", async () => {
    const handleSingleModel = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "server down" } }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })
    );

    const result = await handleComboChat({
      body: { model: "combo1", messages: [] },
      models: ["cc/claude-opus", "openai/gpt-4o"],
      handleSingleModel,
      log: mockLog,
    });

    expect(result.status).toBeGreaterThanOrEqual(500);
    const retryAfter = parseInt(result.headers.get("Retry-After"), 10);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    const body = await result.json();
    expect(body.error.message).not.toContain("reset after 0s");
    expect(body.error.message).toContain("reset after 1s");
  });
});

describe("responsesHandler incomplete SSE assembly", () => {
  beforeEach(() => {
    handleChatCore.mockReset();
  });

  it("returns 502 when assembled Responses JSON is not completed", async () => {
    const partialSSE = [
      "event: response.created",
      'data: {"type":"response.created","response":{"id":"resp_1","created_at":1}}',
      "",
    ].join("\n");

    const sseBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(partialSSE));
        controller.close();
      },
    });

    handleChatCore.mockResolvedValue({
      success: true,
      response: new Response(sseBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    });

    const { handleResponsesCore } = await import("../../open-sse/handlers/responsesHandler.js");
    const result = await handleResponsesCore({
      body: { model: "gpt-5", input: "hi" },
      modelInfo: { provider: "codex", model: "gpt-5" },
      credentials: {},
      log: mockLog,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(result.error).toContain("Incomplete");
  });
});

describe("Kiro OAuth proxy routing", () => {
  const kiroServiceSrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../src/lib/oauth/services/kiro.js"),
    "utf8"
  );

  it("routes all OAuth HTTP through proxyAwareFetch", () => {
    expect(kiroServiceSrc).not.toMatch(/\bfetch\s*\(/);
    expect(kiroServiceSrc.match(/proxyAwareFetch/g)?.length).toBeGreaterThanOrEqual(4);
  });
});
