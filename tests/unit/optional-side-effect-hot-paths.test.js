import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

describe("optional side-effect hot paths", () => {
  it("chatCore request path records compression events without aggregate stats updates", () => {
    const chatCore = fs.readFileSync(path.join(repoRoot, "open-sse/handlers/chatCore.js"), "utf8");

    expect(chatCore).toContain("saveCompressionStats");
    expect(chatCore).not.toContain("recordCompressionStats");
  });

  it("streaming request logger append methods do not use synchronous file appends", () => {
    const requestLogger = fs.readFileSync(path.join(repoRoot, "open-sse/utils/requestLogger.js"), "utf8");
    const start = requestLogger.indexOf("appendProviderChunk(chunk)");
    const end = requestLogger.indexOf("flushStreamLogs: flushQueuedStreamLogs");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const appendMethods = requestLogger.slice(
      start,
      end
    );

    expect(appendMethods).toContain("queueStreamChunk");
    expect(appendMethods).not.toContain("appendFileSync");
  });
});
