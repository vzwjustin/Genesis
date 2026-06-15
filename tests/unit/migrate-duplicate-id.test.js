// Regression: legacy JSON import must not abort on duplicate ids.
// The source db.json can carry two rows with the same id (e.g. a re-saved
// connection). INSERT OR REPLACE collapses them to one row by design; the
// row-count assertion must expect DISTINCT successful ids, not raw rows.length,
// or the whole migration rolls back and the user is stranded on JSON storage.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "genesis-dupid-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("legacy JSON import — duplicate ids", () => {
  it("collapses duplicate-id rows instead of aborting the migration", async () => {
    // Two providerConnections share id "c1" — INSERT OR REPLACE keeps the last.
    fs.writeFileSync(path.join(tempDir, "db.json"), JSON.stringify({
      providerConnections: [
        { id: "c1", provider: "openai", name: "first", authType: "key" },
        { id: "c1", provider: "openai", name: "second", authType: "key" },
        { id: "c2", provider: "anthropic", name: "other", authType: "key" },
      ],
    }));

    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    // Migration must have completed (marker written), not aborted.
    expect(fs.existsSync(path.join(tempDir, "db", ".migrated-from-json"))).toBe(true);

    const rows = db.all(`SELECT id, name FROM providerConnections ORDER BY id`);
    expect(rows.map((r) => r.id)).toEqual(["c1", "c2"]);
    // Last write wins for the duplicate id.
    expect(rows.find((r) => r.id === "c1").name).toBe("second");
  });

  it("still imports cleanly when all ids are unique", async () => {
    fs.writeFileSync(path.join(tempDir, "db.json"), JSON.stringify({
      providerConnections: [
        { id: "a", provider: "openai", name: "a", authType: "key" },
        { id: "b", provider: "openai", name: "b", authType: "key" },
      ],
    }));

    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    expect(fs.existsSync(path.join(tempDir, "db", ".migrated-from-json"))).toBe(true);
    expect(db.all(`SELECT id FROM providerConnections ORDER BY id`).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("aborts instead of importing a null primary key from malformed legacy rows", async () => {
    fs.writeFileSync(path.join(tempDir, "db.json"), JSON.stringify({
      providerConnections: [
        { provider: "openai", name: "missing-id", authType: "key" },
      ],
    }));

    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    expect(fs.existsSync(path.join(tempDir, "db", ".migrated-from-json"))).toBe(false);
    expect(db.all(`SELECT id FROM providerConnections`)).toEqual([]);
  });
});
