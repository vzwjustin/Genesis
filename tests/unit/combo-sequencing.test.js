/**
 * Combo fallback sequencing (Tasks 7.1–7.6)
 * Requirements 5.1–5.6
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { shouldComboAdvance, handleComboChat, resetComboRotation, isZeroConnectionsResponse } from "../../open-sse/services/combo.js";

describe("shouldComboAdvance (Requirement 5.1, 5.3–5.5)", () => {
  it("does not advance on 2xx", () => {
    expect(shouldComboAdvance(200)).toBe(false);
    expect(shouldComboAdvance(201)).toBe(false);
  });

  it("does not advance on 4xx except 429", () => {
    expect(shouldComboAdvance(400)).toBe(false);
    expect(shouldComboAdvance(401)).toBe(false);
    expect(shouldComboAdvance(404)).toBe(false);
  });

  it("advances on 429", () => {
    expect(shouldComboAdvance(429)).toBe(true);
  });

  it("advances on 5xx", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(shouldComboAdvance(status)).toBe(true);
    }
  });
});

describe("handleComboChat sequencing", () => {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetComboRotation();
  });

  it("returns 200 immediately without trying later models (Req 5.2)", async () => {
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))
      .mockResolvedValueOnce(new Response("fail", { status: 500 }));

    const response = await handleComboChat({
      body: { messages: [] },
      models: ["a/model-1", "b/model-2"],
      handleSingleModel,
      log,
    });

    expect(response.status).toBe(200);
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(handleSingleModel).toHaveBeenCalledWith({ messages: [] }, "a/model-1");
  });

  it("returns 4xx to client without advancing (Req 5.3)", async () => {
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "bad request" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const response = await handleComboChat({
      body: { messages: [] },
      models: ["a/model-1", "b/model-2"],
      handleSingleModel,
      log,
    });

    expect(response.status).toBe(400);
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
  });

  it("advances on 429 and returns success from next model (Req 5.4)", async () => {
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const response = await handleComboChat({
      body: { messages: [] },
      models: ["a/model-1", "b/model-2"],
      handleSingleModel,
      log,
    });

    expect(response.status).toBe(200);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
  });

  it("advances on 5xx and returns success from next model (Req 5.5)", async () => {
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "server error" } }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const response = await handleComboChat({
      body: { messages: [] },
      models: ["a/model-1", "b/model-2"],
      handleSingleModel,
      log,
    });

    expect(response.status).toBe(200);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
  });

  it("returns HTTP 503 with last error when all models fail with 5xx (Req 5.6)", async () => {
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "first down" } }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "second down" } }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }));

    const response = await handleComboChat({
      body: { messages: [] },
      models: ["a/model-1", "b/model-2"],
      handleSingleModel,
      log,
    });

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.message).toContain("second down");
  });

  it("advances past combo entry with zero connections (404 + No active credentials)", async () => {
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "No active credentials for provider: a" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const response = await handleComboChat({
      body: { messages: [] },
      models: ["a/missing-creds", "b/model-2"],
      handleSingleModel,
      log,
    });

    // Zero connections should advance to the next model (Design: "Zero connections" rule)
    expect(response.status).toBe(200);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
  });

  it("returns generic 404 without advancing (non-zero-connections 404 per Req 5.3)", async () => {
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "Model not found" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const response = await handleComboChat({
      body: { messages: [] },
      models: ["a/missing-model", "b/model-2"],
      handleSingleModel,
      log,
    });

    // Generic 404 (not zero-connections) is a client error — return without advancing (Req 5.3)
    expect(response.status).toBe(404);
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
  });

  it("returns 503 when all combo models have zero connections", async () => {
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "No active credentials for provider: a" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "No active credentials for provider: b" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }));

    const response = await handleComboChat({
      body: { messages: [] },
      models: ["a/model-1", "b/model-2"],
      handleSingleModel,
      log,
    });

    // All models exhausted — HTTP 503
    expect(response.status).toBe(503);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    const body = await response.json();
    expect(body.error.message).toContain("No active credentials");
  });
});

describe("isZeroConnectionsResponse", () => {
  it("returns true for 404 with 'No active credentials for provider:' message", async () => {
    const response = new Response(JSON.stringify({ error: { message: "No active credentials for provider: claude" } }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
    expect(await isZeroConnectionsResponse(response)).toBe(true);
  });

  it("returns false for 404 with a different message", async () => {
    const response = new Response(JSON.stringify({ error: { message: "Model not found" } }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
    expect(await isZeroConnectionsResponse(response)).toBe(false);
  });

  it("returns false for non-404 status", async () => {
    const response = new Response(JSON.stringify({ error: { message: "No active credentials for provider: x" } }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
    expect(await isZeroConnectionsResponse(response)).toBe(false);
  });

  it("returns false for malformed JSON body", async () => {
    const response = new Response("not json", {
      status: 404,
      headers: { "Content-Type": "text/plain" },
    });
    expect(await isZeroConnectionsResponse(response)).toBe(false);
  });
});
