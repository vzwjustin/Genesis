import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

const mocks = {
  requireSpawnRouteAuth: vi.fn(async () => ({ ok: true })),
  statusGetter: vi.fn(),
};

vi.mock("@/lib/auth/spawnRouteAuth", () => ({
  requireSpawnRouteAuth: mocks.requireSpawnRouteAuth,
}));

vi.mock("../../src/app/api/cli-tools/claude-settings/route.js", () => ({ GET: mocks.statusGetter }));
vi.mock("../../src/app/api/cli-tools/codex-settings/route.js", () => ({ GET: mocks.statusGetter }));
vi.mock("../../src/app/api/cli-tools/opencode-settings/route.js", () => ({ GET: mocks.statusGetter }));
vi.mock("../../src/app/api/cli-tools/droid-settings/route.js", () => ({ GET: mocks.statusGetter }));
vi.mock("../../src/app/api/cli-tools/openclaw-settings/route.js", () => ({ GET: mocks.statusGetter }));
vi.mock("../../src/app/api/cli-tools/hermes-settings/route.js", () => ({ GET: mocks.statusGetter }));
vi.mock("../../src/app/api/cli-tools/cowork-settings/route.js", () => ({ GET: mocks.statusGetter }));
vi.mock("../../src/app/api/cli-tools/copilot-settings/route.js", () => ({ GET: mocks.statusGetter }));
vi.mock("../../src/app/api/cli-tools/cline-settings/route.js", () => ({ GET: mocks.statusGetter }));
vi.mock("../../src/app/api/cli-tools/kilo-settings/route.js", () => ({ GET: mocks.statusGetter }));
vi.mock("../../src/app/api/cli-tools/deepseek-tui-settings/route.js", () => ({ GET: mocks.statusGetter }));
vi.mock("../../src/app/api/cli-tools/jcode-settings/route.js", () => ({ GET: mocks.statusGetter }));

const TOOL_COUNT = 12;

describe("GET /api/cli-tools/all-statuses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireSpawnRouteAuth.mockResolvedValue({ ok: true });
    mocks.statusGetter.mockImplementation(async (request) => {
      if (!request) {
        throw new Error("request required");
      }
      return NextResponse.json({ installed: true, hasGenesis: true });
    });
  });

  it("forwards the incoming request to each tool status getter", async () => {
    const request = { cookies: { get: () => ({ value: "session" }) } };
    const { GET } = await import("../../src/app/api/cli-tools/all-statuses/route.js");

    const res = await GET(request);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(mocks.statusGetter).toHaveBeenCalledTimes(TOOL_COUNT);
    for (const call of mocks.statusGetter.mock.calls) {
      expect(call[0]).toBe(request);
    }
    expect(data.claude).toEqual({ installed: true, hasGenesis: true });
  });

  it("returns 401 when batch route auth fails", async () => {
    mocks.requireSpawnRouteAuth.mockResolvedValue({ ok: false, error: "Login required", status: 401 });
    const { GET } = await import("../../src/app/api/cli-tools/all-statuses/route.js");

    const res = await GET({ cookies: { get: () => null } });
    expect(res.status).toBe(401);
    expect(mocks.statusGetter).not.toHaveBeenCalled();
  });
});
