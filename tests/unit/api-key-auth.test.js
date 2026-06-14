/**
 * API key authentication tests (Task 18)
 * Requirements: 13.1, 13.4, 13.7
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeTestApiKey, useTestApiKeySecret } from "../helpers/apiKeyTestUtils.js";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  validateApiKey: vi.fn(),
  hasValidCliToken: vi.fn(),
  hasValidLocalCliToken: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  getSettingsSafe: vi.fn(async () => {
    try {
      return await mocks.getSettings();
    } catch {
      return { requireApiKey: false, requireLogin: true };
    }
  }),
  validateApiKey: mocks.validateApiKey,
}));

vi.mock("@/shared/auth/cliToken.js", () => ({
  hasValidCliToken: mocks.hasValidCliToken,
  hasValidLocalCliToken: mocks.hasValidLocalCliToken,
}));

const log = {
  warn: vi.fn(),
  debug: vi.fn(),
  maskKey: (k) => `${k.slice(0, 4)}***`,
};

function makeRequest(headers = {}) {
  return {
    headers: {
      get: (name) => headers[name] ?? headers[name.toLowerCase()] ?? null,
    },
  };
}

function makeLoopbackRequest(headers = {}) {
  return makeRequest({
    host: "localhost:20128",
    origin: "http://localhost:20128",
    ...headers,
  });
}

const VALID_TEST_KEY = makeTestApiKey();

describe("authenticateRequest (Task 18)", () => {
  beforeEach(() => {
    useTestApiKeySecret();
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });
    mocks.validateApiKey.mockImplementation(async (key) => key === VALID_TEST_KEY);
    mocks.hasValidCliToken.mockResolvedValue(false);
    mocks.hasValidLocalCliToken.mockResolvedValue(false);
  });

  it("rejects invalid Bearer even when requireApiKey=false (Requirement 13.7)", async () => {
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeLoopbackRequest({ Authorization: "Bearer sk-badkeyyy" }),
      log
    );
    expect(result.ok).toBe(false);
    expect(result.response?.status).toBe(401);
  });

  it("accepts no header on loopback when requireApiKey=false and logs bypass (Requirement 13.4)", async () => {
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(makeLoopbackRequest({}), log);
    expect(result.ok).toBe(true);
    expect(result.bypassed).toBe(true);
    expect(log.debug).toHaveBeenCalledWith(
      "AUTH",
      "Authentication bypassed (requireApiKey=false, loopback, no credentials)"
    );
  });

  it("bypasses stale gateway x-api-key on loopback when provider key is raw Authorization", async () => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeLoopbackRequest({
        "x-api-key": "sk-badkeyyy",
        Authorization: "sk-ant-api03-provider-key",
      }),
      log
    );
    expect(result.ok).toBe(true);
    expect(result.bypassed).toBe(true);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("accepts raw Authorization gateway key without Bearer prefix", async () => {
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeRequest({ Authorization: VALID_TEST_KEY }),
      log
    );
    expect(result.ok).toBe(true);
    expect(result.apiKey).toBe(VALID_TEST_KEY);
  });

  it("accepts valid Bearer when revoked gateway x-api-key is also present", async () => {
    const activeKey = makeTestApiKey();
    mocks.validateApiKey.mockImplementation(async (key) => key === activeKey);
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeRequest({
        "x-api-key": VALID_TEST_KEY,
        Authorization: `Bearer ${activeKey}`,
      }),
      log
    );
    expect(result.ok).toBe(true);
    expect(result.apiKey).toBe(activeKey);
    expect(mocks.validateApiKey).toHaveBeenCalledWith(VALID_TEST_KEY);
    expect(mocks.validateApiKey).toHaveBeenCalledWith(activeKey);
  });

  it("prefers valid Bearer over stale gateway x-api-key", async () => {
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeRequest({
        Authorization: `Bearer ${VALID_TEST_KEY}`,
        "x-api-key": "sk-badkeyyy",
      }),
      log
    );
    expect(result.ok).toBe(true);
    expect(result.apiKey).toBe(VALID_TEST_KEY);
    expect(mocks.validateApiKey).toHaveBeenCalledWith(VALID_TEST_KEY);
  });

  it("does not bypass when requireApiKey=true even with provider Bearer and stale gateway x-api-key", async () => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: true });
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeLoopbackRequest({
        "x-api-key": "sk-badkeyyy",
        Authorization: "Bearer eyJhbGciOiJSUzI1NiJ9.payload.sig",
      }),
      log
    );
    expect(result.ok).toBe(false);
    expect(result.response?.status).toBe(401);
  });

  it("rejects revoked gateway key with provider x-api-key when requireApiKey=true", async () => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: true });
    mocks.validateApiKey.mockResolvedValue(false);
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeLoopbackRequest({
        Authorization: `Bearer ${VALID_TEST_KEY}`,
        "x-api-key": "sk-ant-api03-provider-key",
      }),
      log
    );
    expect(result.ok).toBe(false);
    expect(result.response?.status).toBe(401);
  });

  it("accepts no header on loopback when requireApiKey is unset (default off)", async () => {
    mocks.getSettings.mockResolvedValue({});
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(makeLoopbackRequest(), log);
    expect(result.ok).toBe(true);
    expect(result.bypassed).toBe(true);
  });

  it("rejects stale gateway ApiKey Authorization on loopback when requireApiKey=false", async () => {
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeLoopbackRequest({ Authorization: "ApiKey sk-badkeyyy" }),
      log
    );
    expect(result.ok).toBe(false);
    expect(result.response?.status).toBe(401);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("bypasses stale gateway ApiKey Authorization when provider x-api-key is present", async () => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeLoopbackRequest({
        Authorization: "ApiKey sk-badkeyyy",
        "x-api-key": "sk-ant-api03-provider-key",
      }),
      log
    );
    expect(result.ok).toBe(true);
    expect(result.bypassed).toBe(true);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("rejects OAuth bearer alone on loopback when requireApiKey=true", async () => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: true });
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeLoopbackRequest({
        Authorization: "Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig",
      }),
      log
    );
    expect(result.ok).toBe(false);
    expect(result.response?.status).toBe(401);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("rejects missing key when requireApiKey=true (Requirement 13.1)", async () => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: true });
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(makeRequest({}), log);
    expect(result.ok).toBe(false);
    expect(result.response?.status).toBe(401);
  });

  it("accepts valid Bearer token", async () => {
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeRequest({ Authorization: `Bearer ${VALID_TEST_KEY}` }),
      log
    );
    expect(result.ok).toBe(true);
    expect(result.apiKey).toBe(VALID_TEST_KEY);
  });

  it("accepts valid Bearer token with lowercase bearer scheme", async () => {
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeRequest({ Authorization: `bearer ${VALID_TEST_KEY}` }),
      log
    );
    expect(result.ok).toBe(true);
    expect(result.apiKey).toBe(VALID_TEST_KEY);
  });

  it("prefers x-api-key gateway key over OAuth Bearer on loopback", async () => {
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeLoopbackRequest({
        Authorization: "Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig",
        "x-api-key": VALID_TEST_KEY,
      }),
      log
    );
    expect(result.ok).toBe(true);
    expect(result.apiKey).toBe(VALID_TEST_KEY);
    expect(mocks.validateApiKey).toHaveBeenCalledWith(VALID_TEST_KEY);
  });

  it("rejects invalid x-api-key header", async () => {
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeRequest({ "x-api-key": "sk-badkeyyy" }),
      log
    );
    expect(result.ok).toBe(false);
    expect(result.response?.status).toBe(401);
  });

  it("ignores non-Bearer Authorization on loopback when requireApiKey=false", async () => {
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeLoopbackRequest({ Authorization: "Basic dXNlcjpwYXNz" }),
      log
    );
    expect(result.ok).toBe(true);
    expect(result.bypassed).toBe(true);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("rejects Bearer gateway-shaped key on loopback when requireApiKey=false", async () => {
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeLoopbackRequest({ Authorization: "Bearer sk-badkeyyy" }),
      log
    );
    expect(result.ok).toBe(false);
    expect(result.response?.status).toBe(401);
  });

  it("rejects no header on remote host when requireApiKey=false", async () => {
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeRequest({ host: "router.example.com" }),
      log
    );
    expect(result.ok).toBe(false);
    expect(result.response?.status).toBe(401);
  });

  it("treats whitespace-only Authorization header as absent (bypass allowed on loopback)", async () => {
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeLoopbackRequest({ Authorization: "   " }),
      log
    );
    expect(result.ok).toBe(true);
    expect(result.bypassed).toBe(true);
  });

  it("accepts valid local CLI token without API key", async () => {
    mocks.hasValidLocalCliToken.mockResolvedValue(true);
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeLoopbackRequest({ "x-9r-cli-token": "cli-token" }),
      log
    );
    expect(result.ok).toBe(true);
    expect(result.cliToken).toBe(true);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("rejects valid CLI token from remote origin without API key", async () => {
    mocks.hasValidLocalCliToken.mockResolvedValue(false);
    mocks.getSettings.mockResolvedValue({ requireApiKey: true });
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeRequest({
        host: "router.example.com",
        "x-9r-cli-token": "cli-token",
      }),
      log
    );
    expect(result.ok).toBe(false);
    expect(result.response?.status).toBe(401);
  });

  it("rejects malformed new-format API key before DB lookup", async () => {
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeRequest({ Authorization: "Bearer sk-deadbeef-test01-00000000" }),
      log
    );
    expect(result.ok).toBe(false);
    expect(result.response?.status).toBe(401);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("rejects invalid Api-Key Authorization on loopback when requireApiKey=false", async () => {
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeLoopbackRequest({ Authorization: "Api-Key sk-badkeyyy" }),
      log
    );
    expect(result.ok).toBe(false);
    expect(result.response?.status).toBe(401);
  });

  it("accepts valid gateway key via Api-Key Authorization scheme", async () => {
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeLoopbackRequest({ Authorization: `Api-Key ${VALID_TEST_KEY}` }),
      log
    );
    expect(result.ok).toBe(true);
    expect(result.apiKey).toBe(VALID_TEST_KEY);
    expect(mocks.validateApiKey).toHaveBeenCalledWith(VALID_TEST_KEY);
  });

  it("accepts sk_genesis sentinel on loopback without DB lookup", async () => {
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeLoopbackRequest({ Authorization: "Bearer sk_genesis" }),
      log
    );
    expect(result.ok).toBe(true);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("accepts sk_genesis sentinel with extra Bearer whitespace on loopback", async () => {
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeLoopbackRequest({ Authorization: "Bearer  sk_genesis" }),
      log
    );
    expect(result.ok).toBe(true);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("ignores Anthropic sk-ant-* x-api-key for gateway auth on loopback when requireApiKey=false", async () => {
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeLoopbackRequest({ "x-api-key": "sk-ant-api03-real-anthropic-key" }),
      log
    );
    expect(result.ok).toBe(true);
    expect(result.bypassed).toBe(true);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("ignores OpenAI sk-proj-* bearer for gateway auth on loopback when requireApiKey=false", async () => {
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeLoopbackRequest({ Authorization: "Bearer sk-proj-provider-key-not-gateway" }),
      log
    );
    expect(result.ok).toBe(true);
    expect(result.bypassed).toBe(true);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("ignores long sk- provider bearer for gateway auth on loopback when requireApiKey=false", async () => {
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeLoopbackRequest({ Authorization: `Bearer sk-${"x".repeat(48)}` }),
      log
    );
    expect(result.ok).toBe(true);
    expect(result.bypassed).toBe(true);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("rejects revoked gateway x-api-key alone on loopback when requireApiKey=false", async () => {
    mocks.validateApiKey.mockResolvedValue(false);
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeLoopbackRequest({ "x-api-key": VALID_TEST_KEY }),
      log
    );
    expect(result.ok).toBe(false);
    expect(result.response?.status).toBe(401);
  });

  it("ignores revoked gateway x-api-key when OAuth bearer is present on loopback", async () => {
    mocks.validateApiKey.mockResolvedValue(false);
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeLoopbackRequest({
        "x-api-key": VALID_TEST_KEY,
        Authorization: "Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig",
      }),
      log
    );
    expect(result.ok).toBe(true);
    expect(result.bypassed).toBe(true);
    expect(mocks.validateApiKey).toHaveBeenCalledWith(VALID_TEST_KEY);
  });

  it("ignores revoked gateway Bearer when provider x-api-key is present on loopback", async () => {
    mocks.validateApiKey.mockResolvedValue(false);
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeLoopbackRequest({
        Authorization: `Bearer ${VALID_TEST_KEY}`,
        "x-api-key": "sk-ant-api03-provider-key",
      }),
      log
    );
    expect(result.ok).toBe(true);
    expect(result.bypassed).toBe(true);
    expect(mocks.validateApiKey).toHaveBeenCalledWith(VALID_TEST_KEY);
  });

  it("ignores stale gateway Bearer when provider x-api-key is present on loopback", async () => {
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeLoopbackRequest({
        "x-api-key": "sk-ant-api03-provider-key",
        Authorization: "Bearer sk-badkeyyy",
      }),
      log
    );
    expect(result.ok).toBe(true);
    expect(result.bypassed).toBe(true);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("ignores stale gateway Bearer when Azure api-key header is present on loopback", async () => {
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeLoopbackRequest({
        "api-key": "azure-openai-provider-secret",
        Authorization: "Bearer sk-badkeyyy",
      }),
      log
    );
    expect(result.ok).toBe(true);
    expect(result.bypassed).toBe(true);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("ignores stale gateway Bearer when x-goog-api-key is present on loopback", async () => {
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeLoopbackRequest({
        "x-goog-api-key": "AIzaSyD-provider-google-key",
        Authorization: "Bearer sk-badkeyyy",
      }),
      log
    );
    expect(result.ok).toBe(true);
    expect(result.bypassed).toBe(true);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("ignores stale gateway x-api-key when OAuth bearer is present on loopback", async () => {
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeLoopbackRequest({
        "x-api-key": "sk-badkeyyy",
        Authorization: "Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig",
      }),
      log
    );
    expect(result.ok).toBe(true);
    expect(result.bypassed).toBe(true);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("ignores OAuth bearer token for gateway auth on loopback when requireApiKey=false", async () => {
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeLoopbackRequest({
        Authorization: "Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig",
      }),
      log
    );
    expect(result.ok).toBe(true);
    expect(result.bypassed).toBe(true);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("rejects sk_genesis sentinel from remote host", async () => {
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeRequest({
        host: "router.example.com",
        Authorization: "Bearer sk_genesis",
      }),
      log
    );
    expect(result.ok).toBe(false);
    expect(result.response?.status).toBe(401);
  });

  it("allows loopback bypass when settings are unavailable (default requireApiKey off)", async () => {
    mocks.getSettings.mockRejectedValue(new Error("db unavailable"));
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(makeLoopbackRequest({}), log);
    expect(result.ok).toBe(true);
    expect(result.bypassed).toBe(true);
    expect(result.settings.requireApiKey).toBe(false);
  });

  it("rejects remote access when settings are unavailable", async () => {
    mocks.getSettings.mockRejectedValue(new Error("db unavailable"));
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeRequest({ host: "router.example.com" }),
      log
    );
    expect(result.ok).toBe(false);
    expect(result.response?.status).toBe(401);
  });

  it("rejects stale gateway x-api-key on loopback when Token authorization is garbage", async () => {
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeLoopbackRequest({
        "x-api-key": "sk-badkeyyy",
        Authorization: "Token hello",
      }),
      log
    );
    expect(result.ok).toBe(false);
    expect(result.response?.status).toBe(401);
  });

  it("ignores stale gateway Bearer when Deepgram Token authorization is present on loopback", async () => {
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeLoopbackRequest({
        Authorization: "Token deepgram-provider-secret",
        "x-api-key": "sk-badkeyyy",
      }),
      log
    );
    expect(result.ok).toBe(true);
    expect(result.bypassed).toBe(true);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("allows loopback stale gateway bypass when settings are unavailable", async () => {
    mocks.getSettings.mockRejectedValue(new Error("db unavailable"));
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeLoopbackRequest({
        "x-api-key": "sk-badkeyyy",
        Authorization: "Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig",
      }),
      log
    );
    expect(result.ok).toBe(true);
    expect(result.bypassed).toBe(true);
  });
});
