import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseOAuthRefreshErrorBody,
  isUnrecoverableRefreshError,
} from "../../open-sse/services/tokenRefresh.js";
import { mergeAbortSignals } from "../../open-sse/utils/abortSignal.js";

const root = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(root, rel), "utf8");

const clearAccountMocks = vi.hoisted(() => {
  const updateCalls = [];
  return {
    updateCalls,
    getProviderConnectionById: vi.fn(),
    updateProviderConnection: vi.fn(async (id, data) => {
      updateCalls.push({ id, data });
      return { id, ...data };
    }),
  };
});

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(),
  getProviderConnectionById: clearAccountMocks.getProviderConnectionById,
  updateProviderConnection: clearAccountMocks.updateProviderConnection,
  validateApiKey: vi.fn(),
  getSettingsSafe: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn().mockResolvedValue({}),
}));

vi.mock("../../src/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

describe("wave4 — OAuth unrecoverable refresh parsing", () => {
  it("parseOAuthRefreshErrorBody maps invalid_grant to unrecoverable_refresh_error", () => {
    const result = parseOAuthRefreshErrorBody(
      JSON.stringify({ error: "invalid_grant" }),
      null,
      "claude"
    );
    expect(result).toEqual({ error: "unrecoverable_refresh_error", code: "invalid_grant" });
    expect(isUnrecoverableRefreshError(result)).toBe(true);
  });

  it("parseOAuthRefreshErrorBody maps refresh_token_reused", () => {
    const result = parseOAuthRefreshErrorBody(
      JSON.stringify({ error: { code: "refresh_token_reused" } }),
      null,
      "github"
    );
    expect(result?.error).toBe("unrecoverable_refresh_error");
  });

  it("specialized refresh functions use parseOAuthRefreshErrorBody", () => {
    const src = read("../../open-sse/services/tokenRefresh.js");
    for (const fn of [
      "refreshClaudeOAuthToken",
      "refreshGoogleToken",
      "refreshQwenToken",
      "refreshKiroToken",
      "refreshGitHubToken",
      "refreshCodexToken",
    ]) {
      const block = src.slice(src.indexOf(`export async function ${fn}`));
      expect(block).toContain("parseOAuthRefreshErrorBody");
    }
  });
});

describe("wave4 — tokenRefresh local wrappers", () => {
  it("Copilot refresh failure persists testStatus error", () => {
    const src = read("../../src/sse/services/tokenRefresh.js");
    expect(src).toMatch(/Copilot token refresh failed[\s\S]*testStatus:\s*"error"/);
  });

  it("updateProviderCredentials uses != null for tokens", () => {
    const src = read("../../src/sse/services/tokenRefresh.js");
    expect(src).toContain("newCredentials.accessToken != null");
    expect(src).toContain("newCredentials.refreshToken != null");
  });

  it("getAllAccessTokens passes full connection to getAccessToken", () => {
    const src = read("../../open-sse/services/tokenRefresh.js");
    expect(src).toMatch(/getAccessToken\(connection\.provider,\s*connection,\s*log\)/);
  });
});

describe("wave4 — auth.js account state", () => {
  it("clearAccountError clears modelLock___all without model", () => {
    const src = read("../../src/sse/services/auth.js");
    expect(src).toContain('if (k === "modelLock___all") return true');
    expect(src).not.toMatch(/if \(model && k === "modelLock___all"\)/);
  });

  it("clearAccountError re-reads connection from DB", () => {
    const src = read("../../src/sse/services/auth.js");
    expect(src).toContain("getProviderConnectionById(connectionId)");
  });

  it("clearAccountError sets lastUsedAt on success (deferred from selection)", () => {
    const src = read("../../src/sse/services/auth.js");
    expect(src).toContain("clearObj.lastUsedAt = new Date().toISOString()");
  });

  it("round-robin selection does not update lastUsedAt at selection time", () => {
    const src = read("../../src/sse/services/auth.js");
    const rrBlock = src.slice(src.indexOf('strategy === "round-robin"'));
    const selectionUpdates = rrBlock.slice(0, rrBlock.indexOf("} else {"));
    expect(selectionUpdates).not.toContain("lastUsedAt:");
  });

  it("markAccountUnavailable uses accountStateMutex", () => {
    const src = read("../../src/sse/services/auth.js");
    expect(src).toContain("accountStateMutex");
    expect(src).toMatch(/markAccountUnavailable[\s\S]*accountStateMutex/);
  });
});

describe("wave4 — proxy routing", () => {
  it("relay/vercel pool takes precedence over env proxy", () => {
    const src = read("../../open-sse/utils/proxyFetch.js");
    expect(src).toMatch(/per-connection proxy → relay\/vercel pool → environment proxy/);
    expect(src).toMatch(/if \(!proxyUrl && !vercelRelayUrl\)/);
    expect(src).toMatch(/if \(!proxyUrl && vercelRelayUrl\)/);
  });

  it("resolveConnectionProxyConfig catch preserves strictProxy from input", () => {
    const src = read("../../src/lib/network/connectionProxy.js");
    expect(src).toContain('Object.prototype.hasOwnProperty.call(providerSpecificData, "strictProxy")');
    expect(src).not.toMatch(/strictProxy:\s*false,\s*\n\s*\};\s*\n\}/);
  });

  it("getMitmDnsServers fails closed on settings load error", () => {
    const src = read("../../open-sse/utils/proxyFetch.js");
    expect(src).toMatch(/Failed to load DNS resolver settings[\s\S]*return \[\]/);
  });

  it("DNS cache has max size cap", () => {
    const src = read("../../open-sse/utils/proxyFetch.js");
    expect(src).toContain("DNS_CACHE_MAX_SIZE");
    expect(src).toMatch(/DNS_CACHE\.size >= DNS_CACHE_MAX_SIZE/);
  });

  it("UPSTREAM_TIMEOUT_MS=0 warns operator", () => {
    const src = read("../../open-sse/utils/proxyFetch.js");
    expect(src).toContain("UPSTREAM_TIMEOUT_MS=0 disables upstream timeout");
  });

  it("createBypassRequest destroys socket on abort after headers", () => {
    const src = read("../../open-sse/utils/proxyFetch.js");
    expect(src).toContain("destroyOnAbort");
    expect(src).toMatch(/bodyChunks\.shift\(\)/);
  });
});

describe("wave4 — mergeAbortSignals cleanup", () => {
  it("exposes cleanup for polyfill path", () => {
    if (typeof AbortSignal?.any === "function") return;
    const a = new AbortController();
    const b = new AbortController();
    const merged = mergeAbortSignals([a.signal, b.signal]);
    expect(typeof merged.cleanup).toBe("function");
    merged.cleanup();
  });

  it("withUpstreamTimeout invokes merge cleanup on done", () => {
    const src = read("../../open-sse/utils/proxyFetch.js");
    expect(src).toContain("merged.cleanup?.()");
  });
});

describe("wave4 — MITM manager hardening", () => {
  it("ensureRuntimeServer uses content hash not file size", () => {
    const src = read("../../src/mitm/manager.js");
    expect(src).toContain(".server.sha256");
    expect(src).toContain('crypto.createHash("sha256")');
    expect(src).not.toMatch(/statSync\(bundledPath\)\.size === fs\.statSync\(runtimeServer\)\.size/);
  });

  it("deriveKey logs prominently on machineId failure", () => {
    const src = read("../../src/mitm/manager.js");
    expect(src).toMatch(/CRITICAL: node-machine-id unavailable/);
  });

  it("PID reuse requires health check", () => {
    const src = read("../../src/mitm/manager.js");
    expect(src).toMatch(/pollMitmHealth\(2000,\s*MITM_PORT\)/);
    expect(src).toContain("Stale PID");
  });

  it("scheduleMitmRestart re-fetches apiKey from settings/DB", () => {
    const src = read("../../src/mitm/manager.js");
    expect(src).toContain("resolveMitmApiKey");
    expect(src).toContain("mitmApiKey");
    expect(src).toMatch(/const apiKey = await resolveMitmApiKey/);
  });
});

describe("wave4 — clearAccountError integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAccountMocks.updateCalls.length = 0;
  });

  it("clears modelLock___all when model is null", async () => {
    const { clearAccountError } = await import("../../src/sse/services/auth.js");
    clearAccountMocks.getProviderConnectionById.mockResolvedValue({
      id: "conn-1",
      testStatus: "unavailable",
      lastError: "rate limited",
      modelLock___all: new Date(Date.now() + 60000).toISOString(),
    });

    await clearAccountError("conn-1", {}, null);

    expect(clearAccountMocks.updateProviderConnection).toHaveBeenCalledWith(
      "conn-1",
      expect.objectContaining({ modelLock___all: null, lastUsedAt: expect.any(String) })
    );
  });
});
