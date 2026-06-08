import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/sse/utils/logger.js", () => ({
  warn: vi.fn(),
  info: vi.fn(),
  request: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../../src/sse/services/auth.js", () => ({
  authenticateRequest: vi.fn(),
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(),
  getCombos: vi.fn(async () => []),
}));

vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: vi.fn(),
  checkAndRefreshToken: vi.fn(async (providerId, credentials) => credentials),
}));

vi.mock("open-sse/handlers/fetch/index.js", () => ({
  handleFetchCore: vi.fn(async () => ({ success: true, data: { content: "ok" } })),
}));

import { handleFetch } from "../../src/sse/handlers/fetch.js";
import { authenticateRequest, getProviderCredentials } from "../../src/sse/services/auth.js";

describe("handleFetch apiKey scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticateRequest.mockResolvedValue({
      ok: true,
      apiKey: { id: "test-key" },
      settings: {},
    });
    getProviderCredentials.mockResolvedValue({
      connectionId: "conn-1",
      connectionName: "test",
      apiKey: "sk-test",
    });
  });

  it("does not throw ReferenceError when dispatching single-provider fetch", async () => {
    const request = new Request("http://localhost/api/v1/web/fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "tavily",
        url: "https://example.com",
      }),
    });

    const response = await handleFetch(request);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.content).toBe("ok");
  });
});
