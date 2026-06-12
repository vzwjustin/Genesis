/**
 * Round 8 bug-hunt regression tests
 * No mocks: pure helpers, real combo probes, source inspection.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { formatRetryAfter } from "../../open-sse/services/accountFallback.js";
import { handleComboChat } from "../../open-sse/services/combo.js";

const root = dirname(fileURLToPath(import.meta.url));
const noopLog = { info() {}, warn() {}, error() {} };

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
    const handleSingleModel = async () =>
      new Response(JSON.stringify({ error: { message: "server down" } }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });

    const result = await handleComboChat({
      body: { model: "combo1", messages: [] },
      models: ["cc/claude-opus", "openai/gpt-4o"],
      handleSingleModel,
      log: noopLog,
    });

    expect(result.status).toBeGreaterThanOrEqual(500);
    const retryAfter = parseInt(result.headers.get("Retry-After"), 10);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    const body = await result.json();
    expect(body.error.message).not.toContain("reset after 0s");
    expect(body.error.message).toContain("reset after 1s");
  });
});

describe("Responses API SSE assembly on live chatCore path (source)", () => {
  it("sseToJsonHandler uses convertResponsesStreamToJson for openai-responses", () => {
    const src = readFileSync(join(root, "../../open-sse/handlers/chatCore/sseToJsonHandler.js"), "utf8");
    expect(src).toContain("convertResponsesStreamToJson");
  });

  it("/v1/responses route delegates to handleChat", () => {
    const src = readFileSync(join(root, "../../src/app/api/v1/responses/route.js"), "utf8");
    expect(src).toContain("handleChat");
    expect(src).not.toContain("handleResponsesCore");
  });
});

describe("Kiro OAuth proxy routing", () => {
  it("routes all OAuth HTTP through proxyAwareFetch", () => {
    const kiroServiceSrc = readFileSync(join(root, "../../src/lib/oauth/services/kiro.js"), "utf8");
    expect(kiroServiceSrc).not.toMatch(/\bfetch\s*\(/);
    expect(kiroServiceSrc.match(/proxyAwareFetch/g)?.length).toBeGreaterThanOrEqual(4);
  });
});
