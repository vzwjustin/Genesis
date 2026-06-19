import { describe, it, expect, vi } from "vitest";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";
import { isUnrecoverableRefreshError } from "../../open-sse/services/tokenRefresh.js";
import {
  withLoginLock,
  checkLock,
  recordFail,
  recordSuccess,
} from "../../src/lib/auth/loginLimiter.js";

describe("checkFallbackError 4xx default", () => {
  it("does not fall back on unmatched client errors", () => {
    expect(checkFallbackError(418, "no matching error rule")).toEqual({
      shouldFallback: false,
      cooldownMs: 0,
    });
    expect(checkFallbackError(418, "other client error")).toEqual({
      shouldFallback: false,
      cooldownMs: 0,
    });
  });

  it("still falls back on unmatched 5xx", () => {
    const r = checkFallbackError(502, "bad gateway");
    expect(r.shouldFallback).toBe(true);
    expect(r.cooldownMs).toBeGreaterThan(0);
  });
});

describe("isUnrecoverableRefreshError", () => {
  it("flags permanent OAuth refresh failures", () => {
    expect(isUnrecoverableRefreshError({ error: "unrecoverable_refresh_error" })).toBe(true);
    expect(isUnrecoverableRefreshError({ error: "invalid_grant" })).toBe(true);
    expect(isUnrecoverableRefreshError(null)).toBeFalsy();
    expect(isUnrecoverableRefreshError({ error: "network" })).toBe(false);
  });
});

describe("withLoginLock TOCTOU", () => {
  it("serializes concurrent checkLock + recordFail for same IP", async () => {
    const ip = `test-${Date.now()}`;
    recordSuccess(ip);

    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        withLoginLock(ip, async () => {
          const before = checkLock(ip);
          if (!before.locked) recordFail(ip);
          return checkLock(ip);
        }),
      ),
    );

    const lockedCount = results.filter((r) => r.locked).length;
    expect(lockedCount).toBeGreaterThan(0);
    recordSuccess(ip);
  });
});
