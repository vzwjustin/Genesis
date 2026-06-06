/**
 * Unit tests for cooldown wait with minimum 1-second retry delay.
 *
 * Requirement 3.4: IF all Connections for a provider are in Cooldown,
 * THEN THE Proxy SHALL wait until the earliest Cooldown reset time AND retry;
 * THE Proxy SHALL enforce a minimum retry delay of 1 second regardless of
 * calculated Cooldown reset times.
 *
 * AGENTS.md: Never suggest an immediate retry when the provider is still
 * unavailable. Recommended minimum: Retry-After: 1. Do not return
 * Retry-After: 0 for a no-capacity state.
 */
import { describe, it, expect } from "vitest";
import { unavailableResponse } from "../../open-sse/utils/error.js";
import { MIN_RETRY_DELAY_MS } from "../../open-sse/config/errorConfig.js";

describe("Cooldown retry delay enforcement (Requirement 3.4)", () => {
  it("exports MIN_RETRY_DELAY_MS = 1000", () => {
    expect(MIN_RETRY_DELAY_MS).toBe(1000);
  });

  it("never returns Retry-After: 0 when cooldown timestamp is in the past", () => {
    // Simulate a cooldown that already expired (timestamp in the past)
    const pastTimestamp = new Date(Date.now() - 5000).toISOString();
    const response = unavailableResponse(503, "All accounts unavailable", pastTimestamp, "reset after 0s");

    const retryAfter = parseInt(response.headers.get("Retry-After"), 10);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
  });

  it("never returns Retry-After: 0 when cooldown timestamp is exactly now", () => {
    const nowTimestamp = new Date().toISOString();
    const response = unavailableResponse(503, "All accounts unavailable", nowTimestamp, "reset after 0s");

    const retryAfter = parseInt(response.headers.get("Retry-After"), 10);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
  });

  it("returns correct Retry-After when cooldown is in the future", () => {
    // 30 seconds from now
    const futureTimestamp = new Date(Date.now() + 30000).toISOString();
    const response = unavailableResponse(503, "Rate limited", futureTimestamp, "reset after 30s");

    const retryAfter = parseInt(response.headers.get("Retry-After"), 10);
    // Should be approximately 30 (could be 29 or 30 depending on timing)
    expect(retryAfter).toBeGreaterThanOrEqual(29);
    expect(retryAfter).toBeLessThanOrEqual(31);
  });

  it("returns fallback of 60 seconds for invalid/unparseable timestamps", () => {
    const response = unavailableResponse(503, "Error", "not-a-date", "unknown");

    const retryAfter = parseInt(response.headers.get("Retry-After"), 10);
    expect(retryAfter).toBe(60);
  });

  it("enforces minimum 1 second even when cooldown is 1ms in the future", () => {
    // Cooldown almost expired: only 1ms from now
    const almostNow = new Date(Date.now() + 1).toISOString();
    const response = unavailableResponse(429, "Rate limited", almostNow, "reset after 0s");

    const retryAfter = parseInt(response.headers.get("Retry-After"), 10);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
  });

  it("includes error message with retry info in response body", async () => {
    const futureTimestamp = new Date(Date.now() + 10000).toISOString();
    const response = unavailableResponse(503, "[claude/opus] Rate limited", futureTimestamp, "reset after 10s");

    const body = await response.json();
    expect(body.error.message).toContain("[claude/opus] Rate limited");
    expect(body.error.message).toContain("reset after 10s");
  });

  it("preserves status code in response", () => {
    const futureTimestamp = new Date(Date.now() + 5000).toISOString();

    const response429 = unavailableResponse(429, "Rate limited", futureTimestamp, "reset after 5s");
    expect(response429.status).toBe(429);

    const response503 = unavailableResponse(503, "Unavailable", futureTimestamp, "reset after 5s");
    expect(response503.status).toBe(503);
  });
});
