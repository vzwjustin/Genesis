import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "module";
import fs from "fs";
import path from "path";
import os from "os";

const require = createRequire(import.meta.url);

const ALIASES = {
  kiro: {
    "claude-sonnet-4.5": "cu/composer-2.5",
    "claude-haiku-4.5": "cu/composer-2.5",
  },
};

function kiroBody(conversationState) {
  return Buffer.from(JSON.stringify({ conversationState }));
}

describe("mitm model mapping — Kiro follow-up turns", () => {
  let tmpDir;
  let originalDataDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mitm-model-"));
    fs.mkdirSync(path.join(tmpDir, "mitm"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "mitm", "aliases.json"),
      JSON.stringify(ALIASES)
    );
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = tmpDir;
    for (const mod of [
      "../../src/mitm/paths.js",
      "../../src/mitm/dbReader.js",
      "../../src/mitm/modelMapping.js",
    ]) {
      delete require.cache[require.resolve(mod)];
    }
  });

  afterEach(() => {
    process.env.DATA_DIR = originalDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("strips qdev:: namespace before alias lookup", () => {
    const { getMappedModel: map, normalizeKiroModelId } = require("../../src/mitm/modelMapping.js");
    expect(map("kiro", "qdev::CLAUDE_SONNET_4_20250514_V1_0")).toBe("cu/composer-2.5");
    expect(normalizeKiroModelId("qdev::auto")).toBe("auto");
  });

  it("maps auto model selection to composer", () => {
    const { getMappedModel: map } = require("../../src/mitm/modelMapping.js");
    expect(map("kiro", "auto")).toBe("cu/composer-2.5");
    expect(map("kiro", "qdev::auto")).toBe("cu/composer-2.5");
  });

  it("uses auto when tool-round follow-up omits modelId", () => {
    const { extractModel: extract, getMappedModel: map } = require("../../src/mitm/modelMapping.js");
    const body = kiroBody({
      currentMessage: {
        userInputMessage: {
          content: "continue",
          origin: "AI_EDITOR",
          userInputMessageContext: { toolResults: [{ toolUseId: "t1", content: [{ text: "ok" }] }] },
        },
      },
      history: [
        {
          userInputMessage: {
            content: "first",
            modelId: "claude-sonnet-4.5",
            origin: "AI_EDITOR",
          },
        },
        { assistantResponseMessage: { content: "done", toolUses: [{ toolUseId: "t1", name: "read_file" }] } },
      ],
    });
    expect(extract("/", body)).toBe("claude-sonnet-4.5");
    expect(map("kiro", extract("/", body))).toBe("cu/composer-2.5");
  });

  it("falls back to auto then composer when history also omits modelId", () => {
    const { extractModel: extract, getMappedModel: map } = require("../../src/mitm/modelMapping.js");
    const body = kiroBody({
      currentMessage: {
        userInputMessage: {
          content: "after tools",
          origin: "AI_EDITOR",
          userInputMessageContext: { toolResults: [{ toolUseId: "t1", content: [{ text: "ok" }] }] },
        },
      },
      history: [
        { userInputMessage: { content: "first", origin: "AI_EDITOR" } },
        { assistantResponseMessage: { content: "used tool" } },
      ],
    });
    expect(extract("/", body)).toBe("auto");
    expect(map("kiro", extract("/", body))).toBe("cu/composer-2.5");
  });

  it("kiro fallback uses claude-sonnet-4.5 when model is unknown", () => {
    const { getMappedModel: map } = require("../../src/mitm/modelMapping.js");
    expect(map("kiro", "totally-unknown-model-xyz")).toBe("cu/composer-2.5");
  });
});
