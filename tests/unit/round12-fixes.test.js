/**
 * Round 12 bug-hunt regression tests — proxy migration for token refresh,
 * project ID fetch, image prefetch, and headroom probes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const proxyAwareFetch = vi.hoisted(() => vi.fn());

vi.mock("../../open-sse/utils/proxyFetch.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    proxyAwareFetch: (...args) => proxyAwareFetch(...args),
  };
});

describe("tokenRefresh proxy migration", () => {
  beforeEach(() => {
    vi.resetModules();
    proxyAwareFetch.mockReset();
  });

  it("refreshCodexToken forwards proxyOptions to proxyAwareFetch", async () => {
    proxyAwareFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "new-access",
        refresh_token: "rotated",
        expires_in: 3600,
      }),
    });

    const { refreshCodexToken, __clearRefreshDedupCacheForTests } = await import(
      "../../open-sse/services/tokenRefresh.js"
    );
    __clearRefreshDedupCacheForTests();

    const proxyOptions = { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy:8080" };
    const result = await refreshCodexToken("old-refresh", null, proxyOptions);

    expect(result?.accessToken).toBe("new-access");
    expect(proxyAwareFetch).toHaveBeenCalled();
    expect(proxyAwareFetch.mock.calls[0][2]).toBe(proxyOptions);
  });

  it("refreshTokenByProvider derives proxyOptions from credentials when omitted", async () => {
    proxyAwareFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "google-access",
        expires_in: 3600,
      }),
    });

    const { refreshTokenByProvider, __clearRefreshDedupCacheForTests } = await import(
      "../../open-sse/services/tokenRefresh.js"
    );
    __clearRefreshDedupCacheForTests();

    await refreshTokenByProvider(
      "gemini-cli",
      {
        refreshToken: "rt",
        providerSpecificData: {
          connectionProxyEnabled: true,
          connectionProxyUrl: "http://conn-proxy:3128",
        },
      },
      null
    );

    expect(proxyAwareFetch).toHaveBeenCalled();
    const passedProxy = proxyAwareFetch.mock.calls[0][2];
    expect(passedProxy.connectionProxyEnabled).toBe(true);
    expect(passedProxy.connectionProxyUrl).toBe("http://conn-proxy:3128");
  });
});

describe("projectId proxy migration", () => {
  beforeEach(() => {
    vi.resetModules();
    proxyAwareFetch.mockReset();
  });

  it("getProjectIdForConnection uses proxyAwareFetch", async () => {
    proxyAwareFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        cloudaicompanionProject: { id: "real-project-123" },
      }),
    });

    const { getProjectIdForConnection } = await import("../../open-sse/services/projectId.js");
    const proxyOptions = { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy:8080" };
    const projectId = await getProjectIdForConnection("conn-1", "access-token", proxyOptions);

    expect(projectId).toBe("real-project-123");
    expect(proxyAwareFetch).toHaveBeenCalled();
    expect(proxyAwareFetch.mock.calls[0][2]).toBe(proxyOptions);
  });
});

describe("fetchImageAsBase64 proxy migration", () => {
  beforeEach(() => {
    proxyAwareFetch.mockReset();
  });

  it("forwards proxyOptions to proxyAwareFetch", async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    proxyAwareFetch.mockResolvedValue({
      ok: true,
      headers: { get: () => "image/png" },
      arrayBuffer: async () => pngBytes.buffer,
    });

    const { fetchImageAsBase64 } = await import("../../open-sse/translator/helpers/imageHelper.js");
    const proxyOptions = { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy:8080" };
    const result = await fetchImageAsBase64("https://example.com/image.png", { proxyOptions });

    expect(result?.mimeType).toBe("image/png");
    expect(proxyAwareFetch).toHaveBeenCalledWith(
      "https://example.com/image.png",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
      proxyOptions
    );
  });
});
