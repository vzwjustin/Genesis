import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const authMocks = vi.hoisted(() => ({
  requireDashboardApiAuth: vi.fn(async () => ({ ok: true })),
}));

const settingsMocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  applyOutboundProxyEnv: vi.fn(),
  resetComboRotation: vi.fn(),
  compare: vi.fn(),
  genSalt: vi.fn(),
  hash: vi.fn(),
}));

const usageMocks = vi.hoisted(() => ({
  getUsageStats: vi.fn(async () => ({ totalRequests: 1 })),
  getUsageHistory: vi.fn(async () => [{ timestamp: "2026-01-01T00:00:00.000Z", model: "m" }]),
  getChartData: vi.fn(async () => []),
  getRecentLogs: vi.fn(async () => []),
  getRequestDetails: vi.fn(async () => ({ details: [], pagination: {} })),
  statsEmitter: { on: vi.fn(), off: vi.fn() },
}));

const routeAuthMocks = vi.hoisted(() => ({
  requireRouteAuth: vi.fn(async () => ({ ok: true })),
}));

const modelsMocks = vi.hoisted(() => ({
  buildModelsList: vi.fn(async () => []),
}));

vi.mock("@/lib/auth/dashboardApiAuth", async () => {
  const actual = await vi.importActual("@/lib/auth/dashboardApiAuth");
  return {
    ...actual,
    requireDashboardApiAuth: authMocks.requireDashboardApiAuth,
  };
});

vi.mock("@/lib/usageDb", () => usageMocks);

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

vi.mock("@/lib/security/exposureGate", () => ({
  isRemoteExposureRequest: () => false,
  isRemoteExposureActive: () => false,
  getRemoteExposureBlockReason: () => null,
}));

vi.mock("@/sse/utils/routeAuth.js", () => ({
  requireRouteAuth: routeAuthMocks.requireRouteAuth,
}));

vi.mock("../../src/app/api/v1/models/route.js", () => ({
  buildModelsList: modelsMocks.buildModelsList,
  ModelsDbError: class ModelsDbError extends Error {
    constructor(message) {
      super(message);
      this.name = "ModelsDbError";
    }
  },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => ({ status: init?.status || 200, body }),
  },
}));

describe("wave4 — usage API dashboard auth", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    authMocks.requireDashboardApiAuth.mockResolvedValue({ ok: true });
  });

  it("returns 401 from stats route when dashboard auth fails", async () => {
    authMocks.requireDashboardApiAuth.mockResolvedValue({
      ok: false,
      response: { status: 401, body: { error: "Unauthorized" } },
    });
    const { GET } = await import("../../src/app/api/usage/stats/route.js");
    const response = await GET({ url: "http://localhost/api/usage/stats" });
    expect(response.status).toBe(401);
  });

  it("history route calls getUsageHistory with limit", async () => {
    const { GET } = await import("../../src/app/api/usage/history/route.js");
    const response = await GET({ url: "http://localhost/api/usage/history?limit=100" });
    expect(response.status).toBe(200);
    expect(usageMocks.getUsageHistory).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
    expect(response.body.history).toBeDefined();
  });

  it("history route rejects invalid startDate", async () => {
    const { GET } = await import("../../src/app/api/usage/history/route.js");
    const response = await GET({ url: "http://localhost/api/usage/history?startDate=not-a-date" });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Invalid startDate");
  });
});

describe("wave4 — settings auth and password reset", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    authMocks.requireDashboardApiAuth.mockResolvedValue({ ok: true });
    settingsMocks.getSettings.mockResolvedValue({ password: "$2a$hash", requireLogin: true });
    settingsMocks.updateSettings.mockImplementation(async (body) => ({ ...body }));
    settingsMocks.compare.mockResolvedValue(true);
  });

  it("GET settings requires dashboard auth", async () => {
    authMocks.requireDashboardApiAuth.mockResolvedValue({
      ok: false,
      response: { status: 401, body: { error: "Unauthorized" } },
    });
    const { GET } = await import("../../src/app/api/settings/route.js");
    const response = await GET({ url: "http://localhost/api/settings" });
    expect(response.status).toBe(401);
  });

  it("strips raw password from PATCH body before validation", async () => {
    const { PATCH } = await import("../../src/app/api/settings/route.js");
    const response = await PATCH({
      json: vi.fn(async () => ({ password: "plaintext", fallbackStrategy: "round-robin" })),
    });
    expect(response.status).toBe(200);
    expect(settingsMocks.updateSettings).toHaveBeenCalledWith({ fallbackStrategy: "round-robin" });
  });
});

describe("wave4 — models kind and STT inference", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    routeAuthMocks.requireRouteAuth.mockResolvedValue({ ok: true });
  });

  it("unknown model kind returns 400", async () => {
    const { GET } = await import("../../src/app/api/v1/models/[kind]/route.js");
    const response = await GET(
      { url: "http://localhost/v1/models/unknown" },
      { params: Promise.resolve({ kind: "unknown" }) },
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("inferKindFromUnknownModelId includes whisper/asr/transcri patterns", () => {
    const src = fs.readFileSync(
      path.join(repoRoot, "src/app/api/v1/models/route.js"),
      "utf8",
    );
    expect(src).toMatch(/whisper\|asr\|transcri/);
  });
});

describe("wave4 — usageRepo totals and bounds", () => {
  const originalDataDir = process.env.DATA_DIR;
  let tempDir;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "genesis-wave4-usage-"));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    const sqliteDb = await import("@/lib/db/index.js");
    await sqliteDb.initDb();
  });

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("counts totalRequests including null-provider rows in 24h stats", async () => {
    const sqliteDb = await import("@/lib/db/index.js");
    await sqliteDb.saveRequestUsage({
      provider: null,
      model: "whisper-1",
      tokens: { input_tokens: 10, output_tokens: 5 },
      status: "ok",
    });
    await sqliteDb.saveRequestUsage({
      provider: "openai",
      model: "gpt-4o",
      tokens: { prompt_tokens: 20, completion_tokens: 10 },
      status: "ok",
    });

    const stats = await sqliteDb.getUsageStats("24h");
    expect(stats.totalRequests).toBe(2);
    expect(stats.byProvider.unknown).toBeDefined();
    expect(stats.byProvider.unknown.requests).toBe(1);
  });

  it("getUsageHistory rejects invalid dates", async () => {
    const sqliteDb = await import("@/lib/db/index.js");
    await expect(sqliteDb.getUsageHistory({ startDate: "bad-date" })).rejects.toThrow("Invalid startDate");
  });

  it("getUsageHistory defaults to bounded limit", async () => {
    const sqliteDb = await import("@/lib/db/index.js");
    for (let i = 0; i < 3; i++) {
      await sqliteDb.saveRequestUsage({
        provider: "openai",
        model: "gpt-4o",
        tokens: { prompt_tokens: 1, completion_tokens: 1 },
        status: "ok",
      });
    }
    const history = await sqliteDb.getUsageHistory({ limit: 2 });
    expect(history.length).toBe(2);
    const bounded = await sqliteDb.getUsageHistory({});
    expect(bounded.length).toBeLessThanOrEqual(500);
  });

  it("getProviderCacheStats bounds all-period scan", async () => {
    const sqliteDb = await import("@/lib/db/index.js");
    await sqliteDb.saveRequestUsage({
      provider: "anthropic",
      model: "claude-sonnet-4.6",
      tokens: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 },
      status: "ok",
    });
    const stats = await sqliteDb.getProviderCacheStats("all");
    expect(stats.requests).toBeGreaterThanOrEqual(1);
  });
});

describe("wave4 — request-details pagination guard", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    authMocks.requireDashboardApiAuth.mockResolvedValue({ ok: true });
  });

  it("rejects page above cap", async () => {
    const { GET } = await import("../../src/app/api/usage/request-details/route.js");
    const response = await GET({ url: "http://localhost/api/usage/request-details?page=10001" });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/Page must be <=/);
  });
});

describe("wave4 — STT/TTS handler signal and validation", () => {
  it("STT handler passes signal to handleSttCore on noAuth path", () => {
    const src = fs.readFileSync(path.join(repoRoot, "src/sse/handlers/stt.js"), "utf8");
    expect(src).toMatch(/handleSttCore\(\{[^}]*signal/s);
  });

  it("TTS handler validates input is a string", () => {
    const src = fs.readFileSync(path.join(repoRoot, "src/sse/handlers/tts.js"), "utf8");
    expect(src).toContain("input must be a string");
  });

  it("chat handler logs after auth check", () => {
    const src = fs.readFileSync(path.join(repoRoot, "src/sse/handlers/chat.js"), "utf8");
    const authIdx = src.indexOf("authenticateRequest(request, log)");
    const logIdx = src.indexOf('log.request("POST"');
    expect(authIdx).toBeGreaterThan(-1);
    expect(logIdx).toBeGreaterThan(authIdx);
  });
});
