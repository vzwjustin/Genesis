import { describe, it, expect } from "vitest";
import {
  decodeCursorRequest,
  encodeTextResponseFrame,
  generateCursorBody,
  generateToolResultBody,
  wrapConnectRPCFrame,
} from "../../open-sse/utils/cursorProtobuf.js";

function buildChatRequestFrame(model, messages) {
  const body = generateCursorBody(messages, model, []);
  return Buffer.from(body);
}

describe("decodeCursorRequest", () => {
  it("extracts model and messages from a chat request", () => {
    const frame = buildChatRequestFrame("composer-2.5-fast", [
      { role: "user", content: "hello" },
    ]);
    const decoded = decodeCursorRequest(frame);
    expect(decoded.kind).toBe("chat");
    expect(decoded.model).toBe("composer-2.5-fast");
    expect(decoded.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("extracts system instruction from chat request", () => {
    const body = generateCursorBody(
      [{ role: "user", content: "hello" }],
      "composer-2.5-fast",
      [],
      null,
      false,
      "You are a helpful assistant.",
    );
    const decoded = decodeCursorRequest(Buffer.from(body));
    expect(decoded.instruction).toBe("You are a helpful assistant.");
  });

  it("flags tool-result-only frames for passthrough", () => {
    const frame = Buffer.from(generateToolResultBody({
      tool_call_id: "tc-1",
      tool_name: "read_file",
      result: "ok",
    }));
    expect(decodeCursorRequest(frame).kind).toBe("tool_result");
  });
});

describe("encodeTextResponseFrame", () => {
  it("wraps text in a ConnectRPC frame", () => {
    const frame = encodeTextResponseFrame("hi");
    expect(frame.length).toBeGreaterThan(5);
    expect(frame[0]).toBe(0);
  });
});

describe("cursor MITM model mapping", () => {
  it("maps composer models and falls back to composer-2.5-fast", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { createRequire } = await import("module");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mitm-cursor-"));
    fs.mkdirSync(path.join(tmpDir, "mitm"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "mitm", "aliases.json"),
      JSON.stringify({
        cursor: {
          "composer-2.5-fast": "cu/composer-2.5-fast",
          auto: "cu/auto",
        },
      }),
    );

    const originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = tmpDir;
    for (const mod of [
      "../../src/mitm/paths.js",
      "../../src/mitm/dbReader.js",
      "../../src/mitm/modelMapping.js",
    ]) {
      const require = createRequire(import.meta.url);
      delete require.cache[require.resolve(mod)];
    }

    const require = createRequire(import.meta.url);
    const { getMappedModel } = require("../../src/mitm/modelMapping.js");
    expect(getMappedModel("cursor", "composer-2.5-fast")).toBe("cu/composer-2.5-fast");
    expect(getMappedModel("cursor", "unknown-model-xyz")).toBe("cu/composer-2.5-fast");
    expect(getMappedModel("cursor", null)).toBe("cu/auto");

    process.env.DATA_DIR = originalDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("cursor MITM handler wiring", () => {
  it("registers api2.cursor.sh in host config", async () => {
    const { createRequire } = await import("module");
    const require = createRequire(import.meta.url);
    const { getToolForHost } = require("../../src/mitm/config.js");
    const { TOOL_HOSTS } = require("../../src/shared/constants/mitmToolHosts.js");

    expect(getToolForHost("api2.cursor.sh")).toBe("cursor");
    expect(TOOL_HOSTS.cursor).toContain("api2.cursor.sh");
  });
});
