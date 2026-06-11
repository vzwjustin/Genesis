import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

const { proxyAwareFetch } = await import("open-sse/utils/proxyFetch.js");
const { DefaultExecutor } = await import("../../open-sse/executors/default.js");

describe("DefaultExecutor.refreshCline", () => {
  let logSpy;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("does not log refresh tokens or response payloads", async () => {
    proxyAwareFetch.mockResolvedValue(new Response(JSON.stringify({
      data: {
        accessToken: "access-secret",
        refreshToken: "refresh-secret",
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
    }), { status: 200 }));

    const executor = new DefaultExecutor("cline");
    const result = await executor.refreshCline("refresh-secret");

    expect(result?.accessToken).toBe("access-secret");
    expect(logSpy).not.toHaveBeenCalled();
  });
});
