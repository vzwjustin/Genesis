import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

describe("codebase health audit fixes", () => {
  describe("proxyFetch — redirect credential headers", () => {
    it("strips x-goog-api-key and suffix -api-key headers on cross-origin redirect", async () => {
      const { shouldStripCredentialHeaderOnRedirect } = await import("../../open-sse/utils/proxyFetch.js");
      expect(shouldStripCredentialHeaderOnRedirect("x-goog-api-key")).toBe(true);
      expect(shouldStripCredentialHeaderOnRedirect("X-Goog-Api-Key")).toBe(true);
      expect(shouldStripCredentialHeaderOnRedirect("x-custom-api-key")).toBe(true);
      expect(shouldStripCredentialHeaderOnRedirect("Authorization")).toBe(true);
      expect(shouldStripCredentialHeaderOnRedirect("content-type")).toBe(false);
      expect(shouldStripCredentialHeaderOnRedirect("x-request-id")).toBe(false);
      expect(shouldStripCredentialHeaderOnRedirect("anthropic-version")).toBe(false);
    });

    it("uses instanceof Headers for redirect credential stripping", () => {
      const src = fs.readFileSync(path.join(process.cwd(), "open-sse/utils/proxyFetch.js"), "utf8");
      expect(src).toContain("currentOptions.headers instanceof Headers");
      expect(src).not.toMatch(/typeof currentOptions\.headers\.entries === "function"/);
    });
  });

  describe("circuitBreaker — half-open probe serialization", () => {
    it("allows only one probe when transitioning from open after cooldown", async () => {
      vi.useFakeTimers();
      const { createCircuitBreaker } = await import("../../open-sse/utils/circuitBreaker.js");
      const cb = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 5000 });

      cb.recordFailure("openai");
      expect(cb.canRequest("openai").allowed).toBe(false);

      vi.advanceTimersByTime(5000);
      const first = cb.canRequest("openai");
      const second = cb.canRequest("openai");
      expect(first.allowed).toBe(true);
      expect(second.allowed).toBe(false);
      expect(second.retryAfter).toBeGreaterThanOrEqual(1);
      vi.useRealTimers();
    });
  });

  describe("upstreamTelemetry — latency + reachability wiring", () => {
    it("records latency and marks provider reachable on 2xx", async () => {
      const { recordUpstreamTelemetry } = await import("../../open-sse/utils/upstreamTelemetry.js");
      const { latencyStore } = await import("../../open-sse/utils/latencyMetrics.js");
      const { providerReachability } = await import("../../open-sse/utils/circuitBreaker.js");

      const provider = `telemetry-test-${Date.now()}`;
      const model = "model-a";
      recordUpstreamTelemetry(provider, model, Date.now() - 100, { ok: true, status: 200 });

      expect(latencyStore.getStats()[provider]?.[model]?.count).toBeGreaterThanOrEqual(1);
      expect(providerReachability.getAll()[provider]?.reachable).toBe(true);
    });

    it("treats 3xx as success so half-open probe does not stick", async () => {
      vi.useFakeTimers();
      const { recordUpstreamTelemetry } = await import("../../open-sse/utils/upstreamTelemetry.js");
      const { circuitBreaker } = await import("../../open-sse/utils/circuitBreaker.js");

      const provider = `telemetry-3xx-${Date.now()}`;
      for (let i = 0; i < 5; i++) circuitBreaker.recordFailure(provider);
      expect(circuitBreaker.canRequest(provider).allowed).toBe(false);

      vi.advanceTimersByTime(30000);
      expect(circuitBreaker.canRequest(provider).allowed).toBe(true);

      recordUpstreamTelemetry(provider, "m", Date.now() - 50, { ok: false, status: 304 });
      expect(circuitBreaker.canRequest(provider).allowed).toBe(true);
      vi.useRealTimers();
    });
  });

  describe("usageRepo — idempotency skips live ring", () => {
    const originalDataDir = process.env.DATA_DIR;
    let tempDir;

    beforeEach(async () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-idem-ring-"));
      process.env.DATA_DIR = tempDir;
      vi.resetModules();
      const sqliteDb = await import("@/lib/db/index.js");
      await sqliteDb.initDb();
    });

    afterEach(() => {
      if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
      if (originalDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = originalDataDir;
    });

    it("does not double-count lifetime or ring on duplicate idempotencyKey", async () => {
      const sqliteDb = await import("@/lib/db/index.js");
      const key = "stream-detail-abc";
      const entry = {
        provider: "openai",
        model: "gpt-4o",
        tokens: { prompt_tokens: 10, completion_tokens: 5 },
        status: "ok",
        idempotencyKey: key,
      };

      await sqliteDb.saveRequestUsage(entry);
      await sqliteDb.saveRequestUsage(entry);

      const stats = await sqliteDb.getUsageStats("24h");
      expect(stats.totalRequests).toBe(1);

      const live = await sqliteDb.getActiveRequests();
      expect(live.recentRequests.length).toBeLessThanOrEqual(1);
    });
  });

  describe("stream.js — translated usage fallback without terminal", () => {
    it("source includes translate-mode usage fallback when onStreamComplete lacks terminal", () => {
      const src = fs.readFileSync(path.join(process.cwd(), "open-sse/utils/stream.js"), "utf8");
      expect(src).toContain("logStreamUsageFallback");
      expect(src).toMatch(/hasValidUsage\(state\?\.usage\).*onStreamComplete.*!sawTerminal/s);
    });
  });

  describe("chatCore — circuit breaker + telemetry imports", () => {
    it("checks circuit breaker before execute and records telemetry after", async () => {
      const src = fs.readFileSync(
        path.join(process.cwd(), "open-sse/handlers/chatCore.js"),
        "utf8"
      );
      expect(src).toContain("checkCircuitBreaker(provider)");
      expect(src).toContain("recordUpstreamTelemetry(provider, model, requestStartTime");
      expect(src).toContain('errorCode: "circuit_open"');
    });
  });

  describe("requestDetail — no circular import with stream.js", () => {
    it("imports COLORS from usageTracking, not stream.js", () => {
      const src = fs.readFileSync(path.join(process.cwd(), "open-sse/handlers/chatCore/requestDetail.js"), "utf8");
      expect(src).toContain('from "../../utils/usageTracking.js"');
      expect(src).not.toContain('from "../../utils/stream.js"');
    });
  });
});
