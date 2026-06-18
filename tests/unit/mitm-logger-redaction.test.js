import { describe, expect, it } from "vitest";
import {
  maskSensitiveHeaders,
  redactSensitiveText,
  redactSensitiveUrl,
  sanitizeValue,
} from "../../src/shared/utils/redaction.js";

describe("MITM logger redaction (shared policy)", () => {
  it("redacts sensitive headers before file logging", () => {
    const headers = maskSensitiveHeaders({
      authorization: "Bearer sk-secret-token",
      "x-goog-api-key": "AIza-secret",
      "x-custom-token": "tok-secret",
      cookie: "sid=secret",
      "content-type": "application/json",
    });

    expect(headers.authorization).not.toBe("Bearer sk-secret-token");
    expect(headers["x-goog-api-key"]).not.toBe("AIza-secret");
    expect(headers["x-custom-token"]).not.toBe("tok-secret");
    expect(headers.cookie).not.toBe("sid=secret");
    expect(headers["content-type"]).toBe("application/json");
  });

  it("redacts sensitive query params and body fields", () => {
    expect(redactSensitiveUrl("/v1/chat?api_key=secret&model=x")).toContain("api_key=[redacted]");

    const body = sanitizeValue({
      prompt: "send with Bearer abc123",
      metadata: { apiKey: "key-secret", access_token: "tok-secret", tokenCount: 12 },
    });

    expect(body.prompt).toBe("send with Bearer [redacted]");
    expect(body.metadata.apiKey).toBeUndefined();
    expect(body.metadata.access_token).toBeUndefined();
    expect(body.metadata.tokenCount).toBe(12);
  });

  it("redacts common token patterns in free text", () => {
    expect(redactSensitiveText("key AIzaSyDeadBeef1234567890")).toContain("AIza[redacted]");
    expect(redactSensitiveText("ghp_abc123secret")).toContain("gh[redacted]");
  });
});
