import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  compare: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
}));

vi.mock("bcryptjs", () => ({
  default: {
    compare: mocks.compare,
  },
}));

describe("dashboard password sensitive actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    delete process.env.INITIAL_PASSWORD;
  });

  it("verifyDashboardPasswordForSensitiveAction rejects when no password is configured", async () => {
    mocks.getSettings.mockResolvedValue({});
    const { verifyDashboardPasswordForSensitiveAction } = await import(
      "../../src/lib/auth/dashboardSession.js"
    );

    await expect(verifyDashboardPasswordForSensitiveAction("123456")).resolves.toBe(false);
    expect(mocks.compare).not.toHaveBeenCalled();
  });

  it("verifyDashboardPasswordForSensitiveAction does not accept INITIAL_PASSWORD fallback", async () => {
    process.env.INITIAL_PASSWORD = "change-me";
    mocks.getSettings.mockResolvedValue({});
    const { verifyDashboardPasswordForSensitiveAction } = await import(
      "../../src/lib/auth/dashboardSession.js"
    );

    await expect(verifyDashboardPasswordForSensitiveAction("change-me")).resolves.toBe(false);
    expect(mocks.compare).not.toHaveBeenCalled();
  });

  it("verifyDashboardPasswordForSensitiveAction verifies stored bcrypt hash only", async () => {
    mocks.getSettings.mockResolvedValue({ password: "hashed-password" });
    mocks.compare.mockResolvedValue(true);
    const { verifyDashboardPasswordForSensitiveAction } = await import(
      "../../src/lib/auth/dashboardSession.js"
    );

    await expect(verifyDashboardPasswordForSensitiveAction("my-password")).resolves.toBe(true);
    expect(mocks.compare).toHaveBeenCalledWith("my-password", "hashed-password");
  });

  it("verifyDashboardPassword still accepts INITIAL_PASSWORD when no hash is stored", async () => {
    process.env.INITIAL_PASSWORD = "change-me";
    mocks.getSettings.mockResolvedValue({});
    const { verifyDashboardPassword } = await import("../../src/lib/auth/dashboardSession.js");

    await expect(verifyDashboardPassword("change-me")).resolves.toBe(true);
    await expect(verifyDashboardPassword("wrong")).resolves.toBe(false);
  });
});
