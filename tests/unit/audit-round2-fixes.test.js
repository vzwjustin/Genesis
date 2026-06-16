/**
 * Regression tests for audit round-2 fixes (MITM DNS, iFlow refresh, apiKey).
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateApiKeyWithMachine } from "../../src/shared/utils/apiKey.js";
import { parseOAuthRefreshErrorBody } from "../../open-sse/services/tokenRefresh.js";

const root = dirname(fileURLToPath(import.meta.url));

describe("MITM resolveTargetIP — blocked IP rejection", () => {
  it("server.js refuses blocked DNS answers", () => {
    const src = readFileSync(join(root, "../../src/mitm/server.js"), "utf8");
    expect(src).toContain("isBlockedHostname");
    expect(src).toMatch(/returned blocked IP/);
  });

  it("server.js does not kill unrelated port 443 listeners on startup", () => {
    const src = readFileSync(join(root, "../../src/mitm/server.js"), "utf8");
    expect(src).not.toMatch(/function\s+killPort\s*\(/);
    expect(src).not.toMatch(/killPort\(LOCAL_PORT\)/);
    expect(src).not.toMatch(/process\.kill\(Number\(pid\),\s*["']SIGKILL["']\)/);
    expect(src).toContain("server.listen(LOCAL_PORT, \"127.0.0.1\"");
  });

  it("root CA startup repairs existing private storage permissions before early return", () => {
    const src = readFileSync(join(root, "../../src/mitm/cert/rootCA.js"), "utf8");
    expect(src).toContain("function ensurePrivateMitmStorage()");
    expect(src).toMatch(/fs\.chmodSync\(MITM_DIR,\s*0o700\)/);
    expect(src).toMatch(/fs\.chmodSync\(ROOT_CA_KEY_PATH,\s*0o600\)/);
    expect(src.indexOf("ensurePrivateMitmStorage();")).toBeLessThan(src.indexOf("Root CA already exists"));
  });
});

describe("refreshIflowToken — unrecoverable OAuth errors", () => {
  it("returns unrecoverable_refresh_error on invalid_grant", async () => {
    vi.resetModules();
    vi.doMock("../../open-sse/utils/proxyFetch.js", () => ({
      proxyAwareFetch: vi.fn(async () => ({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: "invalid_grant" }),
      })),
    }));
    const { refreshIflowToken } = await import("../../open-sse/services/tokenRefresh.js");
    const result = await refreshIflowToken("rt-test", { error: vi.fn() }, null);
    expect(result).toMatchObject({ error: "unrecoverable_refresh_error", code: "invalid_grant" });
  });

  it("parseOAuthRefreshErrorBody handles iflow-style invalid_grant", () => {
    const log = { error: vi.fn() };
    const out = parseOAuthRefreshErrorBody(JSON.stringify({ error: "invalid_grant" }), log, "iflow");
    expect(out).toMatchObject({ error: "unrecoverable_refresh_error", code: "invalid_grant" });
  });
});

describe("generateApiKeyWithMachine — crypto keyId", () => {
  it("produces unique keyIds across many generations", () => {
    const ids = new Set();
    for (let i = 0; i < 50; i++) {
      ids.add(generateApiKeyWithMachine("abcd1234ef567890").keyId);
    }
    expect(ids.size).toBe(50);
  });
});

describe("proxyFetch directFetch — SSRF guard fail-closed", () => {
  it("does not fall back to plain fetch when guarded dispatcher is unavailable", () => {
    const src = readFileSync(join(root, "../../open-sse/utils/proxyFetch.js"), "utf8");
    expect(src).toContain("SSRF guard unavailable");
    expect(src).not.toMatch(/fall back to plain fetch/);
  });
});
