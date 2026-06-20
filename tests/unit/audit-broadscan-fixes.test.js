/**
 * Regression tests for the broad-scan audit fixes.
 *
 *  #1 cursor.js makeFetchRequest — restored the deleted proxyAwareFetch call (P0).
 *  #2 importDb — a partial payload no longer wipes config tables it does not carry (P0).
 *  #3 getProviderCredentials returns expiresAt (covered in credential-selection-filtering.test.js).
 *  #4 DefaultExecutor refreshWithJSON/refreshWithForm classify invalid_grant as unrecoverable.
 *  #5 translator/send route persists the rotated refresh token.
 *  #6 parseSSEToClaudeResponse merges message_delta usage (preserves input_tokens).
 *
 * PR #115 review follow-ups:
 *  A opencode-go buildHeaders uses the threaded model, transformRequest does not
 *    mutate the shared credentials object.
 *  B importDb usageHistory is idempotent (INSERT OR IGNORE on idempotencyKey).
 *  C grok-web/perplexity-web throw on an in-band stream error (fail closed).
 *  D flushRequestDetailsSync is wired into the controlled shutdown path.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenCodeGoExecutor } from "../../open-sse/executors/opencode-go.js";

const root = dirname(fileURLToPath(import.meta.url));

// ── #1 cursor makeFetchRequest restored ──────────────────────────────────────
describe("cursor.js makeFetchRequest — restored upstream fetch (P0)", () => {
  const src = readFileSync(join(root, "../../open-sse/executors/cursor.js"), "utf8");
  const body = src.match(/async makeFetchRequest\([\s\S]*?\n {2}\}/)?.[0] || "";

  it("issues the proxyAwareFetch call (was deleted → ReferenceError on every call)", () => {
    expect(body).not.toBe("");
    expect(body).toMatch(/response\s*=\s*await proxyAwareFetch\(\s*url/);
  });

  it("clears the connect timer so it cannot leak", () => {
    expect(body).toMatch(/clearTimeout\(connectTimer\)/);
  });
});

// ── #5 translator/send persists the rotated token ────────────────────────────
describe("translator/send route — persists rotated refresh token (#5)", () => {
  const src = readFileSync(join(root, "../../src/app/api/translator/send/route.js"), "utf8");

  it("calls updateProviderCredentials(connection.id, newCredentials) after refresh", () => {
    expect(src).toMatch(/updateProviderCredentials\(\s*connection\.id\s*,\s*newCredentials\s*\)/);
    // Persist must happen after the refresh, not before.
    expect(src.indexOf("refreshTokenByProvider"))
      .toBeLessThan(src.indexOf("updateProviderCredentials(connection.id"));
  });
});

// ── #4 DefaultExecutor classifies invalid_grant ──────────────────────────────
describe("DefaultExecutor refresh — invalid_grant is unrecoverable (#4)", () => {
  it("refreshWithJSON returns unrecoverable_refresh_error on invalid_grant", async () => {
    vi.resetModules();
    vi.doMock("../../open-sse/utils/proxyFetch.js", () => ({
      proxyAwareFetch: vi.fn(async () => ({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: "invalid_grant" }),
      })),
    }));
    const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
    const ex = new DefaultExecutor("claude");
    const result = await ex.refreshWithJSON(
      "https://example.test/token",
      { grant_type: "refresh_token", refresh_token: "rt", client_id: "c" },
      null,
    );
    expect(result).toMatchObject({ error: "unrecoverable_refresh_error", code: "invalid_grant" });
    vi.doUnmock("../../open-sse/utils/proxyFetch.js");
  });

  it("refreshWithJSON returns null on a transient (retryable) failure", async () => {
    vi.resetModules();
    vi.doMock("../../open-sse/utils/proxyFetch.js", () => ({
      proxyAwareFetch: vi.fn(async () => ({ ok: false, status: 503, text: async () => "busy" })),
    }));
    const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
    const ex = new DefaultExecutor("claude");
    const result = await ex.refreshWithJSON("https://example.test/token", { refresh_token: "rt" }, null);
    expect(result).toBeNull();
    vi.doUnmock("../../open-sse/utils/proxyFetch.js");
  });
});

// ── #6 parseSSEToClaudeResponse merges usage ─────────────────────────────────
describe("parseSSEToClaudeResponse — usage merge preserves input_tokens (#6)", () => {
  it("keeps message_start input_tokens/cache while taking message_delta output_tokens", async () => {
    const { parseSSEToClaudeResponse } = await import(
      "../../open-sse/handlers/chatCore/sseToJsonHandler.js"
    );
    const sse = [
      'data: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","content":[],"usage":{"input_tokens":100,"cache_read_input_tokens":20,"output_tokens":0}}}',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
      'data: {"type":"content_block_stop","index":0}',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}',
      'data: {"type":"message_stop"}',
    ].join("\n");
    const result = parseSSEToClaudeResponse(sse);
    expect(result).not.toBeNull();
    expect(result.usage.input_tokens).toBe(100);
    expect(result.usage.cache_read_input_tokens).toBe(20);
    expect(result.usage.output_tokens).toBe(42);
  });
});

// ── #2 importDb partial-payload preserves config ─────────────────────────────
describe("importDb — partial payload preserves untouched config tables (#2)", () => {
  const originalDataDir = process.env.DATA_DIR;
  let tempDir;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "genesis-broadscan-import-"));
    process.env.DATA_DIR = tempDir;
    try { global._dbAdapter?.instance?.close?.(); } catch { /* ignore */ }
    delete global._dbAdapter;
    vi.resetModules();
    const db = await import("../../src/lib/db/index.js");
    await db.initDb();
  });

  afterAll(() => {
    try { global._dbAdapter?.instance?.close?.(); } catch { /* ignore */ }
    delete global._dbAdapter;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("a settings-only import does NOT delete provider connections (OAuth tokens)", async () => {
    const { importDb, getProviderConnections } = await import("../../src/lib/db/index.js");
    // Seed a connection holding a refresh token.
    await importDb({
      providerConnections: [
        { id: "keep-conn", provider: "claude", authType: "oauth", refreshToken: "rt-keepme", isActive: true },
      ],
    });
    expect((await getProviderConnections()).some((c) => c.id === "keep-conn")).toBe(true);

    // Config-only (settings) import must preserve the connection — before the fix
    // it unconditionally wiped providerConnections.
    await importDb({ settings: { broadscanMarker: "ok" } });
    expect((await getProviderConnections()).some((c) => c.id === "keep-conn")).toBe(true);
  });

  it("an explicitly-present providerConnections section still replaces that table", async () => {
    const { importDb, getProviderConnections } = await import("../../src/lib/db/index.js");
    await importDb({
      providerConnections: [
        { id: "replace-conn", provider: "openai", authType: "apikey", isActive: true },
      ],
    });
    const conns = await getProviderConnections();
    expect(conns.some((c) => c.id === "replace-conn")).toBe(true);
    // Present section is a deliberate replace → the earlier connection is gone.
    expect(conns.some((c) => c.id === "keep-conn")).toBe(false);
  });

  it("re-importing usageHistory with idempotencyKey does not duplicate rows (B)", async () => {
    const { importDb, getUsageHistory } = await import("../../src/lib/db/index.js");
    const payload = {
      // A config section so the payload passes validation (usageHistory alone does not).
      modelAliases: { "broadscan-dedup-alias": "openai/gpt-4o" },
      usageHistory: [
        {
          timestamp: new Date().toISOString(),
          provider: "dedup-prov", model: "m1",
          promptTokens: 10, completionTokens: 5, cost: 0.01, status: "ok",
          idempotencyKey: "broadscan-dedup-key-1",
        },
      ],
    };
    await importDb(payload);
    const after1 = await getUsageHistory({ provider: "dedup-prov" });
    expect(after1.length).toBe(1);

    // Re-importing the same backup must NOT append a duplicate (unique idempotencyKey).
    await importDb(payload);
    const after2 = await getUsageHistory({ provider: "dedup-prov" });
    expect(after2.length).toBe(1);
  });
});

// ── A opencode-go: per-request model, no shared-credential mutation ───────────
describe("opencode-go — per-request model, no shared-cred mutation (A)", () => {
  it("buildHeaders uses the threaded model: Claude-format → x-api-key", () => {
    const ex = new OpenCodeGoExecutor();
    const headers = ex.buildHeaders({ apiKey: "k1" }, true, "minimax-m2.5");
    expect(headers["x-api-key"]).toBe("k1");
    expect(headers["anthropic-version"]).toBeDefined();
    expect(headers.Authorization).toBeUndefined();
  });

  it("buildHeaders uses Bearer for non-Claude models", () => {
    const ex = new OpenCodeGoExecutor();
    const headers = ex.buildHeaders({ apiKey: "k1" }, true, "openai/gpt-4o");
    expect(headers.Authorization).toBe("Bearer k1");
    expect(headers["x-api-key"]).toBeUndefined();
  });

  it("transformRequest does NOT mutate the shared credentials object", () => {
    const ex = new OpenCodeGoExecutor();
    const creds = { apiKey: "k1" };
    ex.transformRequest("minimax-m2.5", { messages: [{ role: "user", content: "hi" }] }, true, creds);
    expect(creds._opencodeGoCtx).toBeUndefined();
  });
});

// ── C grok-web / perplexity-web: in-band stream error fails closed ────────────
describe("web executors — in-band stream error fails closed (C)", () => {
  const grok = readFileSync(join(root, "../../open-sse/executors/grok-web.js"), "utf8");
  const pplx = readFileSync(join(root, "../../open-sse/executors/perplexity-web.js"), "utf8");

  it("grok-web throws on chunk.error instead of emitting a synthetic stop", () => {
    const block = grok.match(/if \(chunk\.error\) \{[\s\S]*?\n {10}\}/)?.[0] || "";
    expect(block).toMatch(/throw new Error\(`Grok stream error/);
    expect(block).not.toContain("[Error:");
    expect(block).not.toContain('finish_reason: "stop"');
  });

  it("perplexity-web throws on chunk.error instead of emitting a synthetic stop", () => {
    const block = pplx.match(/if \(chunk\.error\) \{[\s\S]*?\n {10}\}/)?.[0] || "";
    expect(block).toMatch(/throw new Error\(`Perplexity stream error/);
    expect(block).not.toContain("[Error:");
  });
});

// ── D request-details flush wired into shutdown ──────────────────────────────
describe("request-details flush wired into shutdown (D)", () => {
  it("requestDetailsRepo exports flushRequestDetailsSync and registers no import-time signal handlers", () => {
    const src = readFileSync(join(root, "../../src/lib/db/repos/requestDetailsRepo.js"), "utf8");
    expect(src).toMatch(/export function flushRequestDetailsSync/);
    expect(src).not.toMatch(/process\.on\(/);
  });

  it("initializeApp cleanup drains the buffer via flushRequestDetailsSync before exit", () => {
    const src = readFileSync(join(root, "../../src/shared/services/initializeApp.js"), "utf8");
    expect(src).toMatch(/import \{ flushRequestDetailsSync \}/);
    expect(src.indexOf("flushRequestDetailsSync()")).toBeGreaterThan(-1);
    expect(src.indexOf("flushRequestDetailsSync()")).toBeLessThan(src.indexOf("process.exit()"));
  });
});
