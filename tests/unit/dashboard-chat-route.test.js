import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeTestApiKey, useTestApiKeySecret } from "../helpers/apiKeyTestUtils.js";

const mockHandleChat = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
const mockGetSettings = vi.fn(async () => ({ requireApiKey: true }));
const mockGetApiKeys = vi.fn(async () => [{ key: "sk-internal-test", isActive: true }]);
const mockValidateApiKey = vi.fn(async () => true);

vi.mock("@/sse/handlers/chat.js", () => ({
  handleChat: (...args) => mockHandleChat(...args),
}));

vi.mock("open-sse/translator/index.js", () => ({
  initTranslators: vi.fn(async () => {}),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: (...args) => mockGetSettings(...args),
  getSettingsSafe: async (...args) => {
    try {
      return await mockGetSettings(...args);
    } catch {
      return { requireApiKey: false, requireLogin: true };
    }
  },
  getApiKeys: (...args) => mockGetApiKeys(...args),
  validateApiKey: (...args) => mockValidateApiKey(...args),
}));

const { POST } = await import("../../src/app/api/dashboard/chat/completions/route.js");

describe("dashboard chat completions route", () => {
  beforeEach(() => {
    useTestApiKeySecret();
    vi.clearAllMocks();
    mockGetSettings.mockResolvedValue({ requireApiKey: true });
    mockGetApiKeys.mockResolvedValue([{ key: "sk-internal-test", isActive: true }]);
    mockValidateApiKey.mockResolvedValue(true);
    mockHandleChat.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  });

  it("proxies to handleChat with internal API key when requireApiKey=true", async () => {
    const request = new Request("http://localhost:3456/api/dashboard/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }], stream: true }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(mockHandleChat).toHaveBeenCalledTimes(1);

    const internalRequest = mockHandleChat.mock.calls[0][0];
    expect(internalRequest.url).toContain("/api/v1/chat/completions");
    expect(internalRequest.headers.get("Authorization")).toBe("Bearer sk-internal-test");
  });

  it("does not inject when valid Bearer accompanies revoked gateway x-api-key", async () => {
    const activeKey = makeTestApiKey();
    const revokedKey = makeTestApiKey();
    mockValidateApiKey.mockImplementation(async (key) => key === activeKey);

    const request = new Request("http://localhost:3456/api/dashboard/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": revokedKey,
        Authorization: `Bearer ${activeKey}`,
      },
      body: JSON.stringify({ model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });

    await POST(request);
    const internalRequest = mockHandleChat.mock.calls[0][0];
    expect(internalRequest.headers.get("Authorization")).toBe(`Bearer ${activeKey}`);
    expect(internalRequest.headers.get("x-api-key")).toBe(revokedKey);
    expect(mockGetApiKeys).not.toHaveBeenCalled();
  });

  it("does not overwrite valid bearer gateway key with injected key", async () => {
    const userKey = makeTestApiKey();
    mockValidateApiKey.mockImplementation(async (key) => key === userKey);
    const request = new Request("http://localhost:3456/api/dashboard/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `bearer ${userKey}`,
      },
      body: JSON.stringify({ model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });

    await POST(request);
    const internalRequest = mockHandleChat.mock.calls[0][0];
    expect(internalRequest.headers.get("Authorization")).toBe(`bearer ${userKey}`);
  });

  it("strips stale gateway x-api-key when injecting internal key", async () => {
    const request = new Request("http://localhost:3456/api/dashboard/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "sk-badkeyyy",
      },
      body: JSON.stringify({ model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });

    await POST(request);
    const internalRequest = mockHandleChat.mock.calls[0][0];
    expect(internalRequest.headers.get("x-api-key")).toBeNull();
    expect(internalRequest.headers.get("Authorization")).toBe("Bearer sk-internal-test");
  });

  it("preserves provider x-api-key when injecting internal key", async () => {
    const request = new Request("http://localhost:3456/api/dashboard/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "sk-ant-api03-provider-only",
      },
      body: JSON.stringify({ model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });

    await POST(request);
    const internalRequest = mockHandleChat.mock.calls[0][0];
    expect(internalRequest.headers.get("x-api-key")).toBe("sk-ant-api03-provider-only");
    expect(internalRequest.headers.get("Authorization")).toBe("Bearer sk-internal-test");
  });

  it("strips stale gateway ApiKey Authorization when injecting internal key", async () => {
    const request = new Request("http://localhost:3456/api/dashboard/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "ApiKey sk-badkeyyy",
      },
      body: JSON.stringify({ model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });

    await POST(request);
    const internalRequest = mockHandleChat.mock.calls[0][0];
    expect(internalRequest.headers.get("Authorization")).toBe("Bearer sk-internal-test");
  });

  it("strips stale gateway Api-Key Authorization when injecting internal key", async () => {
    const request = new Request("http://localhost:3456/api/dashboard/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Api-Key sk-badkeyyy",
      },
      body: JSON.stringify({ model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });

    await POST(request);
    const internalRequest = mockHandleChat.mock.calls[0][0];
    expect(internalRequest.headers.get("Authorization")).toBe("Bearer sk-internal-test");
  });

  it("strips stale gateway Token Authorization when injecting internal key", async () => {
    const request = new Request("http://localhost:3456/api/dashboard/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Token sk-badkeyyy",
      },
      body: JSON.stringify({ model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });

    await POST(request);
    const internalRequest = mockHandleChat.mock.calls[0][0];
    expect(internalRequest.headers.get("Authorization")).toBe("Bearer sk-internal-test");
  });

  it("strips stale gateway Token Authorization when valid x-api-key is present", async () => {
    const userKey = makeTestApiKey();
    mockValidateApiKey.mockImplementation(async (key) => key === userKey);

    const request = new Request("http://localhost:3456/api/dashboard/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": userKey,
        Authorization: "Token sk-badkeyyy",
      },
      body: JSON.stringify({ model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });

    await POST(request);
    const internalRequest = mockHandleChat.mock.calls[0][0];
    expect(internalRequest.headers.get("x-api-key")).toBe(userKey);
    expect(internalRequest.headers.get("Authorization")).toBeNull();
    expect(mockGetApiKeys).not.toHaveBeenCalled();
  });

  it("injects gateway key over stale invalid bearer credentials", async () => {
    const request = new Request("http://localhost:3456/api/dashboard/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer sk-badkeyyy",
      },
      body: JSON.stringify({ model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });

    await POST(request);
    const internalRequest = mockHandleChat.mock.calls[0][0];
    expect(internalRequest.headers.get("Authorization")).toBe("Bearer sk-internal-test");
  });

  it("strips stale bearer when no active internal keys are available", async () => {
    mockGetApiKeys.mockResolvedValue([{ key: "sk-inactive", isActive: false }]);
    const request = new Request("http://localhost:3456/api/dashboard/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer sk-badkeyyy",
      },
      body: JSON.stringify({ model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });

    await POST(request);
    const internalRequest = mockHandleChat.mock.calls[0][0];
    expect(internalRequest.headers.get("Authorization")).toBeNull();
    expect(internalRequest.headers.get("x-api-key")).toBeNull();
  });

  it("strips stale raw Authorization gateway key before injecting internal key", async () => {
    const request = new Request("http://localhost:3456/api/dashboard/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "sk-badkeyyy",
      },
      body: JSON.stringify({ model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });

    await POST(request);
    const internalRequest = mockHandleChat.mock.calls[0][0];
    expect(internalRequest.headers.get("Authorization")).toBe("Bearer sk-internal-test");
    expect(internalRequest.headers.get("x-api-key")).toBeNull();
  });

  it("strips stale bearer when sk_genesis sentinel is already usable", async () => {
    const request = new Request("http://localhost:3456/api/dashboard/chat/completions", {
      method: "POST",
      headers: {
        Host: "localhost:3456",
        "Content-Type": "application/json",
        "x-api-key": "sk_genesis",
        Authorization: "Bearer sk-badkeyyy",
      },
      body: JSON.stringify({ model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });

    await POST(request);
    const internalRequest = mockHandleChat.mock.calls[0][0];
    expect(internalRequest.headers.get("x-api-key")).toBe("sk_genesis");
    expect(internalRequest.headers.get("Authorization")).toBeNull();
    expect(mockGetApiKeys).not.toHaveBeenCalled();
  });

  it("strips orphaned stale x-api-key when valid Bearer is already present", async () => {
    const userKey = makeTestApiKey();
    mockValidateApiKey.mockImplementation(async (key) => key === userKey);

    const request = new Request("http://localhost:3456/api/dashboard/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userKey}`,
        "x-api-key": "sk-badkeyyy",
      },
      body: JSON.stringify({ model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });

    await POST(request);
    const internalRequest = mockHandleChat.mock.calls[0][0];
    expect(internalRequest.headers.get("Authorization")).toBe(`Bearer ${userKey}`);
    expect(internalRequest.headers.get("x-api-key")).toBeNull();
    expect(mockGetApiKeys).not.toHaveBeenCalled();
  });

  it("preserves sk_genesis sentinel without injecting internal key", async () => {
    const request = new Request("http://localhost:3456/api/dashboard/chat/completions", {
      method: "POST",
      headers: {
        Host: "localhost:3456",
        "Content-Type": "application/json",
        Authorization: "Bearer sk_genesis",
      },
      body: JSON.stringify({ model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });

    await POST(request);
    const internalRequest = mockHandleChat.mock.calls[0][0];
    expect(internalRequest.headers.get("Authorization")).toBe("Bearer sk_genesis");
    expect(mockGetApiKeys).not.toHaveBeenCalled();
  });

  it("does not inject on loopback when settings are unavailable (default requireApiKey off)", async () => {
    mockGetSettings.mockRejectedValue(new Error("db unavailable"));
    const request = new Request("http://localhost:3456/api/dashboard/chat/completions", {
      method: "POST",
      headers: {
        Host: "localhost:3456",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });

    await POST(request);
    const internalRequest = mockHandleChat.mock.calls[0][0];
    expect(internalRequest.headers.get("Authorization")).toBeNull();
    expect(mockGetApiKeys).not.toHaveBeenCalled();
  });

  it("injects internal key on remote host when sk_genesis sentinel is present", async () => {
    mockGetSettings.mockResolvedValue({ requireApiKey: false });
    const request = new Request("https://router.example.com/api/dashboard/chat/completions", {
      method: "POST",
      headers: {
        Host: "router.example.com",
        "Content-Type": "application/json",
        Authorization: "Bearer sk_genesis",
      },
      body: JSON.stringify({ model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });

    await POST(request);
    const internalRequest = mockHandleChat.mock.calls[0][0];
    expect(internalRequest.headers.get("Authorization")).toBe("Bearer sk-internal-test");
    expect(mockGetApiKeys).toHaveBeenCalled();
  });

  it("injects internal key on remote host when requireApiKey=false", async () => {
    mockGetSettings.mockResolvedValue({ requireApiKey: false });
    const request = new Request("https://router.example.com/api/dashboard/chat/completions", {
      method: "POST",
      headers: {
        Host: "router.example.com",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });

    await POST(request);
    const internalRequest = mockHandleChat.mock.calls[0][0];
    expect(internalRequest.headers.get("Authorization")).toBe("Bearer sk-internal-test");
    expect(mockGetApiKeys).toHaveBeenCalled();
  });

  it("strips gateway-shaped api-key vendor header when injecting internal key", async () => {
    const request = new Request("http://localhost:3456/api/dashboard/chat/completions", {
      method: "POST",
      headers: {
        Host: "router.example.com",
        "Content-Type": "application/json",
        "api-key": "sk-badkeyyy",
      },
      body: JSON.stringify({ model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });

    await POST(request);
    const internalRequest = mockHandleChat.mock.calls[0][0];
    expect(internalRequest.headers.get("api-key")).toBeNull();
    expect(internalRequest.headers.get("Authorization")).toBe("Bearer sk-internal-test");
  });

  it("still injects gateway key when only provider x-api-key is present", async () => {
    const request = new Request("http://localhost:3456/api/dashboard/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "sk-ant-api03-provider-only",
      },
      body: JSON.stringify({ model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });

    await POST(request);
    const internalRequest = mockHandleChat.mock.calls[0][0];
    expect(internalRequest.headers.get("Authorization")).toBe("Bearer sk-internal-test");
  });
});
