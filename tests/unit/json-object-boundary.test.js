import { describe, it, expect, vi, beforeEach } from "vitest";

const authMocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
}));

const compactMocks = vi.hoisted(() => ({
  initTranslators: vi.fn(async () => {}),
  handleChat: vi.fn(),
}));

const routeAuthMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));

vi.mock("../../src/sse/services/auth.js", () => authMocks);

vi.mock("@/lib/localDb", () => ({
  getSettingsSafe: vi.fn(async () => ({})),
  getSettings: vi.fn(async () => ({})),
  getCombos: vi.fn(async () => ({})),
}));

vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: vi.fn(async () => ({ provider: "openai", model: "gpt-4o" })),
  getComboModels: vi.fn(async () => null),
  getBrokenComboError: vi.fn(async () => null),
}));

vi.mock("open-sse/handlers/chatCore.js", () => ({
  handleChatCore: vi.fn(),
}));

vi.mock("open-sse/handlers/search/index.js", () => ({
  handleSearchCore: vi.fn(),
}));

vi.mock("open-sse/services/combo.js", () => ({
  handleComboChat: vi.fn(),
  getComboModelsFromData: vi.fn(() => null),
  getBrokenComboErrorFromData: vi.fn(() => null),
}));

vi.mock("@/shared/constants/providers.js", () => ({
  AI_PROVIDERS: {},
  resolveProviderId: vi.fn((provider) => provider),
}));

vi.mock("../../src/sse/utils/providerCredentialRetry.js", () => ({
  resolveProviderRetryLimits: vi.fn(async () => ({ isNoAuthProvider: false, maxRetries: 0 })),
  noActiveCredentialsResponse: vi.fn(() => new Response("{}", { status: 503 })),
  exhaustedAccountsResponse: vi.fn(() => new Response("{}", { status: 503 })),
}));

vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: vi.fn(),
  checkAndRefreshToken: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));
vi.mock("open-sse/translator/index.js", () => ({
  initTranslators: (...args) => compactMocks.initTranslators(...args),
}));
vi.mock("@/sse/handlers/chat.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    handleChat: (...args) => compactMocks.handleChat(...args),
  };
});

vi.mock("@/sse/utils/routeAuth.js", () => ({
  requireRouteAuth: (...args) => routeAuthMock(...args),
}));

function jsonRequest(body, url = "http://localhost/v1/test") {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function expectInvalidJsonBody(response) {
  expect(response.status).toBe(400);
  const body = await response.json();
  const message = body.error?.message || body.error;
  expect(message).toBe("Invalid JSON body");
}

describe("request boundary JSON object validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeAuthMock.mockResolvedValue({ ok: true });
  });

  it.each([null, "text", 42, true, []])("handleChat rejects %j before auth", async (payload) => {
    const { handleChat } = await import("../../src/sse/handlers/chat.js");
    const response = await handleChat(jsonRequest(payload, "http://localhost/v1/chat/completions"));
    await expectInvalidJsonBody(response);
    expect(authMocks.authenticateRequest).not.toHaveBeenCalled();
  });

  it.each([null, "text", 42, true, []])("responses compact rejects %j before mutating or dispatching", async (payload) => {
    const { POST } = await import("../../src/app/api/v1/responses/compact/route.js");
    const response = await POST(jsonRequest(payload, "http://localhost/v1/responses/compact"));
    await expectInvalidJsonBody(response);
    expect(compactMocks.handleChat).not.toHaveBeenCalled();
  });

  it.each([null, "text", 42, true, []])("count_tokens rejects %j after route auth and before field reads", async (payload) => {
    const { POST } = await import("../../src/app/api/v1/messages/count_tokens/route.js");
    const response = await POST(jsonRequest(payload, "http://localhost/v1/messages/count_tokens"));
    await expectInvalidJsonBody(response);
  });

  it.each([null, "text", 42, true, []])("handleSearch rejects %j before auth", async (payload) => {
    const { handleSearch } = await import("../../src/sse/handlers/search.js");
    const response = await handleSearch(jsonRequest(payload, "http://localhost/v1/web/search"));
    await expectInvalidJsonBody(response);
    expect(authMocks.authenticateRequest).not.toHaveBeenCalled();
  });
});
