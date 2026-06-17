import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../..");

describe("usageRepo — saveRequestUsage persist failure logging", () => {
  beforeEach(() => {
    vi.resetModules();
    global._usagePersistFailures = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("source includes distinct [usage-persist-failed] warn tag and counter export", () => {
    const src = fs.readFileSync(path.join(repoRoot, "src/lib/db/repos/usageRepo.js"), "utf8");
    expect(src).toContain("[usage-persist-failed]");
    expect(src).toContain("console.warn");
    expect(src).toContain("usagePersistFailures");
    const warnLine = src.match(/`\[usage-persist-failed\][^`]+`/)?.[0] ?? "";
    expect(warnLine).toContain("provider=${provider}");
    expect(warnLine).toContain("model=${model}");
    expect(warnLine).not.toContain("apiKey");
  });

  it("warns with tag and increments counter after retries are exhausted", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let callCount = 0;

    vi.doMock("../../src/lib/db/repos/apiKeysRepo.js", () => ({
      getApiKeys: async () => [],
    }));
    vi.doMock("../../src/lib/db/repos/connectionsRepo.js", () => ({
      getProviderConnections: async () => [],
    }));
    vi.doMock("../../src/lib/db/repos/pricingRepo.js", () => ({
      getPricingForModel: async () => null,
    }));
    vi.doMock("../../src/lib/db/driver.js", () => ({
      getAdapter: async () => {
        callCount++;
        throw new Error("db locked");
      },
    }));

    const { saveRequestUsage, usagePersistFailures } = await import("../../src/lib/db/repos/usageRepo.js");
    await saveRequestUsage({
      provider: "anthropic",
      model: "claude-sonnet-4.6",
      apiKey: "sk-secret-should-not-appear",
      tokens: { input_tokens: 10, output_tokens: 5 },
    });

    expect(callCount).toBe(3);
    expect(usagePersistFailures.count).toBe(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = String(warnSpy.mock.calls[0][0]);
    expect(message).toContain("[usage-persist-failed]");
    expect(message).toContain("provider=anthropic");
    expect(message).toContain("model=claude-sonnet-4.6");
    expect(message).not.toContain("sk-secret");
  });
});
