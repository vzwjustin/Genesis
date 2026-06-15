import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const modelMocks = vi.hoisted(() => ({
  createProviderNode: vi.fn(async (node) => node),
  getProviderNodes: vi.fn(async () => []),
  getProviderNodeById: vi.fn(),
  updateProviderNode: vi.fn(async (id, updates) => ({ id, ...updates })),
  getProviderConnections: vi.fn(async () => []),
  updateProviderConnection: vi.fn(async () => ({})),
  deleteProviderConnectionsByProvider: vi.fn(async () => undefined),
  deleteProviderNode: vi.fn(async () => undefined),
}));

const proxyAwareFetchMock = vi.hoisted(() => vi.fn());

vi.mock("@/models", () => modelMocks);

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => proxyAwareFetchMock(...args),
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

function jsonRequest(url, body) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("provider node baseUrl validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    proxyAwareFetchMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("rejects unsafe compatible-node baseUrl on create before DB write", async () => {
    const { POST } = await import("../../src/app/api/provider-nodes/route.js");

    const res = await POST(jsonRequest("https://genesis.local/api/provider-nodes", {
      name: "Localhost Node",
      prefix: "local",
      type: "openai-compatible",
      apiType: "chat",
      baseUrl: "https://127.0.0.1:11434/v1",
    }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Invalid base URL");
    expect(modelMocks.createProviderNode).not.toHaveBeenCalled();
  });

  it("rejects malformed create name before DB write", async () => {
    const { POST } = await import("../../src/app/api/provider-nodes/route.js");

    const res = await POST(jsonRequest("https://genesis.local/api/provider-nodes", {
      name: 42,
      prefix: "local",
      type: "openai-compatible",
      apiType: "chat",
      baseUrl: "https://api.example.com/v1",
    }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Name is required");
    expect(modelMocks.createProviderNode).not.toHaveBeenCalled();
  });

  it("normalizes and stores safe custom embedding baseUrl on create", async () => {
    const { POST } = await import("../../src/app/api/provider-nodes/route.js");

    const res = await POST(jsonRequest("https://genesis.local/api/provider-nodes", {
      name: "Embedding Node",
      prefix: "embed",
      type: "custom-embedding",
      baseUrl: "https://embedding.example.com/v1/embeddings/",
    }));

    expect(res.status).toBe(201);
    expect(modelMocks.createProviderNode).toHaveBeenCalledWith(expect.objectContaining({
      type: "custom-embedding",
      baseUrl: "https://embedding.example.com/v1",
    }));
  });

  it("normalizes a pasted /embeddings endpoint during provider-node validation", async () => {
    proxyAwareFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
    });

    const { POST } = await import("../../src/app/api/provider-nodes/validate/route.js");
    const res = await POST(jsonRequest("https://genesis.local/api/provider-nodes/validate", {
      baseUrl: "https://embedding.example.com/v1/embeddings/",
      apiKey: "sk-test",
      type: "custom-embedding",
      modelId: "embed-v1",
    }));

    expect(res.status).toBe(200);
    expect(proxyAwareFetchMock.mock.calls[0][0]).toBe("https://embedding.example.com/v1/embeddings");
  });

  it("rejects unsafe baseUrl during provider-node validation before fetch", async () => {
    const { POST } = await import("../../src/app/api/provider-nodes/validate/route.js");
    const res = await POST(jsonRequest("https://genesis.local/api/provider-nodes/validate", {
      baseUrl: "https://127.0.0.1:11434/v1",
      apiKey: "sk-test",
      type: "openai-compatible",
    }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Invalid URL format");
    expect(proxyAwareFetchMock).not.toHaveBeenCalled();
  });

  it("rejects unsafe compatible-node baseUrl on update before DB write", async () => {
    modelMocks.getProviderNodeById.mockResolvedValue({
      id: "anthropic-compatible-node",
      type: "anthropic-compatible",
      name: "Existing",
      prefix: "ac",
      baseUrl: "https://api.example.com/v1",
    });

    const { PUT } = await import("../../src/app/api/provider-nodes/[id]/route.js");
    const res = await PUT(jsonRequest("https://genesis.local/api/provider-nodes/anthropic-compatible-node", {
      name: "Existing",
      prefix: "ac",
      baseUrl: "https://metadata.google.internal/v1/messages",
    }), { params: Promise.resolve({ id: "anthropic-compatible-node" }) });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Invalid base URL");
    expect(modelMocks.updateProviderNode).not.toHaveBeenCalled();
    expect(modelMocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("rejects malformed update baseUrl before DB write", async () => {
    modelMocks.getProviderNodeById.mockResolvedValue({
      id: "openai-compatible-chat-node",
      type: "openai-compatible",
      name: "Existing",
      prefix: "oc",
      apiType: "chat",
      baseUrl: "https://api.example.com/v1",
    });

    const { PUT } = await import("../../src/app/api/provider-nodes/[id]/route.js");
    const res = await PUT(jsonRequest("https://genesis.local/api/provider-nodes/openai-compatible-chat-node", {
      name: "Existing",
      prefix: "oc",
      apiType: "chat",
      baseUrl: 42,
    }), { params: Promise.resolve({ id: "openai-compatible-chat-node" }) });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Invalid base URL");
    expect(modelMocks.updateProviderNode).not.toHaveBeenCalled();
    expect(modelMocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("rejects malformed update prefix before DB write", async () => {
    modelMocks.getProviderNodeById.mockResolvedValue({
      id: "openai-compatible-chat-node",
      type: "openai-compatible",
      name: "Existing",
      prefix: "oc",
      apiType: "chat",
      baseUrl: "https://api.example.com/v1",
    });

    const { PUT } = await import("../../src/app/api/provider-nodes/[id]/route.js");
    const res = await PUT(jsonRequest("https://genesis.local/api/provider-nodes/openai-compatible-chat-node", {
      name: "Existing",
      prefix: 42,
      apiType: "chat",
      baseUrl: "https://api.example.com/v1",
    }), { params: Promise.resolve({ id: "openai-compatible-chat-node" }) });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Prefix is required");
    expect(modelMocks.updateProviderNode).not.toHaveBeenCalled();
    expect(modelMocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("rejects unsafe stored node baseUrl during provider validation before outbound fetch", async () => {
    modelMocks.getProviderNodeById.mockResolvedValue({
      id: "openai-compatible-chat-node",
      type: "openai-compatible",
      name: "Stored Unsafe",
      prefix: "bad",
      apiType: "chat",
      baseUrl: "https://127.0.0.1:11434/v1",
    });

    const { POST } = await import("../../src/app/api/providers/validate/route.js");
    const res = await POST(jsonRequest("https://genesis.local/api/providers/validate", {
      provider: "openai-compatible-chat-node",
      apiKey: "sk-test",
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.valid).toBe(false);
    expect(body.error).toMatch(/not allowed|Invalid base URL/);
    expect(proxyAwareFetchMock).not.toHaveBeenCalled();
  });
});
