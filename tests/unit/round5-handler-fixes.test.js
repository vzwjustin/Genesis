/**
 * Round 5 cross-cutting chat/handler fixes.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { detectClientTool } from "../../open-sse/utils/clientDetector.js";
import { transformToOllama } from "../../open-sse/utils/ollamaTransform.js";
import { injectCaveman } from "../../open-sse/rtk/caveman.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { getImageAdapter } from "../../open-sse/handlers/imageProviders/index.js";

const root = dirname(fileURLToPath(import.meta.url));
const handlersRoot = join(root, "../../src/sse/handlers");

function readHandler(name) {
  return readFileSync(join(handlersRoot, name), "utf8");
}

describe("chat.js — no-auth bypasses retry loop", () => {
  const src = readHandler("chat.js");

  it("checks resolvedProvider.noAuth before credential retry loop", () => {
    expect(src).toContain("resolvedProvider?.noAuth");
    expect(src).toContain("dispatchChatCore");
    const noAuthIdx = src.indexOf("resolvedProvider?.noAuth");
    const whileIdx = src.indexOf("while (true)");
    expect(noAuthIdx).toBeGreaterThan(-1);
    expect(whileIdx).toBeGreaterThan(noAuthIdx);
  });

  it("dispatches handleChatCore with null credentials for no-auth", () => {
    expect(src).toMatch(/credentials:\s*null/);
    expect(src).toContain("no-auth mode");
  });
});

describe("chatCore.js — validation and executor error logging", () => {
  const src = readFileSync(join(root, "../../open-sse/handlers/chatCore.js"), "utf8");

  it("does not trackPendingRequest on post-translation validation failure", () => {
    const validationBlock = src.slice(
      src.indexOf("Translation produced invalid output"),
      src.indexOf("Translation produced invalid output") + 200
    );
    expect(validationBlock).not.toContain("trackPendingRequest");
  });

  it("logs executor.execute errors via reqLogger.logError", () => {
    const catchBlock = src.slice(src.indexOf("} catch (error) {"), src.indexOf("} catch (error) {") + 400);
    expect(catchBlock).toContain("reqLogger.logError(error");
  });

  it("skips caveman when client cache breakpoints are present", () => {
    expect(src).toContain("!clientHasCacheBreakpoints");
    expect(src).toContain("snapshotCacheProtectedBody");
    expect(src).toContain("verifyCacheProtectedBody");
  });
});

describe("caveman.js — Gemini system key selection", () => {
  it("prefers populated systemInstruction over empty system_instruction", () => {
    const body = {
      system_instruction: { parts: [] },
      systemInstruction: { parts: [{ text: "existing prompt" }] },
    };
    injectCaveman(body, FORMATS.GEMINI, "full");
    expect(body.systemInstruction.parts).toHaveLength(2);
    expect(body.systemInstruction.parts[1].text).toContain("caveman");
    expect(body.system_instruction.parts).toHaveLength(0);
  });

  it("prefers populated system_instruction over empty systemInstruction", () => {
    const body = {
      system_instruction: { parts: [{ text: "snake prompt" }] },
      systemInstruction: { parts: [] },
    };
    injectCaveman(body, FORMATS.GEMINI, "full");
    expect(body.system_instruction.parts).toHaveLength(2);
    expect(body.systemInstruction.parts).toHaveLength(0);
  });
});

describe("clientDetector — x-app cli corroboration", () => {
  it("does not classify x-app: cli alone as claude", () => {
    expect(detectClientTool({ "x-app": "cli" }, {})).toBeNull();
  });

  it("classifies x-app: cli with claude user-agent", () => {
    expect(detectClientTool({
      "x-app": "cli",
      "user-agent": "claude-code/1.0",
    }, {})).toBe("claude");
  });

  it("classifies x-app: cli with anthropic user-agent", () => {
    expect(detectClientTool({
      "x-app": "cli",
      "user-agent": "anthropic-sdk/0.1",
    }, {})).toBe("claude");
  });
});

describe("ollamaTransform — status preservation and error passthrough", () => {
  it("returns error responses unchanged", () => {
    const err = new Response(JSON.stringify({ error: "bad" }), { status: 400 });
    expect(transformToOllama(err, "llama3.2")).toBe(err);
  });

  it("preserves status on successful transform", () => {
    const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n';
    const upstream = new Response(sse, { status: 200 });
    const out = transformToOllama(upstream, "llama3.2");
    expect(out.status).toBe(200);
    expect(out.headers.get("Content-Type")).toBe("application/x-ndjson");
  });
});

describe("imageGeneration.js — no-auth from adapter config", () => {
  const src = readHandler("imageGeneration.js");

  it("uses getImageAdapter noAuth instead of hardcoded provider set", () => {
    expect(src).toContain("getImageAdapter(provider)?.noAuth");
    expect(src).not.toContain("NO_AUTH_PROVIDERS");
  });

  it("nested combo re-expansion when provider is null", () => {
    const fn = src.slice(src.indexOf("async function handleSingleModelImage"));
    expect(fn).toContain("getComboModels(modelStr)");
    expect(fn).toContain("handleComboChat({");
  });

  it("sdwebui declares noAuth and incomplete comfyui is not registered", () => {
    expect(getImageAdapter("sdwebui")?.noAuth).toBe(true);
    expect(getImageAdapter("comfyui")).toBeNull();
  });
});
