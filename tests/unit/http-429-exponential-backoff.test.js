/**
 * Unit tests for HTTP 429 handling: exponential backoff cooldown + retry next connection
 *
 * Requirement 4.1: WHEN the upstream provider returns HTTP 429, THE Proxy SHALL
 * place the current Connection into Cooldown with exponential backoff (starting
 * at 1s, doubling per consecutive failure) AND retry with the next available Connection.
 *
 * Validates:
 * 1. 429 triggers exponential backoff (starting at 1s, doubling per consecutive failure)
 * 2. The backoff is capped at max (BACKOFF_CONFIG.max = 5 minutes)
 * 3. The connection is marked unavailable for the cooldown duration
 * 4. The retry loop picks up the next connection (via shouldFallback = true)
 */
import { describe, it, expect } from "vitest";
import {
  getQuotaCooldown,
  checkFallbackError,
  isAccountUnavailable,
  getUnavailableUntil,
} from "../../open-sse/services/accountFallback.js";
import { BACKOFF_CONFIG } from "../../open-sse/config/errorConfig.js";

describe("HTTP 429 Exponential Backoff (Requirement 4.1)", () => {
  describe("getQuotaCooldown — backoff calculation", () => {
    it("starts at 1s for backoff level 1", () => {
      const cooldown = getQuotaCooldown(1);
      expect(cooldown).toBe(1000); // 1s
    });

    it("doubles to 2s for backoff level 2", () => {
      const cooldown = getQuotaCooldown(2);
      expect(cooldown).toBe(2000); // 2s
    });

    it("doubles to 4s for backoff level 3", () => {
      const cooldown = getQuotaCooldown(3);
      expect(cooldown).toBe(4000); // 4s
    });

    it("doubles to 8s for backoff level 4", () => {
      const cooldown = getQuotaCooldown(4);
      expect(cooldown).toBe(8000); // 8s
    });

    it("doubles to 16s for backoff level 5", () => {
      const cooldown = getQuotaCooldown(5);
      expect(cooldown).toBe(16000); // 16s
    });

    it("is capped at BACKOFF_CONFIG.max (5 minutes)", () => {
      // At high levels, should be capped
      const cooldown = getQuotaCooldown(15);
      expect(cooldown).toBe(BACKOFF_CONFIG.max);
      expect(cooldown).toBe(5 * 60 * 1000); // 5 minutes
    });

    it("returns base (1s) for backoff level 0", () => {
      // level 0 → Math.max(0, 0-1) = 0 → base * 2^0 = 1000
      const cooldown = getQuotaCooldown(0);
      expect(cooldown).toBe(1000);
    });

    it("follows exact doubling sequence: 1s, 2s, 4s, 8s, 16s, 32s, 64s, 128s, 256s...", () => {
      const expected = [1000, 1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000];
      for (let level = 0; level < expected.length; level++) {
        const cooldown = getQuotaCooldown(level);
        // Clamp to max
        const capped = Math.min(expected[level], BACKOFF_CONFIG.max);
        expect(cooldown).toBe(capped);
      }
    });
  });

  describe("checkFallbackError — 429 triggers backoff", () => {
    it("returns shouldFallback=true for HTTP 429", () => {
      const result = checkFallbackError(429, "", 0);
      expect(result.shouldFallback).toBe(true);
    });

    it("increments backoff level on 429", () => {
      const result = checkFallbackError(429, "", 0);
      expect(result.newBackoffLevel).toBe(1);
    });

    it("increments from current level on consecutive 429s", () => {
      const result1 = checkFallbackError(429, "", 0);
      expect(result1.newBackoffLevel).toBe(1);

      const result2 = checkFallbackError(429, "", 1);
      expect(result2.newBackoffLevel).toBe(2);

      const result3 = checkFallbackError(429, "", 2);
      expect(result3.newBackoffLevel).toBe(3);
    });

    it("caps backoff level at BACKOFF_CONFIG.maxLevel", () => {
      const result = checkFallbackError(429, "", BACKOFF_CONFIG.maxLevel);
      expect(result.newBackoffLevel).toBe(BACKOFF_CONFIG.maxLevel);
    });

    it("calculates cooldown matching getQuotaCooldown for the new level", () => {
      for (let level = 0; level < 5; level++) {
        const result = checkFallbackError(429, "", level);
        const expectedCooldown = getQuotaCooldown(result.newBackoffLevel);
        expect(result.cooldownMs).toBe(expectedCooldown);
      }
    });

    it("triggers backoff for 'rate limit' text even without 429 status", () => {
      const result = checkFallbackError(200, "Rate limit exceeded", 0);
      expect(result.shouldFallback).toBe(true);
      expect(result.newBackoffLevel).toBe(1);
    });

    it("triggers backoff for 'too many requests' text", () => {
      const result = checkFallbackError(200, "Too Many Requests", 0);
      expect(result.shouldFallback).toBe(true);
      expect(result.newBackoffLevel).toBe(1);
    });

    it("triggers backoff for 'quota exceeded' text", () => {
      const result = checkFallbackError(200, "Quota Exceeded - try again later", 0);
      expect(result.shouldFallback).toBe(true);
      expect(result.newBackoffLevel).toBe(1);
    });
  });

  describe("Connection marked unavailable for cooldown duration", () => {
    it("getUnavailableUntil produces a future timestamp by the cooldown amount", () => {
      const before = Date.now();
      const until = getUnavailableUntil(5000); // 5s cooldown
      const after = Date.now();

      const untilMs = new Date(until).getTime();
      expect(untilMs).toBeGreaterThanOrEqual(before + 5000);
      expect(untilMs).toBeLessThanOrEqual(after + 5000);
    });

    it("isAccountUnavailable returns true when within cooldown window", () => {
      const futureTime = new Date(Date.now() + 10000).toISOString();
      expect(isAccountUnavailable(futureTime)).toBe(true);
    });

    it("isAccountUnavailable returns false when cooldown has expired", () => {
      const pastTime = new Date(Date.now() - 1000).toISOString();
      expect(isAccountUnavailable(pastTime)).toBe(false);
    });

    it("isAccountUnavailable returns false for null", () => {
      expect(isAccountUnavailable(null)).toBe(false);
    });

    it("isAccountUnavailable returns false for undefined", () => {
      expect(isAccountUnavailable(undefined)).toBe(false);
    });
  });

  describe("Retry with next connection (shouldFallback flow)", () => {
    it("shouldFallback is true for 429 — enables retry loop to continue", () => {
      const result = checkFallbackError(429, "", 0);
      expect(result.shouldFallback).toBe(true);
      // The retry loop in chat.js adds the connection to excludeConnectionIds
      // and continues to the next iteration, which calls getProviderCredentials
      // again — picking up the next available connection
    });

    it("shouldFallback is false for 400 — no retry (client error)", () => {
      const result = checkFallbackError(400, "Bad request", 0);
      expect(result.shouldFallback).toBe(false);
    });

    it("shouldFallback is true for 5xx — enables transient retry", () => {
      const result = checkFallbackError(500, "Internal Server Error", 0);
      expect(result.shouldFallback).toBe(true);
    });
  });

  describe("BACKOFF_CONFIG values", () => {
    it("base is 1000ms (1 second)", () => {
      expect(BACKOFF_CONFIG.base).toBe(1000);
    });

    it("max is 300000ms (5 minutes)", () => {
      expect(BACKOFF_CONFIG.max).toBe(300000);
    });

    it("maxLevel is 15", () => {
      expect(BACKOFF_CONFIG.maxLevel).toBe(15);
    });
  });
});
