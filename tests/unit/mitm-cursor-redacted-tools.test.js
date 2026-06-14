import { describe, it, expect } from "vitest";
import { pipeOpenAIasConnectRPC } from "../../src/mitm/handlers/cursor.js";
import * as protobuf from "../../open-sse/utils/cursorProtobuf.js";

// Build a fake fetch Response whose body streams the given SSE string.
function makeSseResponse(sse) {
  const bytes = new TextEncoder().encode(sse);
  let sent = false;
  return {
    headers: { get: (k) => (k.toLowerCase() === "content-type" ? "text/event-stream" : null) },
    body: {
      getReader: () => ({
        read: async () => {
          if (sent) return { done: true, value: undefined };
          sent = true;
          return { done: false, value: bytes };
        },
      }),
    },
  };
}

// Capture everything written to res and concatenate into one buffer.
function makeCaptureRes() {
  const chunks = [];
  return {
    chunks,
    write: (buf) => { chunks.push(Buffer.from(buf)); return true; },
    end: () => {},
    all: () => Buffer.concat(chunks),
  };
}

function sse(...objs) {
  return objs.map((o) => `data: ${JSON.stringify(o)}\n\n`).join("") + "data: [DONE]\n\n";
}

describe("cursor MITM — Composer redacted tool-call tokens", () => {
  // Regression: Composer streams tool calls as Unicode text tokens inside delta.content.
  // The raw markers must never leak into the rendered ConnectRPC text frames; they must be
  // converted into a tool-call frame instead.
  it("does not leak Unicode tool-call tokens and emits a tool-call frame", async () => {
    const leaked =
      "<｜tool▁calls▁begin｜><｜tool▁call▁begin｜> read_file " +
      "<｜tool▁sep｜>target_file app.js <｜tool▁call▁end｜>" +
      "<｜tool▁calls▁end｜>";
    const res = makeCaptureRes();
    const routerRes = makeSseResponse(sse(
      { choices: [{ delta: { content: "Reading the file. " } }] },
      { choices: [{ delta: { content: leaked } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ));

    await pipeOpenAIasConnectRPC(routerRes, res, protobuf);

    const out = res.all().toString("latin1");
    // No raw markers (Unicode or ASCII-normalized) survive into the output frames.
    expect(out).not.toContain("tool▁call");
    expect(out).not.toContain("tool_call_begin");
    expect(out).not.toContain("tool_calls_begin");
    // The clean prose text is preserved.
    expect(out).toContain("Reading the file.");
    // The tool name is emitted as a tool-call frame.
    expect(out).toContain("read_file");
    expect(out).toContain("target_file");
  });

  it("handles markers split across SSE chunks without leaking", async () => {
    const res = makeCaptureRes();
    const routerRes = makeSseResponse(sse(
      { choices: [{ delta: { content: "<｜tool▁calls▁begin｜><｜tool▁call▁begin｜> list_dir <｜tool▁sep｜>path " } }] },
      { choices: [{ delta: { content: "src <｜tool▁call▁end｜><｜tool▁calls▁end｜>" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ));

    await pipeOpenAIasConnectRPC(routerRes, res, protobuf);

    const out = res.all().toString("latin1");
    expect(out).not.toContain("tool▁call");
    expect(out).not.toContain("tool_call_begin");
    expect(out).toContain("list_dir");
  });

  it("still emits native delta.tool_calls unchanged", async () => {
    const res = makeCaptureRes();
    const routerRes = makeSseResponse(sse(
      { choices: [{ delta: { content: "ok" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "grep", arguments: "{\"q\":\"x\"}" } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ));

    await pipeOpenAIasConnectRPC(routerRes, res, protobuf);

    const out = res.all().toString("latin1");
    expect(out).toContain("grep");
    expect(out).toContain("ok");
  });
});
