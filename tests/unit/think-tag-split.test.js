/**
 * #10 — <think> tag split across stream chunks must still be detected.
 * A tag straddling two deltas ("<thi" + "nk>") was previously missed, leaking
 * reasoning into message text. The fix carries a trailing partial tag forward.
 */
import { describe, it, expect } from "vitest";
import { trailingPartialTagLen } from "../../open-sse/utils/thinkTag.js";
import { createResponsesApiTransformStream } from "../../open-sse/transformer/responsesTransformer.js";
import { openaiToOpenAIResponsesResponse } from "../../open-sse/translator/response/openai-responses.js";

describe("trailingPartialTagLen", () => {
  it("detects a partial open tag at the end", () => {
    expect(trailingPartialTagLen("hello <thi")).toBe(4); // "<thi"
    expect(trailingPartialTagLen("hello <")).toBe(1);
  });
  it("detects a partial close tag at the end", () => {
    expect(trailingPartialTagLen("done</thin")).toBe(6); // "</thin"
  });
  it("returns 0 when no trailing partial tag", () => {
    expect(trailingPartialTagLen("plain text")).toBe(0);
    expect(trailingPartialTagLen("a < b")).toBe(0);
    expect(trailingPartialTagLen("")).toBe(0);
  });
  it("does not hold back a complete tag", () => {
    // A full "<think>" is not a *partial* — includes() handles it directly.
    expect(trailingPartialTagLen("x<think>")).toBe(0);
  });
});

function chatChunk(content, finish = null) {
  return {
    id: "cmpl-1",
    choices: [{ index: 0, delta: content == null ? {} : { content }, finish_reason: finish }],
  };
}

async function runResponses(deltas) {
  const stream = createResponsesApiTransformStream(null);
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const out = [];
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.push(dec.decode(value));
    }
  })();
  for (const d of deltas) {
    await writer.write(enc.encode(`data: ${JSON.stringify(d)}\n\n`));
  }
  await writer.close();
  await pump;
  return out.join("");
}

describe("responsesTransformer think-tag split", () => {
  it("routes reasoning to reasoning events even when <think> is split", async () => {
    const sse = await runResponses([
      chatChunk("<thi"),
      chatChunk("nk>secret reasoning</thi"),
      chatChunk("nk>visible answer"),
      chatChunk(null, "stop"),
    ]);
    expect(sse).toContain("reasoning_summary_text.delta");
    expect(sse).toContain("secret reasoning");
    // The reasoning text must NOT appear inside an output_text delta.
    const textDeltas = sse
      .split("\n")
      .filter((l) => l.includes("output_text.delta"))
      .join("");
    expect(textDeltas).not.toContain("secret reasoning");
    expect(textDeltas).toContain("visible answer");
    // The split tag itself must never leak as literal text.
    expect(sse).not.toMatch(/output_text[^]*?<think>/);
  });

  it("emits a held-back fragment as text when no tag ever completes", async () => {
    const sse = await runResponses([
      chatChunk("answer ending in <"),
      chatChunk(null, "stop"),
    ]);
    // The "<" was held back, then flushed as real text at finish.
    const textDeltas = sse
      .split("\n")
      .filter((l) => l.includes("output_text"))
      .join("");
    expect(textDeltas).toContain("answer ending in <");
  });
});

function responsesState() {
  return {
    seq: 0,
    responseId: "resp_test",
    created: 0,
    started: false,
    msgTextBuf: {},
    msgItemAdded: {},
    msgContentAdded: {},
    msgItemDone: {},
    reasoningId: "",
    reasoningIndex: -1,
    reasoningBuf: "",
    reasoningDone: false,
    inThinking: false,
    funcArgsBuf: {},
    funcNames: {},
    funcCallIds: {},
    funcItemDone: {},
    completedSent: false,
  };
}

describe("openai-responses translator think-tag split", () => {
  it("keeps split-tag reasoning out of message text", () => {
    const state = responsesState();
    const all = [];
    for (const d of [
      chatChunk("<thi"),
      chatChunk("nk>thinking</thi"),
      chatChunk("nk>hello"),
      chatChunk(null, "stop"),
    ]) {
      all.push(...openaiToOpenAIResponsesResponse(d, state));
    }
    const json = JSON.stringify(all);
    expect(json).toContain("reasoning_summary_text.delta");
    expect(json).toContain("thinking");
    const textEvents = all.filter((e) => e.event === "response.output_text.delta");
    const textJoined = textEvents.map((e) => e.data.delta).join("");
    expect(textJoined).not.toContain("thinking");
    expect(textJoined).toContain("hello");
  });

  it("uses allocated reasoning output_index on added events after a tool call", () => {
    const state = responsesState();
    const all = [];
    all.push(...openaiToOpenAIResponsesResponse({
      id: "cmpl-1",
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "lookup", arguments: "" },
          }],
        },
      }],
    }, state));
    all.push(...openaiToOpenAIResponsesResponse({
      id: "cmpl-1",
      choices: [{ index: 0, delta: { reasoning_content: "reasoning bit" } }],
    }, state));

    const toolAdded = all.find((e) =>
      e.event === "response.output_item.added" && e.data.item?.type === "function_call");
    const reasoningAdded = all.find((e) =>
      e.event === "response.output_item.added" && e.data.item?.type === "reasoning");
    const reasoningDelta = all.find((e) => e.event === "response.reasoning_summary_text.delta");

    expect(toolAdded?.data.output_index).toBe(0);
    expect(reasoningAdded?.data.output_index).toBe(1);
    expect(reasoningDelta?.data.output_index).toBe(1);
    expect(reasoningAdded?.data.output_index).not.toBe(0);
  });

  it("strips every <think> in a delta, not just the first (no literal leak)", () => {
    // A single delta carrying two opening tags: the non-global replace() used
    // to strip only the first, leaking a literal "<think>" into output text.
    const state = responsesState();
    const all = [];
    for (const d of [
      chatChunk("<think>a<think>b</think>visible"),
      chatChunk(null, "stop"),
    ]) {
      all.push(...openaiToOpenAIResponsesResponse(d, state));
    }
    const reasoning = all
      .filter((e) => e.event === "response.reasoning_summary_text.delta")
      .map((e) => e.data.delta)
      .join("");
    const text = all
      .filter((e) => e.event === "response.output_text.delta")
      .map((e) => e.data.delta)
      .join("");
    // No literal tag survives anywhere; reasoning captured, visible text clean.
    expect(reasoning).not.toContain("<think>");
    expect(text).not.toContain("<think>");
    expect(text).toContain("visible");
  });
});
