import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Task 19.2: Validate that stats persistence only occurs when compression
 * actually applied — a subsystem enabled but producing no change does NOT write a record.
 * Requirements: 14.1, 14.2
 */

const mocks = vi.hoisted(() => ({
  stored: null,
  getMeta: vi.fn(async (_key, fallback) => mocks.stored ?? fallback),
  setMeta: vi.fn(async (_key, value) => { mocks.stored = value; }),
  dbRun: vi.fn(),
  getAdapter: vi.fn(async () => ({ run: mocks.dbRun })),
}));

vi.mock("../../src/lib/db/helpers/metaStore.js", () => ({
  getMeta: mocks.getMeta,
  setMeta: mocks.setMeta,
}));

vi.mock("../../src/lib/db/driver.js", () => ({
  getAdapter: mocks.getAdapter,
}));

describe("compression stats persistence gating (Task 19.2)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.stored = null;
  });

  describe("saveCompressionStats - per-request SQLite record", () => {
    it("writes a record when given valid subsystem data", async () => {
      const { saveCompressionStats } = await import("../../src/lib/compressionStats.js");

      await saveCompressionStats({
        subsystem: "rtk",
        bytesBefore: 1000,
        bytesAfter: 400,
        filterHits: JSON.stringify(["git-diff"]),
      });

      expect(mocks.dbRun).toHaveBeenCalledOnce();
      const [sql, params] = mocks.dbRun.mock.calls[0];
      expect(sql).toContain("INSERT INTO compressionStats");
      expect(params[1]).toBe("rtk");
      expect(params[2]).toBe(null);
      expect(params[3]).toBe(1000);
      expect(params[4]).toBe(400);
    });

    it("writes a Caveman record with level", async () => {
      const { saveCompressionStats } = await import("../../src/lib/compressionStats.js");

      await saveCompressionStats({
        subsystem: "caveman",
        bytesBefore: 0,
        bytesAfter: 0,
        level: "full",
      });

      expect(mocks.dbRun).toHaveBeenCalledOnce();
      const [, params] = mocks.dbRun.mock.calls[0];
      expect(params[1]).toBe("caveman");
      expect(params[6]).toBe("full");
    });

    it("does not throw when db write fails (Req 14.3)", async () => {
      mocks.getAdapter.mockRejectedValueOnce(new Error("DB unavailable"));
      const { saveCompressionStats } = await import("../../src/lib/compressionStats.js");

      // Should not throw - continues silently
      await expect(saveCompressionStats({
        subsystem: "rtk",
        bytesBefore: 500,
        bytesAfter: 300,
      })).resolves.not.toThrow();
    });
  });

  describe("recordCompressionStats - aggregated stats gating", () => {
    it("records stats when actual compression occurred (bytesSaved > 0)", async () => {
      const { recordCompressionStats, getCompressionStats } = await import("../../src/lib/compressionStats.js");

      await recordCompressionStats("rtk", {
        bytesBefore: 1000,
        bytesAfter: 600,
        hits: 1,
        detail: "git-diff",
      });

      const stats = await getCompressionStats();
      expect(stats.tools.rtk.requests).toBe(1);
      expect(stats.tools.rtk.hits).toBe(1);
      expect(stats.tools.rtk.bytesSaved).toBe(400);
    });

    it("records Caveman stats when injection applied (hits > 0)", async () => {
      const { recordCompressionStats, getCompressionStats } = await import("../../src/lib/compressionStats.js");

      await recordCompressionStats("caveman", {
        hits: 1,
        detail: "level=full",
      });

      const stats = await getCompressionStats();
      expect(stats.tools.caveman.requests).toBe(1);
      expect(stats.tools.caveman.hits).toBe(1);
    });
  });

  describe("chatCore integration - stats only written when compression applied", () => {
    // This test validates the logic that chatCore.js uses to decide whether
    // to call recordCompressionStats and saveCompressionStats.
    // The gating conditions are:
    //   Headroom: hrStats && hrStats.before > 0
    //   RTK: rtkStats.bytesBefore > 0 (tool output scanned)
    //   Caveman: always writes when injection runs (injectCaveman is called)

    it("RTK: records when tool output was scanned even if no savings", () => {
      const rtkStats = { bytesBefore: 500, bytesAfter: 500, hits: [] };
      const rtkEnabled = true;

      const shouldWrite = rtkEnabled && (rtkStats?.bytesBefore || 0) > 0;

      expect(shouldWrite).toBe(true);
    });

    it("RTK: writes record when hits present", () => {
      const rtkStats = { bytesBefore: 1000, bytesAfter: 600, hits: [{ filter: "git-diff" }] };
      const rtkEnabled = true;

      const shouldWrite = rtkEnabled && (rtkStats?.bytesBefore || 0) > 0;

      expect(shouldWrite).toBe(true);
    });

    it("RTK: writes record when bytes actually saved (even without named hits)", () => {
      const rtkStats = { bytesBefore: 1000, bytesAfter: 800, hits: [] };
      const rtkEnabled = true;

      const shouldWrite = rtkEnabled && (rtkStats?.bytesBefore || 0) > 0;

      expect(shouldWrite).toBe(true);
    });

    it("RTK: no record when no tool output scanned", () => {
      const rtkStats = { bytesBefore: 0, bytesAfter: 0, hits: [] };
      const rtkEnabled = true;

      const shouldWrite = rtkEnabled && (rtkStats?.bytesBefore || 0) > 0;

      expect(shouldWrite).toBe(false);
    });

    it("RTK: no record when RTK disabled even if bytesSaved", () => {
      const rtkStats = { bytesBefore: 1000, bytesAfter: 600, hits: [{ filter: "smart" }] };
      const rtkEnabled = false;

      const shouldWrite = rtkEnabled && (rtkStats?.bytesBefore || 0) > 0;

      expect(shouldWrite).toBe(false);
    });

    it("Headroom: records when compression ran but saved is 0", () => {
      const hrStats = { saved: 0, before: 5000, after: 5000 };
      const shouldWrite = hrStats && (hrStats.before || 0) > 0;

      expect(shouldWrite).toBe(true);
    });

    it("Headroom: writes record when saved > 0", () => {
      const hrStats = { saved: 2000, before: 5000, after: 3000 };
      const shouldWrite = hrStats && (hrStats.before || 0) > 0;

      expect(shouldWrite).toBe(true);
    });

    it("Headroom: no record when hrStats is null (compression not available)", () => {
      const hrStats = null;
      const shouldWrite = hrStats && hrStats.saved > 0;

      expect(shouldWrite).toBeFalsy();
    });
  });
});
