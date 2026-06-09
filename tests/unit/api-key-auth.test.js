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
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  validateApiKey: mocks.validateApiKey,
}));

vi.mock("@/shared/auth/cliToken.js", () => ({
  hasValidCliToken: mocks.hasValidCliToken,
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
  });

  it("rejects invalid Bearer even when requireApiKey=false (Requirement 13.7)", async () => {
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeRequest({ Authorization: "Bearer sk-badkeyyy" }),
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

  it("rejects invalid x-api-key header", async () => {
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeRequest({ "x-api-key": "sk-badkeyyy" }),
      log
    );
    expect(result.ok).toBe(false);
    expect(result.response?.status).toBe(401);
  });

  it("rejects present-but-malformed Authorization header even when requireApiKey=false", async () => {
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeRequest({ Authorization: "garbage" }),
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

  it("accepts valid CLI token without API key", async () => {
    mocks.hasValidCliToken.mockResolvedValue(true);
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeRequest({ "x-9r-cli-token": "cli-token" }),
      log
    );
    expect(result.ok).toBe(true);
    expect(result.cliToken).toBe(true);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
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
});
