import { describe, it, expect, vi, beforeEach } from "vitest";

const mockHandleChat = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
const mockGetSettings = vi.fn(async () => ({ requireApiKey: true }));
const mockGetApiKeys = vi.fn(async () => [{ key: "sk-internal-test", isActive: true }]);

vi.mock("@/sse/handlers/chat.js", () => ({
  handleChat: (...args) => mockHandleChat(...args),
}));

vi.mock("open-sse/translator/index.js", () => ({
  initTranslators: vi.fn(async () => {}),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: (...args) => mockGetSettings(...args),
  getApiKeys: (...args) => mockGetApiKeys(...args),
}));

const { POST } = await import("../../src/app/api/dashboard/chat/completions/route.js");

describe("dashboard chat completions route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSettings.mockResolvedValue({ requireApiKey: true });
    mockGetApiKeys.mockResolvedValue([{ key: "sk-internal-test", isActive: true }]);
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
});
