/**
 * Wave 6 — platform / security-adjacent fixes
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixToolUseOrdering } from "../../open-sse/translator/helpers/claudeHelper.js";
import {
  snapshotCacheProtectedBody,
  verifyCacheProtectedBody,
} from "../../open-sse/rtk/cacheBoundary.js";
import { injectCaveman } from "../../open-sse/rtk/caveman.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { initState } from "../../open-sse/translator/index.js";
import { createResponsesApiTransformStream } from "../../open-sse/transformer/responsesTransformer.js";

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
  const out = await collectStreamText(input.pipeThrough(createResponsesApiTransformStream()));
  return out;
}

describe("wave6 — MITM sudo env file", () => {
  it("loads ROUTER_API_KEY from env file instead of embedding in sh -c", () => {
    const src = read("src/mitm/manager.js");
    expect(src).toContain(".mitm-server.env");
    expect(src).toContain("set -a && .");
    expect(src).not.toMatch(/ROUTER_API_KEY=\$\{shellQuoteSingle\(apiKey\)\}/);
  });
});

describe("wave6 — fixToolUseOrdering cacheFloor original index", () => {
  it("does not merge past cache floor but merges tail messages after it", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "m0" }] },
      { role: "user", content: [{ type: "text", text: "m1" }] },
      { role: "user", content: [{ type: "text", text: "m2" }], cache_control: { type: "ephemeral" } },
      { role: "user", content: [{ type: "text", text: "m3" }] },
      { role: "user", content: [{ type: "text", text: "m4" }] },
    ];
    const out = fixToolUseOrdering(messages);
    expect(out).toHaveLength(4);
    expect(out[0].content[0].text).toBe("m0");
    expect(out[1].content[0].text).toBe("m1");
    expect(out[2].content[0].text).toBe("m2");
    expect(out[3].content.map((b) => b.text)).toEqual(["m3", "m4"]);
  });
});

describe("wave6 — verifyProtectedArray append detection", () => {
  it("allows when protected array grows past snapshot length (dynamic appends permitted)", () => {
    const body = {
      messages: [
        { role: "user", content: "a", cache_control: { type: "ephemeral" } },
        { role: "user", content: "b" },
      ],
    };
    const snapshot = snapshotCacheProtectedBody(body);
    body.messages.push({ role: "user", content: "injected" });
    expect(verifyCacheProtectedBody(body, snapshot)).toBe(true);
  });
});

describe("wave6 — responsesTransformer finish_reason + tool start", () => {
  it("defers empty-arg tool close to flush when finish_reason shares the chunk", async () => {
    const sse = [
      'data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
      'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"lookup","arguments":""}}]},"finish_reason":"tool_calls"}]}',
      "",
    ].join("\n\n");

    const out = await pipeSse(sse);
    const argDoneBlocks = out.split("\n\n").filter((block) =>
      block.includes("event: response.function_call_arguments.done")
    );
    expect(argDoneBlocks).toHaveLength(1);
    expect(out).toContain("response.completed");
    const dataLine = argDoneBlocks[0].split("\n").find((l) => l.startsWith("data:"));
    const donePayload = JSON.parse(dataLine.slice(5).trim());
    expect(donePayload.arguments).toBe("{}");
  });

  it("closes tool immediately when arguments arrived in the same chunk", async () => {
    const sse = [
      'data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
      'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_xyz","type":"function","function":{"name":"run","arguments":"{\\"q\\":1}"}}]},"finish_reason":"tool_calls"}]}',
      "",
    ].join("\n\n");

    const out = await pipeSse(sse);
    expect(out).toContain('"arguments":"{\\"q\\":1}"');
  });
});

describe("wave6 — caveman string system provider gate", () => {
  it("keeps string system for provider claude", () => {
    const body = { system: "You are helpful.", messages: [{ role: "user", content: "hi" }] };
    injectCaveman(body, FORMATS.CLAUDE, "lite", "claude");
    expect(typeof body.system).toBe("string");
    expect(body.system).toContain("You are helpful.");
  });

  it("converts string system to array for non-claude Claude-format providers", () => {
    const body = { system: "Compat endpoint.", messages: [{ role: "user", content: "hi" }] };
    injectCaveman(body, FORMATS.CLAUDE, "lite", "minimax");
    expect(Array.isArray(body.system)).toBe(true);
    expect(body.system[0].text).toBe("Compat endpoint.");
    expect(body.system[1].text).toMatch(/Respond tersely|caveman/i);
  });
});

describe("wave6 — initState toolCallIndex", () => {
  it("initializes toolCallIndex in base streaming state", () => {
    const state = initState(FORMATS.CLAUDE);
    expect(state.toolCallIndex).toBe(0);
  });
});
