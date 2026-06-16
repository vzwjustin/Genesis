// Regression tests for audit findings #9 (sentinel must not bypass requireApiKey)
// and #10 (requireApiKey must fail CLOSED when the settings DB read throws).
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock only the DB-touching + CLI-token dependencies; keep the REAL sentinel
// (apiKey.js) and loopback (loopbackRequest.js) logic under test.
const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getSettingsSafe: vi.fn(),
  validateApiKey: vi.fn(),
  getProviderConnections: vi.fn(),
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
  hasValidLocalCliToken: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  getSettingsSafe: mocks.getSettingsSafe,
  validateApiKey: mocks.validateApiKey,
  getProviderConnections: mocks.getProviderConnections,
  getProviderConnectionById: mocks.getProviderConnectionById,
  updateProviderConnection: mocks.updateProviderConnection,
}));

vi.mock("@/shared/auth/cliToken.js", () => ({
  hasValidLocalCliToken: mocks.hasValidLocalCliToken,
}));

import { authenticateRequest, isValidApiKey } from "../../src/sse/services/auth.js";

const SENTINEL = "sk_genesis";

// A request that isVerifiableLoopbackRequest() accepts: loopback Host + loopback socket.
function loopbackReq(headers = {}) {
  return {
    headers: new Headers({ host: "localhost", ...headers }),
    socket: { remoteAddress: "127.0.0.1" },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasValidLocalCliToken.mockResolvedValue(false);
  mocks.validateApiKey.mockResolvedValue(false);
  mocks.getSettingsSafe.mockResolvedValue({ requireApiKey: false });
});

// ============================================================================
// #9 — localhost sentinel must NOT override an explicit requireApiKey=true
// ============================================================================
describe("#9 sentinel does not bypass requireApiKey=true", () => {
  it("isValidApiKey rejects the sentinel when allowLocalhostSentinel=false", async () => {
    const req = loopbackReq();
    expect(await isValidApiKey(SENTINEL, req, { allowLocalhostSentinel: false })).toBe(false);
    // ...but accepts it on loopback when sentinel use is allowed.
    expect(await isValidApiKey(SENTINEL, req, { allowLocalhostSentinel: true })).toBe(true);
  });

  it("authenticateRequest rejects a sentinel credential under requireApiKey=true", async () => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: true });
    const res = await authenticateRequest(loopbackReq({ "x-api-key": SENTINEL }), null);
    expect(res.ok).toBe(false);
    expect(res.response).toBeDefined();
  });

  it("authenticateRequest accepts a sentinel on loopback when requireApiKey=false (control)", async () => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });
    const res = await authenticateRequest(loopbackReq({ "x-api-key": SENTINEL }), null);
    expect(res.ok).toBe(true);
    expect(res.apiKey).toBe(SENTINEL);
  });
});

// ============================================================================
// #10 — requireApiKey must fail CLOSED when the strict settings read throws
// ============================================================================
describe("#10 requireApiKey fails closed on settings DB error", () => {
  it("forces key enforcement (rejects no-credential loopback) when getSettings throws", async () => {
    mocks.getSettings.mockRejectedValue(new Error("db unavailable"));
    // getSettingsSafe would (insecurely) report requireApiKey:false.
    mocks.getSettingsSafe.mockResolvedValue({ requireApiKey: false });

    const res = await authenticateRequest(loopbackReq(), null);
    expect(res.ok).toBe(false);
    expect(res.response).toBeDefined();
  });

  it("bypasses on loopback with no credentials when getSettings succeeds with requireApiKey:false (control)", async () => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });
    const res = await authenticateRequest(loopbackReq(), null);
    expect(res.ok).toBe(true);
    expect(res.bypassed).toBe(true);
  });
});
