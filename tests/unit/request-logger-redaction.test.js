import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function readAllLogText(root) {
  const logsDir = path.join(root, "logs");
  const files = [];
  for (const session of fs.readdirSync(logsDir)) {
    const sessionDir = path.join(logsDir, session);
    for (const file of fs.readdirSync(sessionDir)) {
      if (file.endsWith(".json") || file.endsWith(".txt")) files.push(path.join(sessionDir, file));
    }
  }
  return files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("legacy request logger redaction", () => {
  it("creates distinct log sessions for same-millisecond requests", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "genesis-request-logs-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmp);
    vi.stubEnv("ENABLE_REQUEST_LOGS", "true");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    vi.resetModules();

    const { createRequestLogger } = await import("../../open-sse/utils/requestLogger.js");
    const first = await createRequestLogger("openai", "claude", "claude-test");
    const second = await createRequestLogger("openai", "claude", "claude-test");

    expect(first.sessionPath).toBeTruthy();
    expect(second.sessionPath).toBeTruthy();
    expect(first.sessionPath).not.toBe(second.sessionPath);
    expect(fs.readdirSync(path.join(tmp, "logs"))).toHaveLength(2);
  });

  it("redacts sensitive nested values before writing request log files", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "genesis-request-logs-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmp);
    vi.stubEnv("ENABLE_REQUEST_LOGS", "true");
    vi.resetModules();

    const { createRequestLogger } = await import("../../open-sse/utils/requestLogger.js");
    const logger = await createRequestLogger("openai", "claude", "claude-test");

    logger.logClientRawRequest(
      "/v1/chat/completions",
      {
        api_key: "body-api-key",
        nested: { access_token: "nested-access-token", safe: "client-safe" },
        max_tokens: 1024,
        usage: { prompt_tokens: 12 },
        text: "Bearer sk-client-secret",
      },
      { Authorization: "Bearer header-secret", "content-type": "application/json" }
    );
    logger.logRawRequest(
      '{"api_key":"raw-json-key","safe":"raw-safe"}',
      { cookie: "session=raw-cookie" }
    );
    logger.logTargetRequest(
      "https://api.example.com/v1/messages?key=provider-query-secret&model=claude-3",
      { Authorization: "Bearer provider-header-secret" },
      { client_secret: "provider-client-secret", safe: "provider-safe" }
    );
    logger.logProviderResponse(
      200,
      "OK",
      new Headers({ "set-cookie": "session=provider-cookie", "content-type": "application/json" }),
      { refresh_token: "provider-refresh-token", safe: "response-safe" }
    );
    logger.logError(
      new Error("failed with access_token=error-token Bearer sk-error-secret sk_genesis"),
      { password: "request-password", safe: "error-safe" }
    );
    logger.appendProviderChunk('data: {"token":"provider-stream-token","safe":"stream-safe"}\n\n');
    logger.appendOpenAIChunk('data: {"client_secret":"openai-stream-secret","safe":"openai-stream-safe"}\n\n');
    logger.appendConvertedChunk("authorization: Bearer converted-stream-secret\nx-9r-cli-token: cli-stream-secret\nconverted-safe");
    await logger.flushStreamLogs();

    const logText = readAllLogText(tmp);
    for (const secret of [
      "body-api-key",
      "nested-access-token",
      "raw-json-key",
      "raw-cookie",
      "sk-client-secret",
      "header-secret",
      "provider-header-secret",
      "provider-query-secret",
      "provider-client-secret",
      "provider-cookie",
      "provider-refresh-token",
      "error-token",
      "sk-error-secret",
      "sk_genesis",
      "request-password",
      "provider-stream-token",
      "openai-stream-secret",
      "converted-stream-secret",
      "cli-stream-secret",
    ]) {
      expect(logText).not.toContain(secret);
    }
    expect(logText).toContain("client-safe");
    expect(logText).toContain("max_tokens");
    expect(logText).toContain("prompt_tokens");
    expect(logText).toContain("raw-safe");
    expect(logText).toContain("provider-safe");
    expect(logText).toContain("response-safe");
    expect(logText).toContain("error-safe");
    expect(logText).toContain("stream-safe");
    expect(logText).toContain("openai-stream-safe");
    expect(logText).toContain("converted-safe");
  });

  it("buffers streaming chunks without synchronous per-chunk appends", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "genesis-request-logs-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmp);
    vi.stubEnv("ENABLE_REQUEST_LOGS", "true");
    vi.resetModules();

    const appendFileSyncSpy = vi.spyOn(fs, "appendFileSync");
    const { createRequestLogger } = await import("../../open-sse/utils/requestLogger.js");
    const logger = await createRequestLogger("openai", "claude", "claude-test");

    logger.appendProviderChunk("provider-safe");
    logger.appendOpenAIChunk("openai-safe");
    logger.appendConvertedChunk("converted-safe");

    expect(appendFileSyncSpy).not.toHaveBeenCalled();

    await logger.flushStreamLogs();
    const logText = readAllLogText(tmp);
    expect(logText).toContain("provider-safe");
    expect(logText).toContain("openai-safe");
    expect(logText).toContain("converted-safe");
  });
});
