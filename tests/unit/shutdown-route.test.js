import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockHeadersGet = vi.fn();

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: mockHeadersGet,
  })),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => ({
      status: init?.status ?? 200,
      body,
    }),
  },
}));

const { POST } = await import("../../src/app/api/shutdown/route.js");

describe("shutdown API route", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv, NODE_ENV: "development", SHUTDOWN_SECRET: "dev-shutdown-secret" };
    mockHeadersGet.mockImplementation((name) => {
      if (name === "authorization") return "Bearer dev-shutdown-secret";
      return null;
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("accepts a valid shutdown bearer token in development", async () => {
    const response = await POST();
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });

  it("rejects missing authorization", async () => {
    mockHeadersGet.mockReturnValue(null);
    const response = await POST();
    expect(response.status).toBe(401);
  });

  it("accepts case-insensitive bearer scheme", async () => {
    mockHeadersGet.mockImplementation((name) => {
      if (name === "authorization") return "bearer dev-shutdown-secret";
      return null;
    });
    const response = await POST();
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });
});
