/**
 * Compression stats failure continuation (Tasks 19.3–19.4)
 * Requirements: 14.3, 14.4
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getMeta: vi.fn(async () => null),
  setMeta: vi.fn(async () => {}),
  getAdapter: vi.fn(async () => ({ run: vi.fn() })),
}));

vi.mock("../../src/lib/db/helpers/metaStore.js", () => ({
  getMeta: mocks.getMeta,
  setMeta: mocks.setMeta,
}));

vi.mock("../../src/lib/db/driver.js", () => ({
  getAdapter: mocks.getAdapter,
}));

describe("compression stats never stop request path (Task 19.3–19.4)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.setMeta.mockRejectedValue(new Error("DB down"));
  });

  it("recordCompressionStats returns stats without throwing when persistence fails", async () => {
    const { recordCompressionStats } = await import("../../src/lib/compressionStats.js");
    await expect(recordCompressionStats("rtk", { bytesBefore: 100, bytesAfter: 50, hits: 1 }))
      .resolves.toBeDefined();
  });

  it("saveCompressionStats does not throw when DB unavailable", async () => {
    mocks.getAdapter.mockRejectedValueOnce(new Error("DB unavailable"));
    const { saveCompressionStats } = await import("../../src/lib/compressionStats.js");
    await expect(saveCompressionStats({ subsystem: "rtk", bytesBefore: 1, bytesAfter: 1 }))
      .resolves.toBeUndefined();
  });
});
