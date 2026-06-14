import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { deriveSessionId, clearSessionStore } from "../../open-sse/utils/sessionManager.js";

describe("deriveSessionId LRU eviction", () => {
  beforeEach(() => {
    clearSessionStore();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearSessionStore();
  });

  it("returns a stable id for the same connection", () => {
    const a = deriveSessionId("conn-1");
    const b = deriveSessionId("conn-1");
    expect(a).toBe(b);
  });

  it("evicts the least-recently-used entry, not the oldest-inserted", () => {
    // Fill to the cap (1000). Entry 0 is inserted first (FIFO would evict it),
    // but we touch it last so LRU must keep it and evict a stale middle entry.
    for (let i = 0; i < 1000; i++) {
      vi.setSystemTime(1000 + i);
      deriveSessionId(`conn-${i}`);
    }

    // Touch conn-0 so it becomes most-recently-used.
    vi.setSystemTime(100000);
    const conn0Id = deriveSessionId("conn-0");

    // Insert a new connection → triggers one eviction (size was at cap).
    vi.setSystemTime(100001);
    deriveSessionId("conn-new");

    // conn-0 must survive (it was most-recently-used). conn-1 (now the stalest)
    // is the LRU victim, so requesting it again yields a NEW id.
    vi.setSystemTime(100002);
    expect(deriveSessionId("conn-0")).toBe(conn0Id);
  });
});
