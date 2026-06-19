/**
 * Regression tests for the broad-scan audit fixes.
 *
 *  #1 cursor.js makeFetchRequest — restored the deleted proxyAwareFetch call (P0).
 *  #2 importDb — a partial payload no longer wipes config tables it does not carry (P0).
 *  #3 getProviderCredentials returns expiresAt (covered in credential-selection-filtering.test.js).
 *  #4 DefaultExecutor refreshWithJSON/refreshWithForm classify invalid_grant as unrecoverable.
 *  #5 translator/send route persists the rotated refresh token.
 *  #6 parseSSEToClaudeResponse merges message_delta usage (preserves input_tokens).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
});
