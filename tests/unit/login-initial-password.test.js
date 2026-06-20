import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettingsSafe: vi.fn(),
  cookies: vi.fn(),
  setDashboardAuthCookie: vi.fn(),
  isOidcConfigured: vi.fn(),
  checkLock: vi.fn(),
  recordFail: vi.fn(),
  recordSuccess: vi.fn(),
  getClientIp: vi.fn(),
  withLoginLock: vi.fn((_ip, fn) => fn()),
  isTunnelDashboardAccessDenied: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettingsSafe: mocks.getSettingsSafe,
}));

vi.mock("next/headers", () => ({
  cookies: mocks.cookies,
}));

vi.mock("@/lib/auth/dashboardSession", () => ({
  setDashboardAuthCookie: mocks.setDashboardAuthCookie,
}));

vi.mock("@/lib/auth/oidc", () => ({
  isOidcConfigured: mocks.isOidcConfigured,
}));

vi.mock("@/lib/auth/loginLimiter", () => ({
  checkLock: mocks.checkLock,
  recordFail: mocks.recordFail,
  recordSuccess: mocks.recordSuccess,
  getClientIp: mocks.getClientIp,
  withLoginLock: mocks.withLoginLock,
}));

vi.mock("@/shared/utils/tunnelRequest", () => ({
  isTunnelDashboardAccessDenied: mocks.isTunnelDashboardAccessDenied,
}));

function loginRequest(password) {
  return {
    headers: new Headers(),
    json: vi.fn(async () => ({ password })),
  };
}

describe("login INITIAL_PASSWORD fallback", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.INITIAL_PASSWORD;
    mocks.getSettingsSafe.mockResolvedValue({ password: null, authMode: "password" });
    mocks.cookies.mockResolvedValue({ set: vi.fn() });
    mocks.isOidcConfigured.mockReturnValue(false);
    mocks.checkLock.mockReturnValue({ locked: false });
    mocks.recordFail.mockReturnValue({ remainingBeforeLock: 4 });
    mocks.recordSuccess.mockReturnValue(undefined);
    mocks.getClientIp.mockReturnValue("127.0.0.1");
    mocks.isTunnelDashboardAccessDenied.mockReturnValue(false);
  });

  it("rejects the old shared default when INITIAL_PASSWORD is unset", async () => {
    const { POST } = await import("../../src/app/api/auth/login/route.js");

    const response = await POST(loginRequest("123456"));

    expect(response.status).toBe(401);
    expect(mocks.setDashboardAuthCookie).not.toHaveBeenCalled();
  });

  it("accepts an explicitly configured INITIAL_PASSWORD before setup", async () => {
    process.env.INITIAL_PASSWORD = "change-me";
    const { POST } = await import("../../src/app/api/auth/login/route.js");

    const response = await POST(loginRequest("change-me"));

    expect(response.status).toBe(200);
    expect(mocks.setDashboardAuthCookie).toHaveBeenCalledTimes(1);
  });
});
