/**
 * Debug translator route must not bypass cache integrity guards.
 */
import { describe, it, expect, vi } from "vitest";
import { FORMATS } from "../../open-sse/translator/formats.js";

vi.mock("open-sse/services/provider.js", () => ({
  detectFormat: () => FORMATS.CLAUDE,
  getTargetFormat: () => FORMATS.CLAUDE,
}));
vi.mock("open-sse/translator/index.js", () => ({
  translateRequest: vi.fn(),
}));
vi.mock("open-sse/services/model.js", () => ({
  parseModel: () => ({ provider: "claude", model: "claude-sonnet-4-5" }),
}));
vi.mock("@/lib/localDb.js", () => ({
  getProviderConnections: vi.fn(),
}));
vi.mock("open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(),
}));

const { POST } = await import("../../src/app/api/translator/translate/route.js");

describe("translator debug route — cache guards", () => {
  it("step 2 rejects cross-format translation when client has cache breakpoints", async () => {
    const res = await POST({
      json: async () => ({
        step: 2,
        body: {
          model: "claude/claude-sonnet-4-5",
          messages: [{ role: "user", content: "hi", cache_control: { type: "ephemeral" } }],
        },
      }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.errorCode).toBe("cache_translation_forbidden");
  });
});
