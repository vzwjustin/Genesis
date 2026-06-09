/**
 * Combo position advancement tests (Task 7.1)
 * Requirements: 5.1, 5.4, 5.5
 *
 * Verifies that combo position advances ONLY on 429/5xx,
 * NOT on 200 or other 4xx responses.
 */
import { describe, it, expect, vi } from "vitest";
import { shouldComboAdvance, handleComboChat } from "../../open-sse/services/combo.js";

const mockLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe("shouldComboAdvance (Req 5.1, 5.4, 5.5)", () => {
  it("returns true for HTTP 429 (rate limit)", () => {
    expect(shouldComboAdvance(429)).toBe(true);
  });

  it("returns true for HTTP 500", () => {
    expect(shouldComboAdvance(500)).toBe(true);
  });

  it("returns true for HTTP 502", () => {
    expect(shouldComboAdvance(502)).toBe(true);
  });

  it("returns true for HTTP 503", () => {
    expect(shouldComboAdvance(503)).toBe(true);
  });

  it("returns true for HTTP 504", () => {
    expect(shouldComboAdvance(504)).toBe(true);
  });

  it("returns false for HTTP 200 (success)", () => {
    expect(shouldComboAdvance(200)).toBe(false);
  });

  it("returns false for HTTP 400 (bad request)", () => {
    expect(shouldComboAdvance(400)).toBe(false);
  });

  it("returns false for HTTP 401 (unauthorized)", () => {
    expect(shouldComboAdvance(401)).toBe(false);
  });

  it("returns false for HTTP 403 (forbidden)", () => {
    expect(shouldComboAdvance(403)).toBe(false);
  });

  it("returns false for HTTP 404 (not found)", () => {
    expect(shouldComboAdvance(404)).toBe(false);
  });

  it("returns false for HTTP 422 (unprocessable)", () => {
    expect(shouldComboAdvance(422)).toBe(false);
  });
});

describe("handleComboChat — advancement on 429/5xx only (Req 5.1, 5.4, 5.5)", () => {
  it("advances past 429 and tries next model", async () => {
    const callOrder = [];
    const handleSingleModel = vi.fn(async (body, model) => {
      callOrder.push(model);
      if (model === "cc/claude-opus") {
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 });
      }
      return new Response(JSON.stringify({ result: "ok" }), { status: 200 });
    });

    const result = await handleComboChat({
      body: { model: "combo1", messages: [] },
      models: ["cc/claude-opus", "openai/gpt-4o"],
      handleSingleModel,
      log: mockLog,
    });

    expect(callOrder).toEqual(["cc/claude-opus", "openai/gpt-4o"]);
    expect(result.status).toBe(200);
  });

  it("advances past 500 and tries next model", async () => {
    const callOrder = [];
    const handleSingleModel = vi.fn(async (body, model) => {
      callOrder.push(model);
      if (model === "cc/claude-opus") {
        return new Response(JSON.stringify({ error: { message: "server error" } }), { status: 500 });
      }
      return new Response(JSON.stringify({ result: "ok" }), { status: 200 });
    });

    const result = await handleComboChat({
      body: { model: "combo1", messages: [] },
      models: ["cc/claude-opus", "openai/gpt-4o"],
      handleSingleModel,
      log: mockLog,
    });

    expect(callOrder).toEqual(["cc/claude-opus", "openai/gpt-4o"]);
    expect(result.status).toBe(200);
  });

  it("advances past 502 and tries next model", async () => {
    const callOrder = [];
    const handleSingleModel = vi.fn(async (body, model) => {
      callOrder.push(model);
      if (model === "provider1/model1") {
        return new Response(JSON.stringify({ error: { message: "bad gateway" } }), { status: 502 });
      }
      return new Response(JSON.stringify({ result: "ok" }), { status: 200 });
    });

    const result = await handleComboChat({
      body: { model: "combo1", messages: [] },
      models: ["provider1/model1", "provider2/model2"],
      handleSingleModel,
      log: mockLog,
    });

    expect(callOrder).toEqual(["provider1/model1", "provider2/model2"]);
    expect(result.status).toBe(200);
  });

  it("does NOT advance on 400 — returns response to client (Req 5.3)", async () => {
    const callOrder = [];
    const handleSingleModel = vi.fn(async (body, model) => {
      callOrder.push(model);
      if (model === "cc/claude-opus") {
        return new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 });
      }
      return new Response(JSON.stringify({ result: "ok" }), { status: 200 });
    });

    const result = await handleComboChat({
      body: { model: "combo1", messages: [] },
      models: ["cc/claude-opus", "openai/gpt-4o"],
      handleSingleModel,
      log: mockLog,
    });

    // Should NOT have tried the second model
    expect(callOrder).toEqual(["cc/claude-opus"]);
    expect(result.status).toBe(400);
  });

  it("does NOT advance on 401 — returns response to client (Req 5.3)", async () => {
    const callOrder = [];
    const handleSingleModel = vi.fn(async (body, model) => {
      callOrder.push(model);
      return new Response(JSON.stringify({ error: { message: "unauthorized" } }), { status: 401 });
    });

    const result = await handleComboChat({
      body: { model: "combo1", messages: [] },
      models: ["cc/claude-opus", "openai/gpt-4o"],
      handleSingleModel,
      log: mockLog,
    });

    expect(callOrder).toEqual(["cc/claude-opus"]);
    expect(result.status).toBe(401);
  });

  it("does NOT advance on 403 — returns response to client (Req 5.3)", async () => {
    const callOrder = [];
    const handleSingleModel = vi.fn(async (body, model) => {
      callOrder.push(model);
      return new Response(JSON.stringify({ error: { message: "forbidden" } }), { status: 403 });
    });

    const result = await handleComboChat({
      body: { model: "combo1", messages: [] },
      models: ["cc/claude-opus", "openai/gpt-4o"],
      handleSingleModel,
      log: mockLog,
    });

    expect(callOrder).toEqual(["cc/claude-opus"]);
    expect(result.status).toBe(403);
  });

  it("does NOT advance on 200 — returns success immediately (Req 5.2)", async () => {
    const callOrder = [];
    const handleSingleModel = vi.fn(async (body, model) => {
      callOrder.push(model);
      return new Response(JSON.stringify({ result: "ok" }), { status: 200 });
    });

    const result = await handleComboChat({
      body: { model: "combo1", messages: [] },
      models: ["cc/claude-opus", "openai/gpt-4o"],
      handleSingleModel,
      log: mockLog,
    });

    expect(callOrder).toEqual(["cc/claude-opus"]);
    expect(result.status).toBe(200);
  });

  it("advances on exception (network error) like 5xx", async () => {
    const callOrder = [];
    const handleSingleModel = vi.fn(async (body, model) => {
      callOrder.push(model);
      if (model === "cc/claude-opus") {
        throw new Error("network timeout");
      }
      return new Response(JSON.stringify({ result: "ok" }), { status: 200 });
    });

    const result = await handleComboChat({
      body: { model: "combo1", messages: [] },
      models: ["cc/claude-opus", "openai/gpt-4o"],
      handleSingleModel,
      log: mockLog,
    });

    expect(callOrder).toEqual(["cc/claude-opus", "openai/gpt-4o"]);
    expect(result.status).toBe(200);
  });

  it("returns 503 when all models return 429/5xx (Req 5.6)", async () => {
    const handleSingleModel = vi.fn(async (body, model) => {
      if (model === "cc/claude-opus") {
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 });
      }
      return new Response(JSON.stringify({ error: { message: "server down" } }), { status: 503 });
    });

    const result = await handleComboChat({
      body: { model: "combo1", messages: [] },
      models: ["cc/claude-opus", "openai/gpt-4o"],
      handleSingleModel,
      log: mockLog,
    });

    expect(result.status).toBe(503);
    const body = await result.json();
    expect(body.error.message).toContain("server down");
  });

  it("propagates Retry-After header from exhausted combo models", async () => {
    const handleSingleModel = vi.fn(async () => {
      return new Response(
        JSON.stringify({ error: { message: "rate limited" } }),
        { status: 429, headers: { "Retry-After": "30" } }
      );
    });

    const result = await handleComboChat({
      body: { model: "combo1", messages: [] },
      models: ["cc/claude-opus", "openai/gpt-4o"],
      handleSingleModel,
      log: mockLog,
    });

    expect(result.status).toBe(503);
    const retryAfter = parseInt(result.headers.get("Retry-After"), 10);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
  });
});
