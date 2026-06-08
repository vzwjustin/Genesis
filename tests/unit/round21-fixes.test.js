/**
 * Round 21 — stale compact shim, test harness, combo exhaustion Retry-After
 * No mocks: real imports, real Response objects, source inspection.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { handleComboChat } from "../../open-sse/services/combo.js";

const noopLog = { info() {}, warn() {}, error() {} };
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
  it("propagates earliest Retry-After when models fail with exhaustion then rate limit", async () => {
    let callCount = 0;
    const handleSingleModel = async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(JSON.stringify({ error: { message: "All accounts unavailable" } }), {
          status: 401,
          headers: { "Retry-After": "120", "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "Retry-After": "30", "Content-Type": "application/json" },
      });
    };

    const result = await handleComboChat({
      body: { messages: [] },
      models: ["openai/gpt-4o", "anthropic/claude-sonnet"],
      handleSingleModel,
      log: noopLog,
    });

    expect(callCount).toBe(2);
    expect(result.status).toBe(503);
    const retryAfter = parseInt(result.headers.get("Retry-After"), 10);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(30);
  });
});

describe("version and minimax routes use proxyAwareFetch (source)", () => {
  it("version routes delegate to fetchGitHubReleases without bare fetch", () => {
    const version = readFileSync(join(root, "../../src/app/api/version/route.js"), "utf8");
    const releases = readFileSync(join(root, "../../src/app/api/version/releases/route.js"), "utf8");
    for (const src of [version, releases]) {
      expect(src).toContain("fetchGitHubReleases");
      expect(src).not.toMatch(/\bfetch\s*\(/);
    }
  });

  it("minimax voices route uses proxyAwareFetch not bare fetch", () => {
    const src = readFileSync(
      join(root, "../../src/app/api/media-providers/tts/minimax/voices/route.js"),
      "utf8"
    );
    expect(src).toContain("proxyAwareFetch");
    expect(src).toContain("buildProxyOptionsFromCredentials");
    expect(src).not.toMatch(/\bfetch\s*\(/);
  });
});
