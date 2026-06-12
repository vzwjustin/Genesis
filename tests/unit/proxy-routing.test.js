/**
 * Outbound proxy precedence tests (Tasks 14.1–14.5)
 * Requirements: 10.1–10.4
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  resolveConnectionProxyUrl,
  getEnvProxyUrl,
  shouldBypassByNoProxy,
  normalizeProxyUrl,
  buildProxyOptionsFromCredentials,
  resolveStrictProxyOption,
} from "../../open-sse/utils/proxyFetch.js";

const TARGET = "https://api.example.com/v1/chat";

describe("proxy URL precedence (Requirement 10.1)", () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    process.env = { ...envBackup };
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.ALL_PROXY;
    delete process.env.NO_PROXY;
  });

  afterEach(() => {
    process.env = envBackup;
  });

  it("per-connection proxy overrides environment proxy", () => {
    process.env.HTTPS_PROXY = "http://env-proxy:8080";
    const conn = resolveConnectionProxyUrl(TARGET, {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://conn-proxy:3128",
    });
    expect(conn).toBe("http://conn-proxy:3128");
    expect(getEnvProxyUrl(TARGET)).toBe("http://env-proxy:8080");
    expect(conn).not.toBe(getEnvProxyUrl(TARGET));
  });

  it("environment proxy is used when per-connection proxy is disabled", () => {
    process.env.HTTPS_PROXY = "http://env-proxy:8080";
    expect(resolveConnectionProxyUrl(TARGET, { connectionProxyEnabled: false })).toBeNull();
    expect(getEnvProxyUrl(TARGET)).toBe("http://env-proxy:8080");
  });

  it("normalizes host:port proxy URLs", () => {
    expect(normalizeProxyUrl("127.0.0.1:7890")).toBe("http://127.0.0.1:7890");
  });

  it("per-connection proxy takes precedence over vercel relay URL in options", () => {
    const proxyOptions = {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://conn-proxy:3128",
      vercelRelayUrl: "https://relay.example.com/api/relay",
    };
    expect(resolveConnectionProxyUrl(TARGET, proxyOptions)).toBe("http://conn-proxy:3128");
  });
});

describe("NO_PROXY bypass (Requirement 10.4)", () => {
  it("matches exact host and subdomain patterns", () => {
    expect(shouldBypassByNoProxy("https://api.example.com/x", "api.example.com")).toBe(true);
    expect(shouldBypassByNoProxy("https://sub.api.example.com/x", ".example.com")).toBe(true);
    expect(shouldBypassByNoProxy("https://other.com/x", "api.example.com")).toBe(false);
  });
});

describe("strictProxy tri-state (fail-closed default)", () => {
  it("resolveStrictProxyOption treats unset as undefined", () => {
    expect(resolveStrictProxyOption(undefined)).toBeUndefined();
    expect(resolveStrictProxyOption(null)).toBeUndefined();
    expect(resolveStrictProxyOption("")).toBeUndefined();
  });

  it("resolveStrictProxyOption preserves explicit true/false", () => {
    expect(resolveStrictProxyOption(true)).toBe(true);
    expect(resolveStrictProxyOption(false)).toBe(false);
  });

  it("buildProxyOptionsFromCredentials defaults to fail-closed when strictProxy unset", () => {
    const opts = buildProxyOptionsFromCredentials({
      providerSpecificData: {
        connectionProxyEnabled: true,
        connectionProxyUrl: "http://conn-proxy:3128",
      },
    });
    expect(opts.strictProxy).toBeUndefined();
  });

  it("buildProxyOptionsFromCredentials allows fallback only when strictProxy is false", () => {
    const opts = buildProxyOptionsFromCredentials({
      providerSpecificData: { strictProxy: false },
    });
    expect(opts.strictProxy).toBe(false);
  });
});
