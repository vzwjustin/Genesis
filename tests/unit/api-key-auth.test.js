/**
 * API key authentication tests (Task 18)
 * Requirements: 13.1, 13.4, 13.7
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  validateApiKey: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  validateApiKey: mocks.validateApiKey,
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

describe("authenticateRequest (Task 18)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });
    mocks.validateApiKey.mockImplementation(async (key) => key === "valid-key");
  });

  it("rejects invalid Bearer even when requireApiKey=false (Requirement 13.7)", async () => {
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeRequest({ Authorization: "Bearer bad-key" }),
      log
    );
    expect(result.ok).toBe(false);
    expect(result.response?.status).toBe(401);
  });

  it("accepts no header when requireApiKey=false and logs bypass (Requirement 13.4)", async () => {
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(makeRequest({}), log);
    expect(result.ok).toBe(true);
    expect(result.bypassed).toBe(true);
    expect(log.debug).toHaveBeenCalledWith(
      "AUTH",
      "Authentication bypassed (requireApiKey=false, no credentials)"
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
      makeRequest({ Authorization: "Bearer valid-key" }),
      log
    );
    expect(result.ok).toBe(true);
    expect(result.apiKey).toBe("valid-key");
  });

  it("rejects invalid x-api-key header", async () => {
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeRequest({ "x-api-key": "bad-key" }),
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

  it("treats whitespace-only Authorization header as absent (bypass allowed)", async () => {
    const { authenticateRequest } = await import("../../src/sse/services/auth.js");
    const result = await authenticateRequest(
      makeRequest({ Authorization: "   " }),
      log
    );
    expect(result.ok).toBe(true);
    expect(result.bypassed).toBe(true);
  });
});
