/**
 * xAI OAuth service — endpoint validation and auth URL construction
 * No mocks: pure function tests + source inspection for oauthFetch wiring.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));

describe("xai/oauth service", () => {
  it("validates discovered endpoints are https x.ai URLs", async () => {
    const { validateOAuthEndpoint } = await import("../../src/lib/oauth/services/xai.js");

    expect(validateOAuthEndpoint("https://auth.x.ai/oauth2/authorize", "authorization_endpoint")).toBe(
      "https://auth.x.ai/oauth2/authorize"
    );
    expect(() => validateOAuthEndpoint("http://auth.x.ai/oauth2/authorize", "authorization_endpoint")).toThrow(
      /must use https/
    );
    expect(() => validateOAuthEndpoint("https://example.com/oauth2/authorize", "authorization_endpoint")).toThrow(
      /is not on x\.ai/
    );
  });

  it("discovers endpoints via oauthFetch (source)", () => {
    const src = readFileSync(join(root, "../../src/lib/oauth/services/xai.js"), "utf8");
    expect(src).toContain("discoverEndpoints");
    expect(src).toContain("oauthFetch");
    expect(src).toContain(".well-known/openid-configuration");
    expect(src).not.toMatch(/\bfetch\s*\(/);
  });

  it("builds authorize URLs with CLIProxyAPI query extras", async () => {
    const { XaiService } = await import("../../src/lib/oauth/services/xai.js");
    const authUrl = new XaiService().buildXaiAuthUrl(
      "http://127.0.0.1:56121/callback",
      "state-1",
      "challenge-1",
      "https://auth.x.ai/oauth2/authorize"
    );
    const parsed = new URL(authUrl);

    expect(parsed.origin + parsed.pathname).toBe("https://auth.x.ai/oauth2/authorize");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("client_id")).toBe("b1a00492-073a-47ea-816f-4c329264a828");
    expect(parsed.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:56121/callback");
    expect(parsed.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("state")).toBe("state-1");
    expect(parsed.searchParams.get("nonce")).toMatch(/^[a-f0-9]{32}$/);
    expect(parsed.searchParams.get("plan")).toBe("generic");
    expect(parsed.searchParams.get("referrer")).toBe("cli-proxy-api");
  });

  it("generateAuthData for xai uses oauthFetch discovery (source)", () => {
    const src = readFileSync(join(root, "../../src/lib/oauth/providers.js"), "utf8");
    expect(src).toContain("xai: {");
    expect(src).toContain("discoverXaiEndpoints");
    expect(src).toContain("oauthFetch");
    expect(src).toContain("code_challenge_method");
  });

  it("exchangeTokens for xai posts to discovered token endpoint via oauthFetch (source)", () => {
    const src = readFileSync(join(root, "../../src/lib/oauth/providers.js"), "utf8");
    const xaiBlock = src.slice(src.indexOf("xai: {"));
    expect(xaiBlock).toContain("oauthFetch");
    expect(xaiBlock).toContain("authorization_code");
    expect(xaiBlock).toContain("code_verifier");
  });
});
