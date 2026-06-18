/**
 * Combo stop on 200: return response, don't advance position (Requirement 5.2)
 *
 * WHEN a model in the Combo returns HTTP 200, THE Proxy SHALL return the response
 * to the Client AND SHALL NOT advance the Combo position.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { handleComboChat, resetComboRotation, getRotatedModels } from "../../open-sse/services/combo.js";

const mockLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeResponse(status, body = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Combo stop on 200 — Requirement 5.2", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetComboRotation();
  });

  describe("fallback strategy", () => {
    it("returns the 200 response immediately to the client", async () => {
      const handleSingleModel = vi.fn()
        .mockResolvedValueOnce(makeResponse(200, { message: "success" }));

      const result = await handleComboChat({
        body: { messages: [] },
        models: ["cc/opus", "openai/gpt-4o", "gemini/pro"],
        handleSingleModel,
        log: mockLog,
        comboName: "test-combo",
        comboStrategy: "fallback",
      });

      expect(result.status).toBe(200);
      expect(handleSingleModel).toHaveBeenCalledTimes(1);
      expect(handleSingleModel).toHaveBeenCalledWith({ messages: [] }, "cc/opus");
    });

    it("does NOT try subsequent models after 200", async () => {
      const handleSingleModel = vi.fn()
        .mockResolvedValueOnce(makeResponse(200, { message: "first model works" }));

      await handleComboChat({
        body: { messages: [] },
        models: ["cc/opus", "openai/gpt-4o"],
        handleSingleModel,
        log: mockLog,
        comboName: "test-combo",
        comboStrategy: "fallback",
      });

      // Only the first model is tried
      expect(handleSingleModel).toHaveBeenCalledTimes(1);
    });

    it("returns 200 from second model when first fails with 5xx", async () => {
      const handleSingleModel = vi.fn()
        .mockResolvedValueOnce(makeResponse(500, { error: "internal error" }))
        .mockResolvedValueOnce(makeResponse(200, { message: "second model works" }));

      const result = await handleComboChat({
        body: { messages: [] },
        models: ["cc/opus", "openai/gpt-4o"],
        handleSingleModel,
        log: mockLog,
        comboName: "test-combo",
        comboStrategy: "fallback",
      });

      expect(result.status).toBe(200);
      expect(handleSingleModel).toHaveBeenCalledTimes(2);
    });
  });

  describe("round-robin strategy", () => {
    it("rotates after a 200 success when sticky limit is reached", async () => {
      const models = ["cc/opus", "openai/gpt-4o"];

      // First request: succeeds on first model
      const handleSingleModel1 = vi.fn()
        .mockResolvedValueOnce(makeResponse(200, { message: "opus success" }));

      await handleComboChat({
        body: { messages: [] },
        models,
        handleSingleModel: handleSingleModel1,
        log: mockLog,
        comboName: "rr-combo",
        comboStrategy: "round-robin",
        comboStickyLimit: 1,
      });

      const rotated = getRotatedModels(models, "rr-combo", "round-robin", 1);
      expect(rotated[0]).toBe("openai/gpt-4o");
    });

    it("honors stickyLimit across successful requests", async () => {
      const models = ["cc/opus", "openai/gpt-4o"];
      const picks = [];
      for (let i = 0; i < 5; i++) {
        await handleComboChat({
          body: { messages: [] },
          models,
          handleSingleModel: vi.fn(async (_body, model) => {
            picks.push(model);
            return makeResponse(200, { message: "success" });
          }),
          log: mockLog,
          comboName: "sticky-combo",
          comboStrategy: "round-robin",
          comboStickyLimit: 2,
        });
      }

      expect(picks).toEqual(["cc/opus", "cc/opus", "openai/gpt-4o", "openai/gpt-4o", "cc/opus"]);
    });

    it("pins to fallback model index when first model fails and second succeeds", async () => {
      const models = ["cc/opus", "openai/gpt-4o", "gemini/pro"];

      const handleSingleModel = vi.fn()
        .mockResolvedValueOnce(makeResponse(500, { error: "server error" }))
        .mockResolvedValueOnce(makeResponse(200, { message: "gpt-4o success" }));

      await handleComboChat({
        body: { messages: [] },
        models,
        handleSingleModel,
        log: mockLog,
        comboName: "fallback-pin-combo",
        comboStrategy: "round-robin",
        comboStickyLimit: 1,
      });

      // The successful model was "openai/gpt-4o" (index 1 in original models)
      // Position should be pinned to index 1
      const rotated = getRotatedModels(models, "fallback-pin-combo", "round-robin", 1);
      expect(rotated[0]).toBe("openai/gpt-4o");
    });
  });

  describe("response body preservation", () => {
    it("returns the exact response from the successful model", async () => {
      const successBody = { id: "chatcmpl-123", choices: [{ message: { content: "Hello!" } }] };
      const handleSingleModel = vi.fn()
        .mockResolvedValueOnce(makeResponse(200, successBody));

      const result = await handleComboChat({
        body: { messages: [] },
        models: ["cc/opus"],
        handleSingleModel,
        log: mockLog,
        comboName: "test-combo",
        comboStrategy: "fallback",
      });

      const body = await result.json();
      expect(body).toEqual(successBody);
    });
  });
});
