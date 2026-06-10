/**
 * Round 22 — OIDC oauthFetch migration, token endpoint SSRF guards
 * No mocks: source inspection + assertSafeFetchUrl rejection probes.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { exchangeOidcCode } from "../../src/lib/auth/oidc.js";

const root = dirname(fileURLToPath(import.meta.url));

describe("OIDC uses oauthFetch for proxy parity", () => {
  it("oidc.js imports oauthFetch and has no bare fetch calls", () => {
    const src = readFileSync(join(root, "../../src/lib/auth/oidc.js"), "utf8");
    expect(src).toContain("oauthFetch");
    expect(src).not.toMatch(/\bfetch\s*\(/);
  });

  it("token exchange and probe validate tokenEndpoint with assertSafeFetchUrl", () => {
    const src = readFileSync(join(root, "../../src/lib/auth/oidc.js"), "utf8");
    const exchangeBlock = src.slice(src.indexOf("export async function exchangeOidcCode"));
    const probeBlock = src.slice(src.indexOf("export async function probeOidcClientSecret"));
    expect(exchangeBlock).toContain("assertSafeFetchUrlWithDns(tokenEndpoint)");
    expect(probeBlock).toContain("assertSafeFetchUrlWithDns(tokenEndpoint)");
  });
});

describe("OIDC token endpoint SSRF — fail closed", () => {
  it("exchangeOidcCode rejects HTTP public token URL", async () => {
    await expect(exchangeOidcCode({
      tokenEndpoint: "http://accounts.example.com/token",
      clientId: "c",
      clientSecret: "s",
      code: "x",
      redirectUri: "https://app.example/cb",
      codeVerifier: "v",
    })).rejects.toThrow(/Only HTTPS/i);
  });
});
