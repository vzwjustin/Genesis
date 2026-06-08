import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const proxyAwareFetch = vi.hoisted(() => vi.fn());
const CACHE_KEY = "__9routerGitHubReleasesCache";

vi.mock("open-sse/utils/proxyFetch.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    proxyAwareFetch: (...args) => proxyAwareFetch(...args),
  };
});

describe("version API", () => {
  beforeEach(() => {
    vi.resetModules();
    proxyAwareFetch.mockReset();
    delete globalThis[CACHE_KEY];
    proxyAwareFetch.mockResolvedValue({
      ok: true,
      json: async () => [
        { tag_name: "v0.4.9", draft: false, prerelease: false },
        { tag_name: "v0.4.8", draft: false, prerelease: false },
      ],
    });
  });

  afterEach(() => {
    delete globalThis[CACHE_KEY];
  });

  it("checks latest version from the fork GitHub releases via proxyAwareFetch", async () => {
    const { GET } = await import("../../src/app/api/version/route.js");

    const response = await GET();
    const body = await response.json();

    expect(proxyAwareFetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/vzwjustin/9router/releases?per_page=30",
      expect.objectContaining({ headers: expect.objectContaining({ "User-Agent": "9Router" }) }),
    );
    expect(body).toEqual({
      currentVersion: "0.4.8",
      latestVersion: "0.4.9",
      hasUpdate: true,
    });
  });
});
