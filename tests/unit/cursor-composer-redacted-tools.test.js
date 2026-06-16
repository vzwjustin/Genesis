import { describe, it, expect } from "vitest";

import { CursorExecutor } from "../../open-sse/executors/cursor.js";
import { encodeField, wrapConnectRPCFrame } from "../../open-sse/utils/cursorProtobuf.js";
import {
  RedactedToolContentProcessor,
  ComposerToolActivityLineProcessor,
  stripComposerFinalPrefix,
  stripComposerToolActivity,
  extractComposerThinkingAnswer,
  sanitizeComposerVisibleText,
} from "../../open-sse/utils/composerRedactedTools.js";

const LEN = 2;

function cursorResponseFrame({ text = "", thinking = "" }) {
  const responseFields = [];

  if (text) {
    responseFields.push(encodeField(1, LEN, text));
  }

  if (thinking) {
    const thinkingMessage = encodeField(1, LEN, thinking);
    responseFields.push(encodeField(25, LEN, thinkingMessage));
  }

  const response = Buffer.concat(responseFields.map((field) => Buffer.from(field)));
  const envelope = encodeField(2, LEN, response);
  return Buffer.from(wrapConnectRPCFrame(envelope));
}

function parseSSE(text) {
  return text
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => chunk.slice("data: ".length))
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data));
}

const TOOL_BLOCK =
  "<｜tool▁calls▁begin｜><｜tool▁call▁begin｜> codegraph_status " +
  "<｜tool▁sep｜>query auth routing <｜tool▁call▁end｜>" +
  "<｜tool▁calls▁end｜>";

describe("open-sse composer redacted tools", () => {
  it("strips fullwidth final prefix", () => {
    expect(stripComposerFinalPrefix("<\uFF5Cfinal\uFF5C>hi")).toBe("hi");
    expect(stripComposerFinalPrefix("<|final|>hi — need something?")).toBe("hi — need something?");
    expect(stripComposerFinalPrefix("<|finalbase audit")).toBe("base audit");
  });

  it("strips Composer tool-activity trace lines", () => {
    const raw = [
      "Audit →map arch. Exploring repo.",
      "✱Glob \"\"",
      "✱Grep \"requireApiKey\" (100 matches)",
      "→Read  [path=/Users/justinadams/Downloads/9router-fork/package.json]",
      "→Read package.json",
    ].join("\n");
    expect(stripComposerToolActivity(raw)).toBe("Audit →map arch. Exploring repo.");
  });

  it("extractComposerThinkingAnswer emits only post-final text", () => {
    const thinking = [
      "hidden</think>Audit →map arch. Exploring repo.",
      "✱Glob \"\"",
      "✱Grep \"requireApiKey\" (100 matches)",
      "→Read  [path=/Users/justinadams/Downloads/9router-fork/package.json]",
      "<|final|>base audit — genesis fork",
      "### What it is",
      "Local AI proxy.",
    ].join("\n");
    const answer = extractComposerThinkingAnswer(thinking);
    expect(answer).toContain("base audit — genesis fork");
    expect(answer).toContain("### What it is");
    expect(answer).not.toContain("Glob");
    expect(answer).not.toContain("→Read");
    expect(answer).not.toContain("requireApiKey");
  });

  it("holds back pre-final thinking while streaming", () => {
    const thinking = "hidden</think>✱Glob \"\"\n→Read package.json\n";
    expect(extractComposerThinkingAnswer(thinking)).toBe("");
    expect(extractComposerThinkingAnswer(thinking, { allowPreFinalFallback: true })).toBe("");
  });

  it("buffers markers split across chunks", () => {
    const proc = new RedactedToolContentProcessor();
    const a = proc.processChunk("<｜tool▁calls▁begin｜><｜tool▁call▁begin｜> list_dir ");
    expect(a.text).toBe("");
    expect(a.toolCalls).toHaveLength(0);

    const b = proc.processChunk("<｜tool▁sep｜>path src <｜tool▁call▁end｜><｜tool▁calls▁end｜>");
    expect(b.text).toBe("");
    expect(b.toolCalls).toHaveLength(1);
    expect(b.toolCalls[0].name).toBe("list_dir");
  });

  it("buffers tool-activity lines split across streaming chunks", () => {
    const proc = new ComposerToolActivityLineProcessor();
    expect(proc.processChunk("hello\n→Re")).toBe("hello");
    expect(proc.processChunk("ad package.json\nworld")).toBe("");
    expect(proc.flush()).toBe("world");
  });
});

describe("CursorExecutor — Composer redacted tool tokens (OpenCode path)", () => {
  it("converts redacted tool tokens to tool_calls in non-streaming JSON", async () => {
    const executor = new CursorExecutor();
    const buffer = cursorResponseFrame({
      text: `Before. ${TOOL_BLOCK}`,
    });

    const response = executor.transformProtobufToJSON(buffer, "cu/composer-2.5", {
      messages: [{ role: "user", content: "audit" }],
    });
    const payload = await response.json();
    const message = payload.choices[0].message;

    expect(message.content).toBe("Before.");
    expect(message.tool_calls).toHaveLength(1);
    expect(message.tool_calls[0].function.name).toBe("codegraph_status");
    expect(JSON.parse(message.tool_calls[0].function.arguments)).toEqual({ query: "auth routing" });
    expect(JSON.stringify(payload)).not.toContain("redacted_tool");
    expect(payload.choices[0].finish_reason).toBe("tool_calls");
  });

  it("converts redacted tools split across protobuf frames in SSE", async () => {
    const executor = new CursorExecutor();
    const buffer = Buffer.concat([
      cursorResponseFrame({ text: "Hi. <｜tool▁calls▁begin｜><｜tool▁call▁begin｜> list_dir <｜tool▁sep｜>path " }),
      cursorResponseFrame({ text: "src <｜tool▁call▁end｜><｜tool▁calls▁end｜>" }),
    ]);

    const response = executor.transformProtobufToSSE(buffer, "cu/composer-2.5", {
      messages: [{ role: "user", content: "list" }],
    });
    const events = parseSSE(await response.text());
    const content = events.map((e) => e.choices?.[0]?.delta?.content || "").join("");
    const toolEvents = events.flatMap((e) => e.choices?.[0]?.delta?.tool_calls || []);

    expect(content.trim()).toBe("Hi.");
    expect(JSON.stringify(events)).not.toContain("redacted_tool");
    expect(toolEvents.some((tc) => tc.function?.name === "list_dir")).toBe(true);
    expect(events.at(-1).choices[0].finish_reason).toBe("tool_calls");
  });

  it("strips final prefix from Composer thinking visible content", async () => {
    const executor = new CursorExecutor();
    const buffer = cursorResponseFrame({
      thinking: "hidden</think><\uFF5Cfinal\uFF5C>hi — need something?",
    });

    const response = executor.transformProtobufToJSON(buffer, "cu/composer-2.5", {
      messages: [{ role: "user", content: "hi" }],
    });
    const payload = await response.json();

    expect(payload.choices[0].message.content).toBe("hi — need something?");
    expect(JSON.stringify(payload)).not.toContain("final");
  });

  it("converts Kimi redacted tools in thinking stream split across SSE frames", async () => {
    const executor = new CursorExecutor();
    const kimiBlockStart =
      "hidden</think><|final|>Checking. <｜tool▁calls▁begin｜>" +
      "<|tool_call_begin|> codegraph_status <|tool_sep|>query ";
    const kimiBlockEnd = "auth <|tool_call_end|><｜tool▁calls▁end｜>";
    const buffer = Buffer.concat([
      cursorResponseFrame({ thinking: kimiBlockStart }),
      cursorResponseFrame({ thinking: kimiBlockEnd }),
    ]);

    const response = executor.transformProtobufToSSE(buffer, "cu/composer-2.5", {
      messages: [{ role: "user", content: "trace" }],
    });
    const events = parseSSE(await response.text());
    const content = events.map((e) => e.choices?.[0]?.delta?.content || "").join("");
    const toolEvents = events.flatMap((e) => e.choices?.[0]?.delta?.tool_calls || []);

    expect(content.trim()).toBe("Checking.");
    expect(JSON.stringify(events)).not.toContain("redacted_tool");
    expect(JSON.stringify(events)).not.toContain("tool_sep");
    expect(toolEvents.some((tc) => tc.function?.name === "codegraph_status")).toBe(true);
    expect(events.at(-1).choices[0].finish_reason).toBe("tool_calls");
  });

  it("converts Kimi redacted tools in thinking stream for non-streaming JSON", async () => {
    const executor = new CursorExecutor();
    const thinking =
      "hidden</think><|final|>Audit. <｜tool▁calls▁begin｜>" +
      "<|tool_call_begin|> codegraph_status <|tool_sep|>query routing " +
      "<|tool_call_end|><｜tool▁calls▁end｜>";
    const buffer = cursorResponseFrame({ thinking });

    const response = executor.transformProtobufToJSON(buffer, "cu/composer-2.5", {
      messages: [{ role: "user", content: "audit" }],
    });
    const payload = await response.json();
    const message = payload.choices[0].message;

    expect(message.content).toBe("Audit.");
    expect(message.tool_calls).toHaveLength(1);
    expect(message.tool_calls[0].function.name).toBe("codegraph_status");
    expect(JSON.parse(message.tool_calls[0].function.arguments)).toEqual({ query: "routing" });
    expect(JSON.stringify(payload)).not.toContain("redacted_tool");
    expect(payload.choices[0].finish_reason).toBe("tool_calls");
  });

  it("strips tool traces and partial final prefix in JSON audit-style thinking", async () => {
    const executor = new CursorExecutor();
    const thinking = [
      "hidden</think>Audit →map arch. Exploring repo.",
      "✱Glob \"\"",
      "✱Grep \"requireApiKey|Authorization\" (100 matches)",
      "→Read  [path=/Users/justinadams/Downloads/9router-fork/package.json]",
      "<|finalbase audit — genesis fork (9router)",
      "### What it is",
      "Local AI proxy.",
    ].join("\n");
    const buffer = cursorResponseFrame({ thinking });

    const response = executor.transformProtobufToJSON(buffer, "cu/composer-2.5", {
      messages: [{ role: "user", content: "audit" }],
    });
    const payload = await response.json();
    const message = payload.choices[0].message;

    expect(message.content).toContain("base audit — genesis fork");
    expect(message.content).toContain("### What it is");
    expect(message.content).not.toContain("Glob");
    expect(message.content).not.toContain("→Read");
    expect(message.content).not.toContain("Audit →map");
    expect(JSON.stringify(payload)).not.toContain("redacted_tool");
  });
});
