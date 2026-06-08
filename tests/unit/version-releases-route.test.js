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

describe("version releases API", () => {
  beforeEach(() => {
    vi.resetModules();
    proxyAwareFetch.mockReset();
    delete globalThis[CACHE_KEY];
    proxyAwareFetch.mockResolvedValue({
      ok: true,
      json: async () => [
        {
          tag_name: "v0.4.68",
          name: "v0.4.68",
          html_url: "https://github.com/vzwjustin/9router/releases/tag/v0.4.68",
          published_at: "2026-06-05T12:00:00Z",
          draft: false,
          prerelease: false,
        },
        {
          tag_name: "v0.4.65",
          name: "v0.4.65",
          html_url: "https://github.com/vzwjustin/9router/releases/tag/v0.4.65",
          published_at: "2026-06-01T12:00:00Z",
          draft: false,
          prerelease: false,
        },
        { tag_name: "draft-ignored", draft: true },
      ],
    });
  });

  afterEach(() => {
    delete globalThis[CACHE_KEY];
  });

  it("returns GitHub releases annotated for upgrade and downgrade installs", async () => {
    const { GET } = await import("../../src/app/api/version/releases/route.js");

    const response = await GET();
    const body = await response.json();

    expect(proxyAwareFetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/vzwjustin/9router/releases?per_page=30",
      expect.objectContaining({ headers: expect.objectContaining({ "User-Agent": "9Router" }) }),
    );
    expect(body.currentVersion).toBe("0.4.8");
    expect(body.releases.map((release) => release.version)).toEqual(["0.4.68", "0.4.65"]);
    expect(body.releases[0]).toMatchObject({
      direction: "upgrade",
      installCommand: "npm i -g github:vzwjustin/9router#v0.4.68 --prefer-online",
    });
    expect(body.releases[1]).toMatchObject({
      direction: "upgrade",
      installCommand: "npm i -g github:vzwjustin/9router#v0.4.65 --prefer-online",
    });
  });
});
