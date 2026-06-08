/**
 * OAuth HTTP routing through proxyAwareFetch
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";

const proxyAwareFetch = vi.hoisted(() => vi.fn());

vi.mock("open-sse/utils/proxyFetch.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    proxyAwareFetch: (...args) => proxyAwareFetch(...args),
  };
});

describe("oauthFetch helper", () => {
  it("delegates to proxyAwareFetch with null proxy options", async () => {
    proxyAwareFetch.mockReset();
    proxyAwareFetch.mockResolvedValue(
      new Response(JSON.stringify({ access_token: "tok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const { oauthFetch } = await import("../../src/lib/oauth/utils/oauthFetch.js");
    await oauthFetch("https://example.com/token", { method: "POST", body: "{}" });

    expect(proxyAwareFetch).toHaveBeenCalledWith(
      "https://example.com/token",
      expect.objectContaining({ method: "POST" }),
      null
    );
  });
});

describe("OAuth module bare fetch audit", () => {
  const oauthRoot = join(dirname(fileURLToPath(import.meta.url)), "../../src/lib/oauth");

  function listJsFiles(dir) {
    const entries = [];
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, name.name);
      if (name.isDirectory()) entries.push(...listJsFiles(path));
      else if (name.name.endsWith(".js")) entries.push(path);
    }
    return entries;
  }

  it("does not use bare fetch() in oauth services or providers", () => {
    const offenders = [];
    for (const file of listJsFiles(oauthRoot)) {
      const src = readFileSync(file, "utf8");
      if (/\bfetch\s*\(/.test(src)) offenders.push(file.replace(oauthRoot + "/", ""));
    }
    expect(offenders).toEqual([]);
  });

  it("routes oauth HTTP through oauthFetch or proxyAwareFetch", () => {
    const providersSrc = readFileSync(join(oauthRoot, "providers.js"), "utf8");
    expect(providersSrc).toContain("oauthFetch");
    expect(providersSrc).not.toMatch(/\bfetch\s*\(/);

    const kiroSrc = readFileSync(join(oauthRoot, "services/kiro.js"), "utf8");
    expect(kiroSrc).toContain("proxyAwareFetch");
    expect(kiroSrc).not.toMatch(/\bfetch\s*\(/);
  });
});
