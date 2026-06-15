import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireSpawnRouteAuth: vi.fn(),
  initConsoleLogCapture: vi.fn(),
  getConsoleLogs: vi.fn(() => []),
  getConsoleEmitter: vi.fn(() => ({ on: vi.fn(), off: vi.fn() })),
}));

vi.mock("@/lib/auth/spawnRouteAuth", () => ({
  requireSpawnRouteAuth: mocks.requireSpawnRouteAuth,
}));

vi.mock("@/lib/consoleLogBuffer", () => ({
  initConsoleLogCapture: mocks.initConsoleLogCapture,
  getConsoleLogs: mocks.getConsoleLogs,
  getConsoleEmitter: mocks.getConsoleEmitter,
}));

const { GET } = await import("../../src/app/api/translator/console-logs/stream/route.js");

describe("translator console log stream auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects unauthenticated stream clients before exposing buffered logs", async () => {
    mocks.requireSpawnRouteAuth.mockResolvedValue({ ok: false, error: "Login required", status: 401 });

    const response = await GET(new Request("http://localhost/api/translator/console-logs/stream"));

    expect(response.status).toBe(401);
    expect(mocks.getConsoleLogs).not.toHaveBeenCalled();
    expect(mocks.getConsoleEmitter).not.toHaveBeenCalled();
  });
});
