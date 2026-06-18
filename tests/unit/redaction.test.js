import { describe, expect, it } from "vitest";
import { redactSensitiveText, redactSensitiveUrl } from "../../src/shared/utils/redaction.js";

describe("redactSensitiveText", () => {
  it("redacts sk- gateway and provider key shapes", () => {
    const input = "keys: sk-deadbeef-cafebabe-abcd1234 and sk-proj-secret123";
    const out = redactSensitiveText(input);
    expect(out).not.toContain("deadbeef");
    expect(out).not.toContain("secret123");
    expect(out).toContain("sk-[redacted]");
  });

  it("redacts sk_genesis localhost sentinel", () => {
    const input = "Bearer sk_genesis failed with sk_genesis in body";
    const out = redactSensitiveText(input);
    expect(out).not.toContain("sk_genesis");
    expect(out).toContain("sk_[redacted]");
  });

  it("redacts Bearer tokens in header lines", () => {
    const out = redactSensitiveText("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload");
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(out).toContain("[redacted]");
  });

  it("redacts Token authorization scheme in free text", () => {
    const out = redactSensitiveText("upstream rejected Token deepgram-secret-key-value");
    expect(out).not.toContain("deepgram-secret");
    expect(out).toContain("Token [redacted]");
  });

  it("redacts Api-Key and ApiKey authorization schemes in free text", () => {
    const out = redactSensitiveText("upstream rejected Api-Key sk-deadbeef-cafebabe-abcd1234 and ApiKey sk-proj-secret");
    expect(out).not.toContain("deadbeef");
    expect(out).not.toContain("secret");
    expect(out).toContain("ApiKey [redacted]");
  });

  it("redacts x-9r-cli-token in header lines and JSON", () => {
    const headerLine = "x-9r-cli-token: abcdef0123456789";
    const jsonLine = '{"x-9r-cli-token":"abcdef0123456789","safe":"ok"}';
    expect(redactSensitiveText(headerLine)).not.toContain("abcdef0123456789");
    expect(redactSensitiveText(jsonLine)).not.toContain("abcdef0123456789");
    expect(redactSensitiveText(jsonLine)).toContain("ok");
  });

  it("redacts bare key= query param values in free text", () => {
    const out = redactSensitiveText("https://api.example.com/v1?key=super-secret-key&model=gpt-4");
    expect(out).not.toContain("super-secret-key");
    expect(out).toContain("key=[redacted]");
    expect(out).toContain("model=gpt-4");
  });
});

describe("redactSensitiveUrl", () => {
  it("redacts sensitive query params including key=", () => {
    const out = redactSensitiveUrl(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=AIzaSyDeadBeef&alt=json"
    );
    expect(out).not.toContain("AIzaSyDeadBeef");
    expect(out).toContain("key=[redacted]");
    expect(out).toContain("alt=json");
  });

  it("preserves non-sensitive query params", () => {
    const out = redactSensitiveUrl("https://api.example.com/v1/messages?model=claude-3&stream=true");
    expect(out).toContain("model=claude-3");
    expect(out).toContain("stream=true");
  });
});
