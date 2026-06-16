/**
 * Wave 6 round 2 — platform audit follow-ups
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createResponsesApiTransformStream } from "../../open-sse/transformer/responsesTransformer.js";
import { parseSSEToOpenAIResponse } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";

const root = dirname(fileURLToPath(import.meta.url));

function read(relPath) {
  return readFileSync(join(root, "..", "..", relPath), "utf8");
}

async function collectStreamText(readable) {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

async function pipeSse(sse) {
  const input = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sse));
      controller.close();
    },
  });
  return collectStreamText(input.pipeThrough(createResponsesApiTransformStream()));
}

function parseResponseEvents(out) {
  return out
    .trim()
    .split("\n\n")
    .filter(Boolean)
    .map((block) => block.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim())
    .filter((data) => data && data !== "[DONE]")
    .map((data) => JSON.parse(data));
}

describe("wave6-r2 — responsesTransformer event ordering", () => {
  it("emits function_call_arguments.done before response.completed", async () => {
    const sse = [
      'data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
      'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"lookup","arguments":""}}]},"finish_reason":"tool_calls"}]}',
      "",
    ].join("\n\n");

    const out = await pipeSse(sse);
    const argDoneIdx = out.indexOf("event: response.function_call_arguments.done");
    const completedIdx = out.indexOf("event: response.completed");
    expect(argDoneIdx).toBeGreaterThan(-1);
    expect(completedIdx).toBeGreaterThan(-1);
    expect(argDoneIdx).toBeLessThan(completedIdx);
  });

  it("keeps allocated output_index consistent across item added/delta/done events", async () => {
    const sse = [
      'data: {"id":"c1","choices":[{"index":0,"delta":{"reasoning_content":"why"},"finish_reason":null}]}',
      'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"answer"},"finish_reason":null}]}',
      'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"lookup","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}',
      "",
    ].join("\n\n");

    const events = parseResponseEvents(await pipeSse(sse));
    const byType = (type) => events.filter((e) => e.type === type);
    const itemIndex = (itemType) => byType("response.output_item.added")
      .find((e) => e.item?.type === itemType)?.output_index;

    const reasoningIndex = itemIndex("reasoning");
    const messageIndex = itemIndex("message");
    const toolIndex = itemIndex("function_call");

    expect(new Set([reasoningIndex, messageIndex, toolIndex]).size).toBe(3);
    for (const event of events.filter((e) => e.item_id === "msg_resp_c1_0" || e.item?.id === "msg_resp_c1_0")) {
      expect(event.output_index).toBe(messageIndex);
    }
    for (const event of events.filter((e) => e.item_id === "fc_call_abc" || e.item?.id === "fc_call_abc")) {
      expect(event.output_index).toBe(toolIndex);
    }
    for (const event of events.filter((e) => e.item_id === "rs_resp_c1_0" || e.item?.id === "rs_resp_c1_0")) {
      expect(event.output_index).toBe(reasoningIndex);
    }
  });
});

describe("wave6-r2 — MITM runtime file cleanup", () => {
  it("defines cleanupMitmRuntimeFiles for PID and env file", () => {
    const src = read("src/mitm/manager.js");
    expect(src).toContain("function cleanupMitmRuntimeFiles()");
    expect(src).toContain("MITM_SERVER_ENV_FILE");
    expect(src).toMatch(/cleanupMitmRuntimeFiles\(\)/);
  });

  it("guards exit-handler restart with _startingPromise", () => {
    const src = read("src/mitm/manager.js");
    expect(src).toMatch(/!_startingPromise\)/);
  });
});

describe("wave6-r2 — sseToJsonHandler tool name resend", () => {
  it("does not duplicate tool name when provider resends full name", () => {
    const chunks = [
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"look","arguments":""}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"lookup","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const result = parseSSEToOpenAIResponse(chunks, "gpt-4");
    expect(result?.choices?.[0]?.message?.tool_calls?.[0]?.function?.name).toBe("lookup");
  });
});
