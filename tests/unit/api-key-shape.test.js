import { describe, it, expect } from "vitest";
import {
  is9routerKeyShape,
  looksLike9routerApiKey,
  has9routerCredentialAttempt,
  extractGatewayApiKey,
  extractApiKey,
} from "../../src/shared/utils/apiKey.js";
import { makeTestApiKey, useTestApiKeySecret } from "../helpers/apiKeyTestUtils.js";

describe("9router API key shape detection", () => {
  it("matches new-format gateway keys", () => {
    expect(is9routerKeyShape("sk-deadbeef-test01-00000000")).toBe(true);
  });

  it("matches legacy two-part sk- keys", () => {
    expect(is9routerKeyShape("sk-badkeyyy")).toBe(true);
  });

  it("excludes provider API key prefixes", () => {
    expect(is9routerKeyShape("sk-ant-api03-key")).toBe(false);
    expect(is9routerKeyShape("sk-proj-openai-key")).toBe(false);
    expect(is9routerKeyShape("sk-or-v1-key")).toBe(false);
  });

  it("excludes non-sk tokens", () => {
    expect(looksLike9routerApiKey("sk_9router")).toBe(true);
    expect(looksLike9routerApiKey("eyJhbGciOiJIUzI1NiJ9")).toBe(false);
  });

  it("detects credential attempts only for gateway-shaped keys", () => {
    const req = (headers) => ({
      headers: { get: (name) => headers[name] ?? null },
    });

    expect(has9routerCredentialAttempt(req({ Authorization: "Bearer sk-badkeyyy" }))).toBe(true);
    expect(has9routerCredentialAttempt(req({ Authorization: "bearer sk-badkeyyy" }))).toBe(true);
    expect(has9routerCredentialAttempt(req({ Authorization: "Bearer sk-proj-abc" }))).toBe(false);
    expect(has9routerCredentialAttempt(req({ "x-api-key": "sk-ant-api03-key" }))).toBe(false);
    expect(has9routerCredentialAttempt(req({ Authorization: "garbage" }))).toBe(true);
  });

  it("extractGatewayApiKey prefers x-api-key over non-gateway Bearer", () => {
    useTestApiKeySecret();
    const gatewayKey = makeTestApiKey();
    const req = {
      headers: {
        get: (name) => ({
          Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.payload",
          "x-api-key": gatewayKey,
        })[name] ?? null,
      },
    };

    expect(extractGatewayApiKey(req)).toBe(gatewayKey);
    expect(extractApiKey(req)).toBe("eyJhbGciOiJIUzI1NiJ9.payload");
  });
});
