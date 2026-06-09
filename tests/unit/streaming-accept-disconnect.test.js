/**
 * Tests for Accept header streaming detection (Task 8.4) and
 * client disconnect → upstream abort (Task 8.5)
 *
 * Requirements: 6.4, 6.5
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createStreamController, pipeWithDisconnect } from "../../open-sse/utils/streamHandler.js";

// Mirrors chatCore.js stream decision logic
function computeStreamFromAccept({ bodyStream, acceptHeader, provider }) {
  const ALWAYS_STREAMING = ["openai", "codex", "commandcode"];
  const providerRequiresStreaming = ALWAYS_STREAMING.includes(provider);
  let stream = providerRequiresStreaming ? true : (bodyStream !== false);

  const clientPrefersJson = (acceptHeader || "").includes("application/json");
  const clientPrefersSSE = (acceptHeader || "").includes("text/event-stream");
  if (clientPrefersJson && !clientPrefersSSE && bodyStream !== true) {
    stream = false;
  }
  return stream;
}

describe("Accept header detection for JSON preference (Requirement 6.4)", () => {
  it("forces non-streaming when Accept prefers JSON and not SSE", () => {
    expect(computeStreamFromAccept({
      bodyStream: undefined,
      acceptHeader: "application/json",
      provider: "claude",
    })).toBe(false);
  });

  it("keeps streaming when Accept includes text/event-stream", () => {
    expect(computeStreamFromAccept({
      bodyStream: undefined,
      acceptHeader: "application/json, text/event-stream",
      provider: "claude",
    })).toBe(true);
  });

  it("does not override when client explicitly sets stream=true", () => {
    expect(computeStreamFromAccept({
      bodyStream: true,
      acceptHeader: "application/json",
      provider: "claude",
    })).toBe(true);
  });

  it("forces non-streaming for always-streaming providers when Accept prefers JSON", () => {
    // Accept header runs after providerRequiresStreaming and can force assembly path
    expect(computeStreamFromAccept({
      bodyStream: undefined,
      acceptHeader: "application/json",
      provider: "openai",
    })).toBe(false);
  });

  it("defaults to streaming for claude when no Accept header", () => {
    expect(computeStreamFromAccept({
      bodyStream: undefined,
      acceptHeader: "",
      provider: "claude",
    })).toBe(true);
  });
});

describe("client disconnect → abort upstream (Requirement 6.5)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("createStreamController aborts signal after client disconnect", () => {
    const onDisconnect = vi.fn();
    const controller = createStreamController({ onDisconnect, provider: "claude", model: "test" });

    expect(controller.signal.aborted).toBe(false);
    controller.handleDisconnect("client_closed");
    expect(onDisconnect).toHaveBeenCalledWith(expect.objectContaining({ reason: "client_closed" }));

    vi.advanceTimersByTime(500);
    expect(controller.signal.aborted).toBe(true);
  });

  it("pipeWithDisconnect propagates cancel to stream controller", async () => {
    const controller = createStreamController({ provider: "openai", model: "gpt-4" });
    const encoder = new TextEncoder();
    const providerResponse = {
      body: new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(encoder.encode('data: {"x":1}\n\n'));
        },
      }),
    };
    const transform = new TransformStream({
      transform(chunk, ctrl) { ctrl.enqueue(chunk); },
    });

    const readable = pipeWithDisconnect(providerResponse, transform, controller);
    const reader = readable.getReader();
    await reader.read();
    await reader.cancel("client_gone");

    vi.advanceTimersByTime(500);
    expect(controller.signal.aborted).toBe(true);
  });

  it("marks controller disconnected on handleComplete", () => {
    const controller = createStreamController({ provider: "claude", model: "test" });
    expect(controller.isConnected()).toBe(true);
    controller.handleComplete();
    expect(controller.isConnected()).toBe(false);
  });
});
