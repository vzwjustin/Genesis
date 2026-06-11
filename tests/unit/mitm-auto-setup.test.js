import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = {
  getSettings: vi.fn(),
  getApiKeys: vi.fn(),
  getMitmStatus: vi.fn(),
  startServer: vi.fn(),
  enableToolDNS: vi.fn(),
  loadEncryptedPassword: vi.fn(),
  getCachedPassword: vi.fn(),
  hasDnsPrivilege: vi.fn(),
  initDbHooks: vi.fn(),
  getMitmAlias: vi.fn(),
  setMitmAliasAll: vi.fn(),
  writeAliasForTool: vi.fn(),
};

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  getApiKeys: mocks.getApiKeys,
  updateSettings: vi.fn(),
}));

vi.mock("@/mitm/manager", () => ({
  getMitmStatus: mocks.getMitmStatus,
  startServer: mocks.startServer,
  enableToolDNS: mocks.enableToolDNS,
  loadEncryptedPassword: mocks.loadEncryptedPassword,
  getCachedPassword: mocks.getCachedPassword,
  hasDnsPrivilege: mocks.hasDnsPrivilege,
  initDbHooks: mocks.initDbHooks,
}));

vi.mock("@/models", () => ({
  getMitmAlias: mocks.getMitmAlias,
  setMitmAliasAll: mocks.setMitmAliasAll,
}));

vi.mock("@/lib/mitmAliasCache", () => ({
  writeAliasForTool: mocks.writeAliasForTool,
}));

describe("autoSetupMitmForProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ mitmAutoSetupOnImport: true });
    mocks.getApiKeys.mockResolvedValue([{ key: "sk_test", isActive: true }]);
    mocks.getMitmStatus.mockResolvedValue({ running: false, dnsStatus: {} });
    mocks.startServer.mockResolvedValue({ running: true, pid: 123 });
    mocks.enableToolDNS.mockResolvedValue({ success: true });
    mocks.loadEncryptedPassword.mockResolvedValue("pw");
    mocks.getCachedPassword.mockReturnValue(null);
    mocks.hasDnsPrivilege.mockResolvedValue(true);
    mocks.getMitmAlias.mockResolvedValue({});
    mocks.setMitmAliasAll.mockResolvedValue(undefined);
  });

  it("auto-enables cursor MITM when privileged", async () => {
    const { autoSetupMitmForProvider } = await import("../../src/lib/mitm/autoSetupForProvider.js");
    const result = await autoSetupMitmForProvider("cursor");

    expect(result.success).toBe(true);
    expect(result.tool).toBe("cursor");
    expect(mocks.startServer).toHaveBeenCalled();
    expect(mocks.enableToolDNS).toHaveBeenCalledWith("cursor", "pw");
  });

  it("auto-enables kiro MITM when privileged", async () => {
    const { autoSetupMitmForProvider } = await import("../../src/lib/mitm/autoSetupForProvider.js");
    const result = await autoSetupMitmForProvider("kiro");

    expect(result.success).toBe(true);
    expect(result.tool).toBe("kiro");
    expect(mocks.startServer).toHaveBeenCalledWith("sk_test", "pw", false);
    expect(mocks.enableToolDNS).toHaveBeenCalledWith("kiro", "pw");
    expect(mocks.setMitmAliasAll).toHaveBeenCalled();
    expect(mocks.writeAliasForTool).toHaveBeenCalledWith("kiro", expect.any(Object));
  });

  it("returns needs_privilege when sudo/admin is unavailable", async () => {
    mocks.hasDnsPrivilege.mockResolvedValue(false);

    const { autoSetupMitmForProvider } = await import("../../src/lib/mitm/autoSetupForProvider.js");
    const result = await autoSetupMitmForProvider("kiro");

    expect(result.success).toBe(false);
    expect(result.reason).toBe("needs_privilege");
    expect(mocks.startServer).not.toHaveBeenCalled();
  });

  it("respects mitmAutoSetupOnImport=false", async () => {
    mocks.getSettings.mockResolvedValue({ mitmAutoSetupOnImport: false });

    const { autoSetupMitmForProvider } = await import("../../src/lib/mitm/autoSetupForProvider.js");
    const result = await autoSetupMitmForProvider("kiro");

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("disabled_by_setting");
  });
});
