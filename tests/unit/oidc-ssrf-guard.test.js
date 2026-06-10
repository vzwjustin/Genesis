/**
 * OIDC SSRF guard and error sanitization tests.
 * No mocks: assertSafeFetchUrl rejects unsafe URLs before any network call.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  fetchOidcDiscovery,
  exchangeOidcCode,
  probeOidcClientSecret,
  sanitizeOidcError,
} from "../../src/lib/auth/oidc.js";

const root = dirname(fileURLToPath(import.meta.url));

describe("fetchOidcDiscovery SSRF guard", () => {
  it("rejects loopback issuer URL", async () => {
    await expect(fetchOidcDiscovery("http://127.0.0.1:8080")).rejects.toThrow(/host is not allowed|Only HTTPS/i);
  });

  it("rejects localhost issuer URL", async () => {
    await expect(fetchOidcDiscovery("http://localhost:9000")).rejects.toThrow(/host is not allowed|Only HTTPS/i);
  });

  it("rejects private RFC-1918 issuer URL", async () => {
    await expect(fetchOidcDiscovery("http://192.168.1.1")).rejects.toThrow(/host is not allowed|Only HTTPS/i);
  });

  it("rejects HTTP (non-HTTPS) public issuer URL", async () => {
    await expect(fetchOidcDiscovery("http://example.com")).rejects.toThrow(/Only HTTPS/i);
  });

  it("rejects metadata endpoint", async () => {
    await expect(fetchOidcDiscovery("http://169.254.169.254")).rejects.toThrow();
  });
});

describe("exchangeOidcCode SSRF guard", () => {
  it("rejects loopback token endpoint", async () => {
    await expect(exchangeOidcCode({
      tokenEndpoint: "http://127.0.0.1:8080/token",
      clientId: "client",
      clientSecret: "secret",
      code: "code",
      redirectUri: "https://app.example/callback",
      codeVerifier: "verifier",
    })).rejects.toThrow(/host is not allowed|Only HTTPS/i);
  });

  it("rejects private token endpoint", async () => {
    await expect(exchangeOidcCode({
      tokenEndpoint: "http://10.0.0.5/token",
      clientId: "client",
      clientSecret: "secret",
      code: "code",
      redirectUri: "https://app.example/callback",
      codeVerifier: "verifier",
    })).rejects.toThrow(/host is not allowed|Only HTTPS/i);
  });
});

describe("probeOidcClientSecret SSRF guard", () => {
  it("rejects metadata token endpoint", async () => {
    await expect(probeOidcClientSecret({
      tokenEndpoint: "http://169.254.169.254/token",
      clientId: "client",
      clientSecret: "secret",
      redirectUri: "https://app.example/callback",
    })).rejects.toThrow();
  });
});

describe("oidc.js network routing (source)", () => {
  it("uses oauthFetch instead of bare fetch for discovery and token exchange", () => {
    const src = readFileSync(join(root, "../../src/lib/auth/oidc.js"), "utf8");
    expect(src).toContain('from "@/lib/oauth/utils/oauthFetch.js"');
    expect(src).toContain("oauthFetch");
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).toContain("assertSafeFetchUrlWithDns(tokenEndpoint)");
    expect(src).toContain("[customFetch]");
    expect(src).toContain("oauthFetch(url, options)");
  });

  it("discovery failure uses generic error without embedding URL", () => {
    const src = readFileSync(join(root, "../../src/lib/auth/oidc.js"), "utf8");
    expect(src).toContain("Failed to load OIDC discovery document");
  });
});

describe("sanitizeOidcError", () => {
  it("removes access_token from error message", () => {
    const err = new Error("access_token=eyJsecret&foo=bar");
    expect(sanitizeOidcError(err)).not.toContain("eyJsecret");
  });

  it("redacts JWT tokens in error message", () => {
    const err = new Error("Failed: eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyMSJ9.sig123abc");
    expect(sanitizeOidcError(err)).toContain("[redacted-jwt]");
  });

  it("strips URLs from error message", () => {
    const err = new Error("Failed to fetch https://accounts.example.com/.well-known/openid-configuration");
    expect(sanitizeOidcError(err)).toContain("[url]");
    expect(sanitizeOidcError(err)).not.toContain("accounts.example.com");
  });

  it("caps message length at 120 chars", () => {
    const err = new Error("x".repeat(300));
    const sanitized = sanitizeOidcError(err);
    expect(sanitized.length).toBeLessThanOrEqual(122);
  });

  it("returns fallback for empty error", () => {
    expect(sanitizeOidcError(new Error(""), "oidc_callback_failed")).toBe("oidc_callback_failed");
    expect(sanitizeOidcError(null, "oidc_start_failed")).toBe("oidc_start_failed");
  });

  it("preserves safe short error codes", () => {
    expect(sanitizeOidcError(new Error("access_denied"), "fallback")).toBe("access_denied");
  });
});
