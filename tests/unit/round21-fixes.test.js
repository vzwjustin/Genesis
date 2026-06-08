/**
 * Round 21 — stale compact shim, test harness fixes, combo exhaustion Retry-After
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleComboChat } from "../../open-sse/services/combo.js";

const mockLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const root = dirname(fileURLToPath(import.meta.url));

describe("compact.js re-export shim", () => {
  it("re-exports canonical handleComboChat from combo.js (no stale duplicate)", async () => {
    const src = readFileSync(join(root, "../../open-sse/services/compact.js"), "utf8");
    expect(src).toContain('from "./combo.js"');
    expect(src).not.toContain("result.ok || result.status < 500");

    const compact = await import("../../open-sse/services/compact.js");
    const combo = await import("../../open-sse/services/combo.js");
    expect(compact.handleComboChat).toBe(combo.handleComboChat);
  });
});

describe("handleComboChat — mixed account exhaustion Retry-After", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("propagates earliest Retry-After when models fail with exhaustion then rate limit", async () => {
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "All accounts unavailable" } }), {
          status: 401,
          headers: { "Retry-After": "120", "Content-Type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "Retry-After": "30", "Content-Type": "application/json" },
        })
      );

    const result = await handleComboChat({
      body: { messages: [] },
      models: ["openai/gpt-4o", "anthropic/claude-sonnet"],
      handleSingleModel,
      log: mockLog,
    });

    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(result.status).toBe(503);
    const retryAfter = parseInt(result.headers.get("Retry-After"), 10);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(30);
  });
});

describe("version and minimax test harness alignment", () => {
  it("version route tests mock proxyAwareFetch not global.fetch", () => {
    const versionTest = readFileSync(join(root, "version-route.test.js"), "utf8");
    const releasesTest = readFileSync(join(root, "version-releases-route.test.js"), "utf8");
    const minimaxTest = readFileSync(join(root, "minimax-voices.test.js"), "utf8");

    for (const src of [versionTest, releasesTest, minimaxTest]) {
      expect(src).toContain("proxyAwareFetch");
      expect(src).not.toMatch(/global\.fetch\s*=\s*vi\.fn/);
    }
  });
});
