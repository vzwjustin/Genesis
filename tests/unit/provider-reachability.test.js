import { describe, it, expect, beforeEach } from "vitest";
import { createProviderReachability } from "open-sse/utils/circuitBreaker.js";

describe("Provider Reachability Tracker", () => {
  let reachability;

  beforeEach(() => {
    reachability = createProviderReachability();
  });

  describe("recordReachable", () => {
    it("marks a new provider as reachable with null lastErrorAt", () => {
      reachability.recordReachable("claude");
      const all = reachability.getAll();
      expect(all.claude).toEqual({ reachable: true, lastErrorAt: null });
    });

    it("marks an existing unreachable provider as reachable without clearing lastErrorAt", () => {
      reachability.recordUnreachable("openai");
      const before = reachability.getAll();
      const errorTimestamp = before.openai.lastErrorAt;

      reachability.recordReachable("openai");
      const after = reachability.getAll();
      expect(after.openai.reachable).toBe(true);
      expect(after.openai.lastErrorAt).toBe(errorTimestamp);
    });
  });

  describe("recordUnreachable", () => {
    it("marks a new provider as unreachable with a lastErrorAt timestamp", () => {
      reachability.recordUnreachable("openai");
      const all = reachability.getAll();
      expect(all.openai.reachable).toBe(false);
      expect(all.openai.lastErrorAt).not.toBeNull();
      // Verify it's a valid ISO-8601 timestamp
      expect(new Date(all.openai.lastErrorAt).toISOString()).toBe(all.openai.lastErrorAt);
    });

    it("updates lastErrorAt on subsequent failures", () => {
      reachability.recordUnreachable("claude");
      const first = reachability.getAll().claude.lastErrorAt;

      // Small delay to get a different timestamp
      reachability.recordUnreachable("claude");
      const second = reachability.getAll().claude.lastErrorAt;

      expect(second).not.toBeNull();
      expect(new Date(second) >= new Date(first)).toBe(true);
    });
  });

  describe("getAll", () => {
    it("returns empty object when no providers tracked", () => {
      expect(reachability.getAll()).toEqual({});
    });

    it("returns all tracked providers", () => {
      reachability.recordReachable("claude");
      reachability.recordUnreachable("openai");
      reachability.recordReachable("gemini");

      const all = reachability.getAll();
      expect(Object.keys(all).sort()).toEqual(["claude", "gemini", "openai"]);
      expect(all.claude.reachable).toBe(true);
      expect(all.openai.reachable).toBe(false);
      expect(all.gemini.reachable).toBe(true);
    });

    it("returns a copy — mutations do not affect internal state", () => {
      reachability.recordReachable("claude");
      const all = reachability.getAll();
      all.claude.reachable = false;

      const fresh = reachability.getAll();
      expect(fresh.claude.reachable).toBe(true);
    });
  });

  describe("fail-open behavior", () => {
    it("recordReachable does not throw on invalid input", () => {
      expect(() => reachability.recordReachable(null)).not.toThrow();
      expect(() => reachability.recordReachable(undefined)).not.toThrow();
      expect(() => reachability.recordReachable(123)).not.toThrow();
    });

    it("recordUnreachable does not throw on invalid input", () => {
      expect(() => reachability.recordUnreachable(null)).not.toThrow();
      expect(() => reachability.recordUnreachable(undefined)).not.toThrow();
      expect(() => reachability.recordUnreachable({})).not.toThrow();
    });
  });
});
