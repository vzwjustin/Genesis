/**
 * Unit tests for HTTP 401/403 immediate fallback (no cooldown).
 *
 * Requirement 4.3: WHEN the upstream provider returns HTTP 401 or 403
 * and token refresh fails, THE Proxy SHALL trigger immediate Account_Fallback
 * rather than entering Cooldown.
 *
 * This means:
 * - shouldFallback = true (triggers retry with next connection)
 * - cooldownMs = 0 (no cooldown period applied)
 */
import { describe, it, expect } from "vitest";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

describe("HTTP 401/403 immediate fallback (Requirement 4.3)", () => {
  it("401 triggers immediate fallback with shouldFallback=true", () => {
    const result = checkFallbackError(401, "Unauthorized", 0);
    expect(result.shouldFallback).toBe(true);
  });

  it("401 applies no cooldown (cooldownMs=0)", () => {
    const result = checkFallbackError(401, "Unauthorized", 0);
    expect(result.cooldownMs).toBe(0);
  });

  it("403 triggers immediate fallback with shouldFallback=true", () => {
    const result = checkFallbackError(403, "Forbidden", 0);
    expect(result.shouldFallback).toBe(true);
  });

  it("403 applies no cooldown (cooldownMs=0)", () => {
    const result = checkFallbackError(403, "Forbidden", 0);
    expect(result.cooldownMs).toBe(0);
  });

  it("401 does not increment backoff level", () => {
    const result = checkFallbackError(401, "Invalid credentials", 3);
    // No newBackoffLevel should be set (no backoff for auth errors)
    expect(result.newBackoffLevel).toBeUndefined();
  });

  it("403 does not increment backoff level", () => {
    const result = checkFallbackError(403, "Insufficient quota", 5);
    expect(result.newBackoffLevel).toBeUndefined();
  });

  it("401 with empty error text still triggers immediate fallback", () => {
    const result = checkFallbackError(401, "", 0);
    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBe(0);
  });

  it("403 with empty error text still triggers immediate fallback", () => {
    const result = checkFallbackError(403, "", 0);
    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBe(0);
  });

  it("429 still uses backoff (not immediate fallback) for comparison", () => {
    const result = checkFallbackError(429, "Rate limited", 0);
    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBeGreaterThan(0);
  });

  it("500 still uses transient cooldown (not immediate fallback) for comparison", () => {
    const result = checkFallbackError(500, "Internal error", 0);
    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBeGreaterThan(0);
  });
});
