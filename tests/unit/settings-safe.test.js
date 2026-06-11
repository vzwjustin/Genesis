import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("@/lib/db/driver.js", () => ({
  getAdapter: vi.fn(async () => ({
    get: mocks.get,
  })),
}));

const { getSettings, getSettingsSafe } = await import("../../src/lib/db/repos/settingsRepo.js");

describe("getSettingsSafe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns merged defaults when the DB adapter is unavailable", async () => {
    const { getAdapter } = await import("../../src/lib/db/driver.js");
    getAdapter.mockRejectedValueOnce(new Error("db unavailable"));

    const settings = await getSettingsSafe();
    expect(settings.requireApiKey).toBe(false);
    expect(settings.requireLogin).toBe(true);
    expect(settings.comboStrategy).toBe("fallback");
  });

  it("matches getSettings when the DB is healthy", async () => {
    mocks.get.mockReturnValue({
      data: JSON.stringify({ requireApiKey: true, requireLogin: false }),
    });

    const [safe, direct] = await Promise.all([getSettingsSafe(), getSettings()]);
    expect(safe).toEqual(direct);
    expect(safe.requireApiKey).toBe(true);
    expect(safe.requireLogin).toBe(false);
  });
});
