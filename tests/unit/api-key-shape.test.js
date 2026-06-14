import { describe, it, expect } from "vitest";
import {
  isgenesisKeyShape,
  looksLikegenesisApiKey,
  hasgenesisCredentialAttempt,
  extractGatewayApiKey,
  getGatewayApiKeyCandidates,
  extractApiKey,
} from "../../src/shared/utils/apiKey.js";
import { makeTestApiKey, useTestApiKeySecret } from "../helpers/apiKeyTestUtils.js";

describe("genesis API key shape detection", () => {
  it("matches new-format gateway keys", () => {
    expect(isgenesisKeyShape("sk-deadbeef-test01-00000000")).toBe(true);
  });

  it("matches legacy two-part sk- keys", () => {
    expect(isgenesisKeyShape("sk-badkeyyy")).toBe(true);
  });

  it("excludes provider API key prefixes", () => {
    expect(isgenesisKeyShape("sk-ant-api03-key")).toBe(false);
    expect(isgenesisKeyShape("sk-proj-openai-key")).toBe(false);
    expect(isgenesisKeyShape("sk-or-v1-key")).toBe(false);
    expect(isgenesisKeyShape("sk-svcacct-prod-agent")).toBe(false);
    expect(isgenesisKeyShape("sk-admin-org-mgmt")).toBe(false);
  });

  it("excludes arbitrary four-part sk- tokens that are not gateway layout", () => {
    expect(isgenesisKeyShape("sk-foo-bar-baz-12345678")).toBe(false);
    expect(hasgenesisCredentialAttempt({
      headers: { get: (n) => (n === "Authorization" ? "Bearer sk-foo-bar-baz-12345678" : null) },
    })).toBe(false);
  });

  it("excludes long sk- provider secrets (OpenAI-style single segment)", () => {
    const openAiStyle = `sk-${"a".repeat(48)}`;
    expect(isgenesisKeyShape(openAiStyle)).toBe(false);
    expect(looksLikegenesisApiKey(openAiStyle)).toBe(false);
  });

  it("excludes non-sk tokens", () => {
    expect(looksLikegenesisApiKey("sk_genesis")).toBe(true);
    expect(looksLikegenesisApiKey("eyJhbGciOiJIUzI1NiJ9")).toBe(false);
  });

  it("detects credential attempts only for gateway-shaped keys", () => {
    const req = (headers) => ({
      headers: { get: (name) => headers[name] ?? null },
    });

    expect(hasgenesisCredentialAttempt(req({ Authorization: "Bearer sk-badkeyyy" }))).toBe(true);
    expect(hasgenesisCredentialAttempt(req({ Authorization: "bearer sk-badkeyyy" }))).toBe(true);
    expect(hasgenesisCredentialAttempt(req({ Authorization: "Bearer sk-proj-abc" }))).toBe(false);
    expect(hasgenesisCredentialAttempt(req({ "x-api-key": "sk-ant-api03-key" }))).toBe(false);
    expect(hasgenesisCredentialAttempt(req({ Authorization: "garbage" }))).toBe(false);
    expect(hasgenesisCredentialAttempt(req({ Authorization: "Basic dXNlcjpwYXNz" }))).toBe(false);
  });

  it("ignores stale gateway-shaped x-api-key when Bearer is a provider token", () => {
    const req = (headers) => ({
      headers: { get: (name) => headers[name] ?? null },
    });

    expect(hasgenesisCredentialAttempt(req({
      "x-api-key": "sk-badkeyyy",
      Authorization: "Bearer eyJhbGciOiJSUzI1NiJ9.payload.sig",
    }))).toBe(false);
    expect(extractGatewayApiKey(req({
      "x-api-key": "sk-badkeyyy",
      Authorization: "Bearer eyJhbGciOiJSUzI1NiJ9.payload.sig",
    }))).toBe(null);
  });

  it("ignores stale gateway Bearer when provider x-api-key is present", () => {
    const req = (headers) => ({
      headers: { get: (name) => headers[name] ?? null },
    });

    expect(hasgenesisCredentialAttempt(req({
      "x-api-key": "sk-ant-api03-provider-key",
      Authorization: "Bearer sk-badkeyyy",
    }))).toBe(false);
    expect(extractGatewayApiKey(req({
      "x-api-key": "sk-ant-api03-provider-key",
      Authorization: "Bearer sk-badkeyyy",
    }))).toBe(null);
  });

  it("ignores stale gateway x-api-key when non-sk provider key is in x-api-key", () => {
    const req = (headers) => ({
      headers: { get: (name) => headers[name] ?? null },
    });

    expect(hasgenesisCredentialAttempt(req({
      "x-api-key": "sk-badkeyyy",
      Authorization: "Bearer AIzaSyD-provider-google-key",
    }))).toBe(false);
  });

  it("ignores stale gateway Bearer when x-goog-api-key is present", () => {
    const req = (headers) => ({
      headers: { get: (name) => headers[name] ?? null },
    });

    expect(hasgenesisCredentialAttempt(req({
      "x-goog-api-key": "AIzaSyD-provider-google-key",
      Authorization: "Bearer sk-badkeyyy",
    }))).toBe(false);
    expect(extractGatewayApiKey(req({
      "x-goog-api-key": "AIzaSyD-provider-google-key",
      Authorization: "Bearer sk-badkeyyy",
    }))).toBe(null);
  });

  it("ignores stale gateway x-api-key when Azure api-key header is present", () => {
    const req = (headers) => ({
      headers: { get: (name) => headers[name] ?? null },
    });

    expect(hasgenesisCredentialAttempt(req({
      "x-api-key": "sk-badkeyyy",
      "api-key": "azure-openai-provider-secret",
    }))).toBe(false);
  });

  it("does not bypass stale gateway x-api-key when Authorization Token is garbage", () => {
    const req = (headers) => ({
      headers: { get: (name) => headers[name] ?? null },
    });

    expect(hasgenesisCredentialAttempt(req({
      "x-api-key": "sk-badkeyyy",
      Authorization: "Token hello",
    }))).toBe(true);
    expect(extractGatewayApiKey(req({
      "x-api-key": "sk-badkeyyy",
      Authorization: "Token hello",
    }))).toBe("sk-badkeyyy");
  });

  it("does not bypass stale gateway Bearer when Authorization Bearer is garbage", () => {
    const req = (headers) => ({
      headers: { get: (name) => headers[name] ?? null },
    });

    expect(hasgenesisCredentialAttempt(req({
      Authorization: "Bearer hello",
      "x-api-key": "sk-badkeyyy",
    }))).toBe(true);
  });

  it("ignores stale gateway Bearer when Authorization uses Token scheme (Deepgram)", () => {
    const req = (headers) => ({
      headers: { get: (name) => headers[name] ?? null },
    });

    expect(hasgenesisCredentialAttempt(req({
      Authorization: "Bearer sk-badkeyyy",
    }))).toBe(true);
    expect(hasgenesisCredentialAttempt(req({
      Authorization: "Token deepgram-provider-secret",
      "x-api-key": "sk-badkeyyy",
    }))).toBe(false);
    expect(extractGatewayApiKey(req({
      Authorization: "Token deepgram-provider-secret",
      "x-api-key": "sk-badkeyyy",
    }))).toBe(null);
    expect(hasgenesisCredentialAttempt(req({
      Authorization: "token dg_live_provider_key",
      "x-api-key": "sk-badkeyyy",
    }))).toBe(false);
  });

  it("still treats invalid gateway x-api-key alone as a credential attempt", () => {
    const req = (headers) => ({
      headers: { get: (name) => headers[name] ?? null },
    });

    expect(hasgenesisCredentialAttempt(req({ "x-api-key": "sk-badkeyyy" }))).toBe(true);
    expect(extractGatewayApiKey(req({ "x-api-key": "sk-badkeyyy" }))).toBe("sk-badkeyyy");
  });

  it("extracts raw Authorization gateway keys without Bearer prefix", () => {
    useTestApiKeySecret();
    const gatewayKey = makeTestApiKey();
    const req = (headers) => ({
      headers: { get: (name) => headers[name] ?? null },
    });

    expect(extractGatewayApiKey(req({ Authorization: gatewayKey }))).toBe(gatewayKey);
    expect(extractGatewayApiKey(req({ Authorization: "sk-badkeyyy" }))).toBe("sk-badkeyyy");
  });

  it("ignores stale gateway x-api-key when provider key is raw Authorization without Bearer", () => {
    const req = (headers) => ({
      headers: { get: (name) => headers[name] ?? null },
    });

    expect(hasgenesisCredentialAttempt(req({
      "x-api-key": "sk-badkeyyy",
      Authorization: "sk-ant-api03-provider-key",
    }))).toBe(false);
    expect(extractGatewayApiKey(req({
      "x-api-key": "sk-badkeyyy",
      Authorization: "sk-ant-api03-provider-key",
    }))).toBe(null);
  });

  it("does not treat Basic Authorization as a provider credential for stale bypass", () => {
    const req = (headers) => ({
      headers: { get: (name) => headers[name] ?? null },
    });

    expect(hasgenesisCredentialAttempt(req({
      "x-api-key": "sk-badkeyyy",
      Authorization: "Basic dXNlcjpwYXNz",
    }))).toBe(true);
    expect(extractGatewayApiKey(req({
      "x-api-key": "sk-badkeyyy",
      Authorization: "Basic dXNlcjpwYXNz",
    }))).toBe("sk-badkeyyy");
  });

  it("ignores stale raw Authorization when provider x-api-key is present", () => {
    const req = (headers) => ({
      headers: { get: (name) => headers[name] ?? null },
    });

    expect(hasgenesisCredentialAttempt(req({
      Authorization: "sk-badkeyyy",
      "x-api-key": "sk-ant-api03-provider-key",
    }))).toBe(false);
    expect(extractGatewayApiKey(req({
      Authorization: "sk-badkeyyy",
      "x-api-key": "sk-ant-api03-provider-key",
    }))).toBe(null);
  });

  it("orders gateway candidates with x-api-key before Authorization when both are verifiable", () => {
    useTestApiKeySecret();
    const headerKey = makeTestApiKey("deadbeef", "head01");
    const bearerKey = makeTestApiKey("deadbeef", "bear01");
    const req = (headers) => ({
      headers: { get: (name) => headers[name] ?? null },
    });

    expect(getGatewayApiKeyCandidates(req({
      "x-api-key": headerKey,
      Authorization: `Bearer ${bearerKey}`,
    }))).toEqual([headerKey, bearerKey]);
  });

  it("prefers verifiable Bearer over stale gateway x-api-key", () => {
    useTestApiKeySecret();
    const gatewayKey = makeTestApiKey();
    const req = {
      headers: {
        get: (name) => ({
          Authorization: `Bearer ${gatewayKey}`,
          "x-api-key": "sk-badkeyyy",
        })[name] ?? null,
      },
    };

    expect(extractGatewayApiKey(req)).toBe(gatewayKey);
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

  it("treats Authorization ApiKey scheme like Bearer for gateway auth", () => {
    useTestApiKeySecret();
    const gatewayKey = makeTestApiKey();
    const req = (headers) => ({
      headers: { get: (name) => headers[name] ?? null },
    });

    expect(extractGatewayApiKey(req({ Authorization: `ApiKey ${gatewayKey}` }))).toBe(gatewayKey);
    expect(hasgenesisCredentialAttempt(req({ Authorization: "ApiKey sk-badkeyyy" }))).toBe(true);
    expect(hasgenesisCredentialAttempt(req({
      Authorization: "ApiKey sk-badkeyyy",
      "x-api-key": "sk-ant-api03-provider-key",
    }))).toBe(false);
    expect(extractApiKey(req({ Authorization: `ApiKey ${gatewayKey}` }))).toBe(gatewayKey);
  });

  it("treats Authorization Api-Key scheme like ApiKey for gateway auth", () => {
    useTestApiKeySecret();
    const gatewayKey = makeTestApiKey();
    const req = (headers) => ({
      headers: { get: (name) => headers[name] ?? null },
    });

    expect(extractGatewayApiKey(req({ Authorization: `Api-Key ${gatewayKey}` }))).toBe(gatewayKey);
    expect(hasgenesisCredentialAttempt(req({ Authorization: "Api-Key sk-badkeyyy" }))).toBe(true);
    expect(hasgenesisCredentialAttempt(req({
      Authorization: "Api-Key sk-badkeyyy",
      "x-api-key": "sk-ant-api03-provider-key",
    }))).toBe(false);
    expect(extractApiKey(req({ Authorization: `Api-Key ${gatewayKey}` }))).toBe(gatewayKey);
  });

  it("extractApiKey includes raw Authorization sk- tokens without Bearer", () => {
    useTestApiKeySecret();
    const gatewayKey = makeTestApiKey();
    const req = {
      headers: {
        get: (name) => (name === "Authorization" ? gatewayKey : null),
      },
    };

    expect(extractApiKey(req)).toBe(gatewayKey);
  });
});
