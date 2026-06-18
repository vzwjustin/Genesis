import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const require = createRequire(import.meta.url);

const settingsMocks = vi.hoisted(() => ({
  json: vi.fn((body, init) => ({ status: init?.status || 200, body })),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  applyOutboundProxyEnv: vi.fn(),
  resetComboRotation: vi.fn(),
  hash: vi.fn(),
  genSalt: vi.fn(),
  compare: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: settingsMocks.json },
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: settingsMocks.getSettings,
  updateSettings: settingsMocks.updateSettings,
}));

vi.mock("@/lib/network/outboundProxy", () => ({
  applyOutboundProxyEnv: settingsMocks.applyOutboundProxyEnv,
}));

vi.mock("open-sse/services/combo.js", () => ({
  resetComboRotation: settingsMocks.resetComboRotation,
}));

vi.mock("bcryptjs", () => ({
  default: {
    genSalt: settingsMocks.genSalt,
    hash: settingsMocks.hash,
    compare: settingsMocks.compare,
  },
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: () => ({ value: "session-token" }),
  })),
}));

vi.mock("@/lib/auth/dashboardSession", () => ({
  getDashboardAuthSession: vi.fn(async () => ({ sub: "user" })),
}));

vi.mock("@/lib/security/exposureGate", () => ({
  isRemoteExposureRequest: () => false,
  isRemoteExposureActive: () => false,
  getRemoteExposureBlockReason: () => null,
}));

const mitmDnsMocks = vi.hoisted(() => ({
  removeAllDNSEntries: vi.fn(async () => {}),
  removeDNSEntry: vi.fn(),
  addDNSEntry: vi.fn(),
  removeAllDNSEntriesSync: vi.fn(),
  checkAllDNSStatus: vi.fn(() => ({})),
  TOOL_HOSTS: { cursor: ["api2.cursor.sh"] },
  isSudoAvailable: vi.fn(() => false),
  isSudoPasswordRequired: vi.fn(() => false),
}));

vi.mock("../../src/mitm/dns/dnsConfig", () => mitmDnsMocks);

function settingsRequest(body) {
  return { json: vi.fn(async () => body) };
}

describe("wave2 — settings resetPasswordToDefault", () => {
  let PATCH;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    ({ PATCH } = await import("../../src/app/api/settings/route.js"));
    settingsMocks.getSettings.mockResolvedValue({ password: "$2a$hash", requireLogin: true });
    settingsMocks.updateSettings.mockImplementation(async (body) => ({ ...body }));
  });

  it("accepts PATCH { resetPasswordToDefault: true } with current password and clears password", async () => {
    settingsMocks.compare.mockResolvedValue(true);
    const response = await PATCH(settingsRequest({ resetPasswordToDefault: true, currentPassword: "old" }));

    expect(response.status).toBe(200);
    expect(settingsMocks.compare).toHaveBeenCalledWith("old", "$2a$hash");
    expect(settingsMocks.updateSettings).toHaveBeenCalledWith({ password: null });
  });

  it("rejects resetPasswordToDefault without current password when hash exists", async () => {
    const response = await PATCH(settingsRequest({ resetPasswordToDefault: true }));

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Current password required");
    expect(settingsMocks.updateSettings).not.toHaveBeenCalled();
  });

  it("silently strips raw password field from PATCH body", async () => {
    const response = await PATCH(settingsRequest({ password: "plaintext", fallbackStrategy: "round-robin" }));

    expect(response.status).toBe(200);
    expect(settingsMocks.updateSettings).toHaveBeenCalledWith({ fallbackStrategy: "round-robin" });
  });
});

describe("wave2 — usageRepo input_tokens in 24h stats", () => {
  const originalDataDir = process.env.DATA_DIR;
  let tempDir;
  let sqliteDb;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "genesis-wave2-usage-"));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    sqliteDb = await import("@/lib/db/index.js");
    await sqliteDb.initDb();
  });

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("aggregates input_tokens and output_tokens from usageHistory JSON for 24h", async () => {
    await sqliteDb.saveRequestUsage({
      provider: "anthropic",
      model: "claude-sonnet-4.6",
      connectionId: "conn-1",
      tokens: { input_tokens: 120, output_tokens: 30 },
      endpoint: "/v1/messages",
      status: "ok",
    });
    await sqliteDb.saveRequestUsage({
      provider: "anthropic",
      model: "claude-sonnet-4.6",
      connectionId: "conn-1",
      tokens: { input_tokens: 80, output_tokens: 20 },
      endpoint: "/v1/messages",
      status: "ok",
    });

    const stats = await sqliteDb.getUsageStats("24h");

    expect(stats.byProvider.anthropic).toBeDefined();
    expect(stats.byProvider.anthropic.promptTokens).toBe(200);
    expect(stats.byProvider.anthropic.completionTokens).toBe(50);
  });
});

const mitmRouteMocks = vi.hoisted(() => ({
  json: vi.fn((body, init) => ({ status: init?.status || 200, body })),
  getMitmStatus: vi.fn(),
  trustCert: vi.fn(),
  enableToolDNS: vi.fn(),
  disableToolDNS: vi.fn(),
  getCachedPassword: vi.fn(() => "cached"),
  loadEncryptedPassword: vi.fn(async () => null),
  setCachedPassword: vi.fn(),
  isSudoPasswordRequired: vi.fn(() => false),
  initDbHooks: vi.fn(),
  getSettings: vi.fn(async () => ({})),
  updateSettings: vi.fn(),
}));

vi.mock("@/lib/auth/spawnRouteAuth", () => ({
  requireSpawnRouteAuth: vi.fn(async () => ({ ok: true })),
}));

describe("wave2 — antigravity-mitm PATCH trust-cert", () => {
  let PATCH;

  beforeEach(async () => {
    vi.resetModules();
    mitmRouteMocks.getMitmStatus.mockResolvedValue({ certTrusted: true });
    mitmRouteMocks.trustCert.mockResolvedValue(undefined);

    vi.doMock("next/server", () => ({
      NextResponse: { json: mitmRouteMocks.json },
    }));
    vi.doMock("@/mitm/manager", () => ({
      getMitmStatus: mitmRouteMocks.getMitmStatus,
      trustCert: mitmRouteMocks.trustCert,
      enableToolDNS: mitmRouteMocks.enableToolDNS,
      disableToolDNS: mitmRouteMocks.disableToolDNS,
      getCachedPassword: mitmRouteMocks.getCachedPassword,
      loadEncryptedPassword: mitmRouteMocks.loadEncryptedPassword,
      setCachedPassword: mitmRouteMocks.setCachedPassword,
      isSudoPasswordRequired: mitmRouteMocks.isSudoPasswordRequired,
      initDbHooks: mitmRouteMocks.initDbHooks,
      startServer: vi.fn(),
      stopServer: vi.fn(),
    }));
    vi.doMock("@/lib/localDb", () => ({
      getSettings: mitmRouteMocks.getSettings,
      updateSettings: mitmRouteMocks.updateSettings,
    }));

    ({ PATCH } = await import("../../src/app/api/cli-tools/antigravity-mitm/route.js"));
  });

  it("accepts trust-cert without tool", async () => {
    const response = await PATCH({
      json: async () => ({ action: "trust-cert", sudoPassword: "pw" }),
    });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.certTrusted).toBe(true);
    expect(mitmRouteMocks.trustCert).toHaveBeenCalledWith("pw");
  });

  it("still requires tool for DNS enable", async () => {
    const response = await PATCH({
      json: async () => ({ action: "enable" }),
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("tool required");
    expect(mitmRouteMocks.enableToolDNS).not.toHaveBeenCalled();
  });
});

describe("wave2 — MITM stopServer DNS cleanup finally", () => {
  const originalDataDir = process.env.DATA_DIR;
  let tempDir;
  let manager;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "genesis-wave2-mitm-"));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    mitmDnsMocks.removeAllDNSEntries.mockReset();
    mitmDnsMocks.removeAllDNSEntries.mockRejectedValue(new Error("DNS cleanup failed"));
    manager = require("../../src/mitm/manager.js");
    manager.initDbHooks(
      async () => ({}),
      async () => ({}),
    );
  });

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("returns stopped state from stopServer", async () => {
    const result = await manager.stopServer("pw");

    expect(result).toEqual({ running: false, pid: null });
  });

  it("wraps stopServer DNS cleanup in try/finally for mitmIsRestarting reset", () => {
    const src = fs.readFileSync(
      path.join(import.meta.dirname, "..", "..", "src", "mitm", "manager.js"),
      "utf8",
    );
    const stopIdx = src.indexOf("async function stopServer");
    const stopBody = src.slice(stopIdx, stopIdx + 5000);
    expect(stopBody).toMatch(/try\s*\{[\s\S]*removeAllDNSEntries/);
    expect(stopBody).toMatch(/finally\s*\{[\s\S]*mitmIsRestarting\s*=\s*false/);
  });
});
