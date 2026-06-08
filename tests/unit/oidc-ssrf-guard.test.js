import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  getSettings: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
}));

vi.stubGlobal("fetch", mocks.fetch);

const { fetchOidcDiscovery, sanitizeOidcError } = await import("../../src/lib/auth/oidc.js");

describe("fetchOidcDiscovery SSRF guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects loopback issuer URL", async () => {
    await expect(fetchOidcDiscovery("http://127.0.0.1:8080")).rejects.toThrow(/host is not allowed|Only HTTPS/i);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("rejects localhost issuer URL", async () => {
    await expect(fetchOidcDiscovery("http://localhost:9000")).rejects.toThrow(/host is not allowed|Only HTTPS/i);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("rejects private RFC-1918 issuer URL", async () => {
    await expect(fetchOidcDiscovery("http://192.168.1.1")).rejects.toThrow(/host is not allowed|Only HTTPS/i);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("rejects HTTP (non-HTTPS) public issuer URL", async () => {
    await expect(fetchOidcDiscovery("http://example.com")).rejects.toThrow(/Only HTTPS/i);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("rejects metadata endpoint", async () => {
    await expect(fetchOidcDiscovery("http://169.254.169.254")).rejects.toThrow();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("allows valid HTTPS public issuer URL", async () => {
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        issuer: "https://accounts.example.com",
        authorization_endpoint: "https://accounts.example.com/authorize",
        token_endpoint: "https://accounts.example.com/token",
        jwks_uri: "https://accounts.example.com/.well-known/jwks.json",
      }),
    });

    const doc = await fetchOidcDiscovery("https://accounts.example.com");
    expect(doc.issuer).toBe("https://accounts.example.com");
    expect(mocks.fetch).toHaveBeenCalledWith(
      "https://accounts.example.com/.well-known/openid-configuration",
      { cache: "no-store" }
    );
  });

  it("throws generic error (no URL) when discovery fetch fails", async () => {
    mocks.fetch.mockResolvedValueOnce({ ok: false, status: 404 });

    await expect(fetchOidcDiscovery("https://accounts.example.com")).rejects.toThrow(
      "Failed to load OIDC discovery document"
    );
    // Error message must NOT contain the full discovery URL
    await fetchOidcDiscovery("https://accounts.example.com").catch((e) => {
      expect(e.message).not.toContain("https://accounts.example.com");
    });
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
    expect(sanitized.length).toBeLessThanOrEqual(122); // 120 + ellipsis char
  });

  it("returns fallback for empty error", () => {
    expect(sanitizeOidcError(new Error(""), "oidc_callback_failed")).toBe("oidc_callback_failed");
    expect(sanitizeOidcError(null, "oidc_start_failed")).toBe("oidc_start_failed");
  });

  it("preserves safe short error codes", () => {
    expect(sanitizeOidcError(new Error("access_denied"), "fallback")).toBe("access_denied");
  });
});
