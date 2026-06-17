/**
 * Round-2 v1beta route fixes: path parsing, 400 errors, tool_calls mapping.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");

const mockHandleChat = vi.fn();

vi.mock("@/sse/handlers/chat.js", () => ({
  handleChat: (...args) => mockHandleChat(...args),
}));

vi.mock("open-sse/utils/clientDetector.js", () => ({
  detectClientTool: () => null,
  isNativePassthrough: () => false,
  shouldUseNativePassthrough: () => false,
}));

function geminiRequest(pathSegments, body, { invalidJson = false } = {}) {
  const url = `http://localhost/api/v1beta/models/${pathSegments.join("/")}`;
  const init = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: invalidJson ? "{not-json" : JSON.stringify(body),
  };
  return new Request(url, init);
}

function minimalGeminiBody() {
  return {
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
  };
}

async function readSseBody(response) {
  const text = await response.text();
  return text
    .split(/\r?\n\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
}

describe("v1beta route — round-2 fixes", () => {
  let POST;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    await import("../../open-sse/translator/request/gemini-to-openai.js");
    ({ POST } = await import("../../src/app/api/v1beta/models/[...path]/route.js"));
  });

  it("returns 400 for invalid JSON body", async () => {
    const response = await POST(
      geminiRequest(["gemini-pro:generateContent"], {}, { invalidJson: true }),
      { params: Promise.resolve({ path: ["gemini-pro:generateContent"] }) }
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.message).toContain("Invalid JSON");
  });

  it("joins 3+ path segments with last segment as action", async () => {
    mockHandleChat.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          model: "provider/sub/model",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const response = await POST(
      geminiRequest(["provider", "subdir", "model:generateContent"], minimalGeminiBody()),
      { params: Promise.resolve({ path: ["provider", "subdir", "model:generateContent"] }) }
    );

    expect(response.status).toBe(200);
    expect(mockHandleChat).toHaveBeenCalled();
    const forwarded = JSON.parse(await mockHandleChat.mock.calls[0][0].text());
    expect(forwarded.model).toBe("provider/subdir/model");
    expect(forwarded.stream).toBe(false);
  });

  it("maps non-streaming tool_calls to Gemini functionCall parts", async () => {
    mockHandleChat.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "get_weather", arguments: '{"city":"NYC"}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          model: "gpt-4",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const response = await POST(
      geminiRequest(["gemini/gemini-2.0:generateContent"], minimalGeminiBody()),
      { params: Promise.resolve({ path: ["gemini", "gemini-2.0:generateContent"] }) }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    const parts = body.candidates[0].content.parts;
    const fnPart = parts.find((p) => p.functionCall);
    expect(fnPart.functionCall.name).toBe("get_weather");
    expect(fnPart.functionCall.args).toEqual({ city: "NYC" });
  });

  it("maps streaming tool_calls deltas to Gemini functionCall on finish", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","function":{"name":"lookup","arguments":""}}]},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"q\\":\\"x\\"}"}}]},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}',
      "data: [DONE]",
    ].join("\n\n") + "\n\n";

    const encoder = new TextEncoder();
    mockHandleChat.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(sse));
            controller.close();
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }
      )
    );

    const response = await POST(
      geminiRequest(["gemini/gemini-2.0:streamGenerateContent"], minimalGeminiBody()),
      { params: Promise.resolve({ path: ["gemini", "gemini-2.0:streamGenerateContent"] }) }
    );

    expect(response.status).toBe(200);
    const chunks = await readSseBody(response);
    const finishChunk = chunks.find((c) => c.candidates?.[0]?.finishReason);
    expect(finishChunk).toBeTruthy();
    const fnPart = finishChunk.candidates[0].content.parts.find((p) => p.functionCall);
    expect(fnPart.functionCall.name).toBe("lookup");
    expect(fnPart.functionCall.args).toEqual({ q: "x" });
  }, 10000);

  it("buffers OpenAI SSE data lines split across network chunks", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hel',
      'lo"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n',
      "data: [DONE]\n\n",
    ];

    mockHandleChat.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }
      )
    );

    const response = await POST(
      geminiRequest(["gemini/gemini-2.0:streamGenerateContent"], minimalGeminiBody()),
      { params: Promise.resolve({ path: ["gemini", "gemini-2.0:streamGenerateContent"] }) }
    );

    expect(response.status).toBe(200);
    const body = await readSseBody(response);
    expect(body[0].candidates[0].content.parts[0].text).toBe("Hello");
    expect(body.find((c) => c.candidates?.[0]?.finishReason).usageMetadata.totalTokenCount).toBe(2);
  }, 10000);
});

describe("v1beta route source — round-2", () => {
  const src = readFileSync(
    join(root, "src/app/api/v1beta/models/[...path]/route.js"),
    "utf8"
  );

  it("uses last path segment for generateContent action", () => {
    expect(src).toContain("path[path.length - 1]");
    expect(src).toContain("path.slice(0, -1).join");
  });

  it("returns 400 for translation errors", () => {
    expect(src).toContain("TRANSLATION_INVALID_BODY");
    expect(src).toContain("Invalid JSON body");
    expect(src).toMatch(/geminiErrorResponse\(\s*400/);
  });

  it("accumulates streaming tool_calls before finish", () => {
    expect(src).toContain("toolCallAccum");
    expect(src).toContain("functionCall");
  });
});

describe("STT/TTS handlers — proactive token refresh", () => {
  it("stt.js checks token before handleSttCore and skips on refresh failure", () => {
    const src = readFileSync(join(root, "src/sse/handlers/stt.js"), "utf8");
    const loop = src.slice(src.indexOf("while (true)"));
    expect(loop).toContain("checkAndRefreshToken");
    expect(loop).toContain("_tokenRefreshFailed");
    expect(loop).toContain("credentials: refreshedCredentials");
    expect(loop.indexOf("checkAndRefreshToken")).toBeLessThan(loop.indexOf("handleSttCore({"));
  });

  it("tts.js checks token before handleTtsCore and skips on refresh failure", () => {
    const src = readFileSync(join(root, "src/sse/handlers/tts.js"), "utf8");
    const loop = src.slice(src.indexOf("while (true)"));
    expect(loop).toContain("checkAndRefreshToken");
    expect(loop).toContain("_tokenRefreshFailed");
    expect(loop).toContain("credentials: refreshedCredentials");
    expect(loop.indexOf("checkAndRefreshToken")).toBeLessThan(loop.indexOf("handleTtsCore({"));
  });
});
