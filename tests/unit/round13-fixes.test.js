/**
 * Round 13 bug-hunt regression tests
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const proxyAwareFetch = vi.hoisted(() => vi.fn());

vi.mock("open-sse/utils/proxyFetch.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    proxyAwareFetch: (...args) => proxyAwareFetch(...args),
  };
});

describe("xAI refresh proxy forwarding", () => {
  beforeEach(() => {
    vi.resetModules();
    proxyAwareFetch.mockReset();
  });

  it("refreshTokenByProvider forwards proxyOptions to XaiService.refreshAccessToken", async () => {
    const refreshSpy = vi.fn().mockResolvedValue({
      access_token: "new-access",
      refresh_token: "rotated",
      expires_in: 900,
    });

    vi.doMock("../../src/lib/oauth/services/xai.js", () => ({
      XaiService: class {
        refreshAccessToken = refreshSpy;
      },
    }));

    const { refreshTokenByProvider, __clearRefreshDedupCacheForTests } = await import(
      "../../open-sse/services/tokenRefresh.js"
    );
    __clearRefreshDedupCacheForTests();

    const proxyOptions = { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy:8080" };
    await refreshTokenByProvider("xai", { refreshToken: "rt" }, null, proxyOptions);

    expect(refreshSpy).toHaveBeenCalledWith("rt", proxyOptions);

    vi.doUnmock("../../src/lib/oauth/services/xai.js");
  });
});

