import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const validateRoutePath = join(root, "../../src/app/api/providers/validate/route.js");

const proxyAwareFetchMock = vi.hoisted(() => vi.fn());

vi.mock("@/models", () => ({
  getProviderNodeById: vi.fn(),
}));

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => proxyAwareFetchMock(...args),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
}));

vi.mock("@/lib/auth/spawnRouteAuth", () => ({
  requireSpawnRouteAuth: vi.fn(async () => ({ ok: true })),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => new Response(JSON.stringify(body), {
      status: init?.status ?? 200,
      headers: { "Content-Type": "application/json" },
    }),
  },
}));

function jsonRequest(body) {
  return new Request("https://genesis.local/api/providers/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("provider validate Google API auth (source)", () => {
  it("gemini, vertex, and vertex-partner do not put API keys in probe URLs", () => {
    const src = readFileSync(validateRoutePath, "utf8");
    const geminiBlock = src.slice(src.indexOf('case "gemini"'), src.indexOf('case "openrouter"'));
    const vertexBlock = src.slice(src.indexOf('case "vertex"'), src.indexOf('case "grok-web"'));

    expect(geminiBlock).toContain('"x-goog-api-key": apiKey');
    expect(geminiBlock).not.toMatch(/\?key=\$\{apiKey\}/);

    expect(vertexBlock).toContain('"x-goog-api-key": apiKey');
    expect(vertexBlock).not.toMatch(/\?key=\$\{apiKey\}/);
  });
});

describe("provider validate Google API auth (runtime)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    proxyAwareFetchMock.mockReset();
  });

  it("gemini validation sends x-goog-api-key header without key query param", async () => {
    proxyAwareFetchMock.mockResolvedValue({ ok: true, status: 200 });

    const { POST } = await import("../../src/app/api/providers/validate/route.js");
    const res = await POST(jsonRequest({ provider: "gemini", apiKey: "AIzaSy-test-key" }));
    const body = await res.json();

    expect(body.valid).toBe(true);
    expect(proxyAwareFetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = proxyAwareFetchMock.mock.calls[0];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1/models");
    expect(url).not.toContain("key=");
    expect(init.headers["x-goog-api-key"]).toBe("AIzaSy-test-key");
  });

  it("vertex raw-key validation sends x-goog-api-key header without key query param", async () => {
    proxyAwareFetchMock.mockResolvedValue({ ok: false, status: 404 });

    const { POST } = await import("../../src/app/api/providers/validate/route.js");
    const res = await POST(jsonRequest({ provider: "vertex", apiKey: "AIzaSy-vertex-key" }));
    const body = await res.json();

    expect(body.valid).toBe(true);
    const [url, init] = proxyAwareFetchMock.mock.calls[0];
    expect(url).toBe("https://aiplatform.googleapis.com/v1/publishers/google/models/__probe__:generateContent");
    expect(url).not.toContain("key=");
    expect(init.method).toBe("POST");
    expect(init.headers["x-goog-api-key"]).toBe("AIzaSy-vertex-key");
  });

  it("vertex-partner raw-key validation sends x-goog-api-key header without key query param", async () => {
    proxyAwareFetchMock.mockResolvedValue({ ok: false, status: 404 });

    const { POST } = await import("../../src/app/api/providers/validate/route.js");
    const res = await POST(jsonRequest({ provider: "vertex-partner", apiKey: "AIzaSy-partner-key" }));
    const body = await res.json();

    expect(body.valid).toBe(true);
    const [url, init] = proxyAwareFetchMock.mock.calls[0];
    expect(url).toBe("https://aiplatform.googleapis.com/v1/publishers/google/models/__probe__:generateContent");
    expect(url).not.toContain("key=");
    expect(init.headers["x-goog-api-key"]).toBe("AIzaSy-partner-key");
  });

  it("vertex service-account JSON skips outbound probe fetch", async () => {
    const saJson = JSON.stringify({
      type: "service_account",
      client_email: "svc@test.iam.gserviceaccount.com",
      private_key: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n",
      project_id: "test-project",
    });

    const { POST } = await import("../../src/app/api/providers/validate/route.js");
    const res = await POST(jsonRequest({ provider: "vertex", apiKey: saJson }));
    const body = await res.json();

    expect(body.valid).toBe(true);
    expect(proxyAwareFetchMock).not.toHaveBeenCalled();
  });
});
