import { describe, it, expect } from "vitest";
import { readCappedResponseText, MAX_SSE_BUFFER_CHARS } from "../../open-sse/utils/stream.js";
import { convertResponsesStreamToJson } from "../../open-sse/transformer/streamToJsonConverter.js";
import { rollbackStickyUseCount } from "../../src/sse/services/auth.js";

function sseStream(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe("readCappedResponseText", () => {
  it("returns text under the cap", async () => {
    const body = "data: hello\n\n";
    const response = new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    const text = await readCappedResponseText(response, 1024);
    expect(text).toBe(body);
  });

  it("returns null when body exceeds cap", async () => {
    const huge = "x".repeat(MAX_SSE_BUFFER_CHARS + 1);
    const response = new Response(huge);
    const text = await readCappedResponseText(response);
    expect(text).toBeNull();
  });
});

describe("convertResponsesStreamToJson buffer cap", () => {
  it("fails closed when SSE buffer exceeds MAX_SSE_BUFFER_CHARS", async () => {
    const oversized = `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "r1" } })}\n\n`;
    const padded = oversized + "x".repeat(MAX_SSE_BUFFER_CHARS);
    const result = await convertResponsesStreamToJson(sseStream(padded));
    expect(result.status).toBe("failed");
  });

  it("fails closed when total bytes read exceed cap across many small chunks", async () => {
    const event = 'event: response.output_item.done\ndata: {"output_index":0,"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"x"}]}}\n\n';
    const chunkSize = 256;
    const chunkText = event.slice(0, chunkSize);
    let emitted = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (emitted >= MAX_SSE_BUFFER_CHARS + chunkSize) {
          controller.close();
          return;
        }
        controller.enqueue(new TextEncoder().encode(chunkText));
        emitted += chunkText.length;
      },
    });

    const result = await convertResponsesStreamToJson(stream);
    expect(result.status).toBe("failed");
  });
});

describe("rollbackStickyUseCount", () => {
  it("is exported for failed/incomplete request paths", () => {
    expect(typeof rollbackStickyUseCount).toBe("function");
  });
});
