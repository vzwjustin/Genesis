/**
 * Unit tests for open-sse/translator/request/openai-to-kiro.js
 *
 * Tests cover:
 *  - buildKiroPayload() - basic message conversion
 *  - Image forwarding fix: images in currentMessage must be included in payload
 */

import { describe, it, expect } from "vitest";
import { buildKiroPayload } from "../../open-sse/translator/request/openai-to-kiro.js";

const contentOf = (result) =>
  result.conversationState.currentMessage.userInputMessage.content;

describe("buildKiroPayload", () => {
  describe("basic message conversion", () => {
    it("should convert a simple text message", () => {
      const body = {
        messages: [{ role: "user", content: "Hello" }]
      };

      const result = buildKiroPayload("claude-sonnet-4.6", body, true, {});

      const currentMsg = result.conversationState.currentMessage;
      expect(currentMsg.userInputMessage.content).toContain("Hello");
      expect(currentMsg.userInputMessage.modelId).toBe("claude-sonnet-4.6");
      expect(currentMsg.userInputMessage.origin).toBe("AI_EDITOR");
    });

    it("should not include images field when no images are present", () => {
      const body = {
        messages: [{ role: "user", content: "No images here" }]
      };

      const result = buildKiroPayload("claude-sonnet-4.6", body, true, {});

      const currentMsg = result.conversationState.currentMessage;
      expect(currentMsg.userInputMessage.images).toBeUndefined();
    });
  });

  describe("image forwarding", () => {
    it("should forward base64 image from image_url content part", () => {
      const fakeBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      const body = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Describe this image" },
              { type: "image_url", image_url: { url: `data:image/png;base64,${fakeBase64}` } }
            ]
          }
        ]
      };

      const result = buildKiroPayload("claude-sonnet-4.6", body, true, {});

      const currentMsg = result.conversationState.currentMessage;
      expect(currentMsg.userInputMessage.images).toBeDefined();
      expect(currentMsg.userInputMessage.images).toHaveLength(1);
      expect(currentMsg.userInputMessage.images[0].format).toBe("png");
      expect(currentMsg.userInputMessage.images[0].source.bytes).toBe(fakeBase64);
    });

    it("should forward multiple base64 images", () => {
      const fakeBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      const body = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Compare these images" },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${fakeBase64}` } },
              { type: "image_url", image_url: { url: `data:image/png;base64,${fakeBase64}` } }
            ]
          }
        ]
      };

      const result = buildKiroPayload("claude-sonnet-4.6", body, true, {});

      const currentMsg = result.conversationState.currentMessage;
      expect(currentMsg.userInputMessage.images).toHaveLength(2);
      expect(currentMsg.userInputMessage.images[0].format).toBe("jpeg");
      expect(currentMsg.userInputMessage.images[1].format).toBe("png");
    });

    it("should not include images field when images array is empty", () => {
      const body = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Just text" }
            ]
          }
        ]
      };

      const result = buildKiroPayload("claude-sonnet-4.6", body, true, {});

      const currentMsg = result.conversationState.currentMessage;
      expect(currentMsg.userInputMessage.images).toBeUndefined();
    });

    it("should include both images and text content together", () => {
      const fakeBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      const body = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is in this image?" },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${fakeBase64}` } }
            ]
          }
        ]
      };

      const result = buildKiroPayload("claude-sonnet-4.6", body, true, {});

      const currentMsg = result.conversationState.currentMessage;
      expect(currentMsg.userInputMessage.content).toContain("What is in this image?");
      expect(currentMsg.userInputMessage.images).toHaveLength(1);
    });

    it("should treat http image URLs as text fallback (Kiro only supports base64)", () => {
      const body = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Look at this" },
              { type: "image_url", image_url: { url: "https://example.com/photo.jpg" } }
            ]
          }
        ]
      };

      const result = buildKiroPayload("claude-sonnet-4.6", body, true, {});

      const currentMsg = result.conversationState.currentMessage;
      // HTTP URLs are not supported by Kiro — converted to text placeholder
      expect(currentMsg.userInputMessage.images).toBeUndefined();
      expect(currentMsg.userInputMessage.content).toContain("[Image: https://example.com/photo.jpg]");
    });
  });

  describe("thinking budget", () => {
    it("maps reasoning_effort low to max_thinking_length 1024", () => {
      const body = {
        reasoning_effort: "low",
        messages: [{ role: "user", content: "Think lightly" }],
      };

      const result = buildKiroPayload("claude-sonnet-4.6", body, true, {});

      expect(contentOf(result)).toContain("<max_thinking_length>1024</max_thinking_length>");
    });

    it("maps reasoning_effort high to max_thinking_length 24576", () => {
      const body = {
        reasoning_effort: "high",
        messages: [{ role: "user", content: "Think deeply" }],
      };

      const result = buildKiroPayload("claude-sonnet-4.6", body, true, {});

      expect(contentOf(result)).toContain("<max_thinking_length>24576</max_thinking_length>");
    });

    it("clamps reasoning_effort max to Kiro max_thinking_length 32000", () => {
      const body = {
        reasoning_effort: "max",
        messages: [{ role: "user", content: "Think as much as possible" }],
      };

      const result = buildKiroPayload("claude-sonnet-4.6", body, true, {});

      expect(contentOf(result)).toContain("<max_thinking_length>32000</max_thinking_length>");
    });

    it("clamps OpenAI Responses reasoning.effort xhigh to max_thinking_length 32000", () => {
      const body = {
        reasoning: { effort: "xhigh" },
        messages: [{ role: "user", content: "Think extra deeply" }],
      };

      const result = buildKiroPayload("claude-sonnet-4.6", body, true, {});

      expect(contentOf(result)).toContain("<max_thinking_length>32000</max_thinking_length>");
    });

    it("uses Claude thinking.budget_tokens as max_thinking_length", () => {
      const body = {
        thinking: { type: "enabled", budget_tokens: 4096 },
        messages: [{ role: "user", content: "Use a fixed budget" }],
      };

      const result = buildKiroPayload("claude-sonnet-4.6", body, true, {});

      expect(contentOf(result)).toContain("<max_thinking_length>4096</max_thinking_length>");
    });

    it("uses the default budget for synthetic -thinking models with no explicit config", () => {
      const body = {
        messages: [{ role: "user", content: "Think by model suffix" }],
      };

      const result = buildKiroPayload("claude-sonnet-4.6-thinking", body, true, {});

      expect(contentOf(result)).toContain("<max_thinking_length>16000</max_thinking_length>");
    });

    it("does not inject thinking prefix for reasoning_effort none", () => {
      const body = {
        reasoning_effort: "none",
        messages: [{ role: "user", content: "Do not think" }],
      };

      const result = buildKiroPayload("claude-sonnet-4.6", body, true, {});

      expect(contentOf(result)).not.toContain("<thinking_mode>enabled</thinking_mode>");
      expect(contentOf(result)).not.toContain("<max_thinking_length>");
    });
  });
});
