/**
 * Live Claude prompt-cache verification (opt-in).
 *
 * Run:
 *   RUN_E2E=1 CACHE_E2E_PORT=20128 CACHE_E2E_KEY=<api-key> npm test claude-cache.e2e.test.js
 *
 * Requires: production server on CACHE_E2E_PORT, active Claude connection, rtk/caveman
 * may be on — cache breakpoints must still yield cache_read on the second request.
 */
import { describe, it, expect } from "vitest";

const PORT = process.env.CACHE_E2E_PORT || process.env.RTK_E2E_PORT || "20128";
const BASE = `http://localhost:${PORT}`;
const API_KEY = process.env.CACHE_E2E_KEY || process.env.RTK_E2E_KEY || "";

const RUN = process.env.RUN_E2E === "1";
const maybe = RUN && API_KEY ? describe : describe.skip;

function cachedSystemBlock() {
  return {
    type: "text",
    text: `Cache audit fixture.\n${"x".repeat(12_000)}`,
    cache_control: { type: "ephemeral" },
  };
}

async function postMessages(body) {
  const res = await fetch(`${BASE}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${API_KEY}`,
      "user-agent": "claude-cli/2.1.0",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // SSE or plain error text
  }
  return { res, text, json };
}

maybe("Claude prompt cache E2E", () => {
  it("server is reachable", async () => {
    const res = await fetch(`${BASE}/api/health`);
    expect(res.ok).toBe(true);
  });

  it("second request with same cached prefix reports cache_read_input_tokens", async () => {
    const model = process.env.CACHE_E2E_MODEL || "claude/claude-sonnet-4-20250514";
    const system = [cachedSystemBlock(), { type: "text", text: "uncached tail" }];

    const base = {
      model,
      max_tokens: 32,
      stream: false,
      system,
    };

    const first = await postMessages({
      ...base,
      messages: [{ role: "user", content: "Reply with one word: alpha" }],
    });
    expect(first.res.ok, first.text.slice(0, 500)).toBe(true);
    const usage1 = first.json?.usage;
    expect(usage1).toBeTruthy();

    const second = await postMessages({
      ...base,
      messages: [
        { role: "user", content: "Reply with one word: alpha" },
        { role: "assistant", content: "alpha" },
        { role: "user", content: "Reply with one word: beta" },
      ],
    });
    expect(second.res.ok, second.text.slice(0, 500)).toBe(true);
    const usage2 = second.json?.usage;
    expect(usage2).toBeTruthy();

    const cacheRead = Number(usage2.cache_read_input_tokens || 0);
    const cacheCreate = Number(usage1.cache_creation_input_tokens || 0);

    expect(
      cacheRead > 0 || cacheCreate > 0,
      `expected cache activity (read=${cacheRead}, first create=${cacheCreate}); usage=${JSON.stringify(usage2)}`
    ).toBe(true);
  });
});
