import { beforeEach, describe, expect, it, vi } from "vitest";

const originalFetch = global.fetch;

describe("version API", () => {
  beforeEach(() => {
    vi.resetModules();
    global.fetch = vi.fn(async () => new Response(JSON.stringify([
      {
        tag_name: "v0.4.9",
        draft: false,
        prerelease: false,
      },
      {
        tag_name: "v0.4.8",
        draft: false,
        prerelease: false,
      },
    ]), { status: 200 }));
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("checks latest version from the fork GitHub releases", async () => {
    const { GET } = await import("../../src/app/api/version/route.js");

    const response = await GET();
    const body = await response.json();

    expect(global.fetch).toHaveBeenCalledWith(
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
