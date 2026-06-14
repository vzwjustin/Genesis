import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";

// Isolate route logic from the auth gate: combos [id] PUT/DELETE call
// requireSpawnRouteAuth, which reads NextRequest `.cookies` (absent on the
// plain Request used here). Stub it so the comboStrategies lifecycle is tested.
vi.mock("@/lib/auth/spawnRouteAuth", () => ({
  requireSpawnRouteAuth: vi.fn(async () => ({ ok: true })),
}));

const originalDataDir = process.env.DATA_DIR;
let tempDir;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "genesis-dash-r5-"));
  process.env.DATA_DIR = tempDir;
  try { global._dbAdapter?.instance?.close?.(); } catch { /* ignore */ }
  delete global._dbAdapter;
  vi.resetModules();
  const db = await import("../../src/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch { /* ignore */ }
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("parseProxyLine IPv6 bracket notation", () => {
  it("parses [ipv6]:port:user:pass format", async () => {
    const { parseProxyLine } = await import("../../src/shared/utils/dashboardHelpers.js");
    const parsed = parseProxyLine("[2001:db8::1]:8080:alice:secret");
    expect(parsed.name).toBe("Imported [2001:db8::1]:8080");
    expect(parsed.proxyUrl).toContain("alice");
    expect(parsed.proxyUrl).toContain("[2001:db8::1]:8080");
  });

  it("still parses IPv4 host:port:user:pass", async () => {
    const { parseProxyLine } = await import("../../src/shared/utils/dashboardHelpers.js");
    const parsed = parseProxyLine("203.0.113.10:3128:user:pass");
    expect(parsed.name).toBe("Imported 203.0.113.10:3128");
    expect(parsed.proxyUrl).toContain("203.0.113.10:3128");
  });

  it("parses full URL with IPv6 brackets", async () => {
    const { parseProxyLine } = await import("../../src/shared/utils/dashboardHelpers.js");
    const parsed = parseProxyLine("http://user:pass@[::1]:8888");
    expect(parsed.proxyUrl).toContain("[::1]");
  });
});

describe("comboStrategies rename/delete patches", () => {
  it("migrates strategy from old combo name to new name", async () => {
    const { buildComboStrategyRenamePatch } = await import("../../src/shared/utils/dashboardHelpers.js");
    const strategies = { "old-combo": { fallbackStrategy: "round-robin" } };
    expect(buildComboStrategyRenamePatch("old-combo", "new-combo", strategies)).toEqual({
      "old-combo": null,
      "new-combo": { fallbackStrategy: "round-robin" },
    });
  });

  it("tombstones old name on rename when no strategy existed", async () => {
    const { buildComboStrategyRenamePatch } = await import("../../src/shared/utils/dashboardHelpers.js");
    expect(buildComboStrategyRenamePatch("old-combo", "new-combo", {})).toEqual({
      "old-combo": null,
    });
  });

  it("builds delete tombstone for combo name", async () => {
    const { buildComboStrategyDeletePatch } = await import("../../src/shared/utils/dashboardHelpers.js");
    expect(buildComboStrategyDeletePatch("my-combo")).toEqual({ "my-combo": null });
  });
});

describe("combos API route comboStrategies lifecycle", () => {
  beforeEach(async () => {
    const { getAdapter } = await import("../../src/lib/db/driver.js");
    const db = await getAdapter();
    db.run(`DELETE FROM combos`);
    db.run(`DELETE FROM settings`);
  });

  it("migrates comboStrategies when combo is renamed via PUT", async () => {
    const { createCombo } = await import("../../src/lib/db/index.js");
    const { updateSettings, getSettings } = await import("../../src/lib/db/repos/settingsRepo.js");
    const { PUT } = await import("../../src/app/api/combos/[id]/route.js");

    const combo = await createCombo({ name: "alpha", models: ["openai/gpt-4o"] });
    await updateSettings({
      comboStrategies: { alpha: { fallbackStrategy: "round-robin" } },
    });

    const req = new Request(`http://localhost/api/combos/${combo.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "beta" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: combo.id }) });
    expect(res.status).toBe(200);

    const settings = await getSettings();
    expect(settings.comboStrategies.alpha).toBeUndefined();
    expect(settings.comboStrategies.beta).toEqual({ fallbackStrategy: "round-robin" });
  });

  it("tombstones comboStrategies when combo is deleted", async () => {
    const { createCombo } = await import("../../src/lib/db/index.js");
    const { updateSettings, getSettings } = await import("../../src/lib/db/repos/settingsRepo.js");
    const { DELETE } = await import("../../src/app/api/combos/[id]/route.js");

    const combo = await createCombo({ name: "drop-me", models: ["openai/gpt-4o"] });
    await updateSettings({
      comboStrategies: { "drop-me": { fallbackStrategy: "round-robin" } },
    });

    const req = new Request(`http://localhost/api/combos/${combo.id}`, { method: "DELETE" });
    const res = await DELETE(req, { params: Promise.resolve({ id: combo.id }) });
    expect(res.status).toBe(200);

    const settings = await getSettings();
    expect(settings.comboStrategies["drop-me"]).toBeUndefined();
  });
});
