import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import * as fsPromises from "fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

// Importing the route transitively loads src/lib/dataDir.js, which runs
// fs.mkdirSync(DATA_DIR) at module load. os.homedir() is mocked to /mock/home
// below, so without an explicit DATA_DIR that init would try to create
// /mock/home/.9router (real fs) and throw, breaking the route import. Point
// DATA_DIR at a real, writable temp dir before any dynamic import runs.
const tmpBase = process.env.TMPDIR || process.env.TEMP || process.env.TMP || "/tmp";
const originalDataDir = process.env.DATA_DIR;
const tempDataDir = mkdtempSync(join(tmpBase, "9router-cursor-import-"));
process.env.DATA_DIR = tempDataDir;

const mockExecFile = vi.fn();

// Route is gated by requireSpawnRouteAuth(request). These tests call GET() with
// no request object, so the real auth helper would crash reading request.headers.
// Mock it to a pass-through — auth itself is covered by its own unit tests.
vi.mock("@/lib/auth/spawnRouteAuth", () => ({
  requireSpawnRouteAuth: vi.fn(async () => ({ ok: true })),
}));

vi.mock("child_process", () => ({
  execFile: (...args) => mockExecFile(...args),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body, init) => ({
      status: init?.status || 200,
      body,
      json: async () => body,
    })),
  },
}));

vi.mock("os", () => ({
  default: { homedir: vi.fn(() => "/mock/home") },
  homedir: vi.fn(() => "/mock/home"),
}));

vi.mock("fs/promises", () => ({
  access: vi.fn(),
  constants: { R_OK: 4 },
}));

const mockDbInstance = {
  prepare: vi.fn(),
  close: vi.fn(),
  __throwOnConstruct: false,
};

vi.mock("better-sqlite3", () => ({
  default: class MockDatabase {
    constructor() {
      if (mockDbInstance.__throwOnConstruct) {
        throw new Error("SQLITE_CANTOPEN");
      }
      return mockDbInstance;
    }
  },
}));

let GET;

function mockTokenRows(rowsByKey) {
  mockDbInstance.prepare.mockImplementation((sql) => {
    if (typeof sql === "string" && sql.includes("IN (")) {
      return {
        all: vi.fn((...keys) => keys
          .filter((key) => rowsByKey[key] !== undefined)
          .map((key) => ({ key, value: rowsByKey[key] }))),
      };
    }
    if (typeof sql === "string" && sql.includes("LIKE")) {
      return {
        all: vi.fn(() => Object.entries(rowsByKey).map(([key, value]) => ({ key, value }))),
      };
    }
    return {
      get: vi.fn((key) => {
        const value = rowsByKey[key];
        return value === undefined ? undefined : { value };
      }),
    };
  });
}

describe("GET /api/oauth/cursor/auto-import", () => {
  const originalPlatform = process.platform;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockDbInstance.__throwOnConstruct = false;
    mockExecFile.mockImplementation((file, args, options, callback) => {
      const cb = typeof options === "function" ? options : callback;
      process.nextTick(() => cb(new Error("sqlite3 unavailable")));
    });
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    const mod = await import("../../src/app/api/oauth/cursor/auto-import/route.js");
    GET = mod.GET;
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  });

  afterAll(() => {
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    try { rmSync(tempDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("returns not-found when no macOS cursor db paths are accessible", async () => {
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain("Cursor database not found");
  });

  it("returns manual fallback when db exists but tokens are missing", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    mockTokenRows({});

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain("Please login to Cursor IDE first");
    expect(response.body.dbPath).toBeUndefined();
  });

  it("extracts tokens using exact keys", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    mockTokenRows({
      "cursorAuth/accessToken": "test-token",
      "storage.serviceMachineId": "test-machine-id",
    });

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("test-token");
    expect(response.body.machineId).toBe("test-machine-id");
    expect(mockDbInstance.close).toHaveBeenCalled();
  });

  it("unwraps JSON-encoded string values", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    mockTokenRows({
      "cursorAuth/accessToken": '"json-token"',
      "storage.serviceMachineId": '"json-machine-id"',
    });

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("json-token");
    expect(response.body.machineId).toBe("json-machine-id");
  });

  it("falls back to alternate access token key", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    mockTokenRows({
      "cursorAuth/token": "fallback-token",
      "telemetry.machineId": "fallback-machine",
    });

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("fallback-token");
    expect(response.body.machineId).toBe("fallback-machine");
  });

  it("linux returns not-found when cursor db is inaccessible", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain("Cursor database not found");
  });

  it("unsupported platform still probes linux-style paths", async () => {
    Object.defineProperty(process, "platform", { value: "freebsd", writable: true });
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain("Cursor database not found");
  });
});
