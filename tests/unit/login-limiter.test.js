import { describe, it, expect, vi, afterEach } from "vitest";

import { getClientIp } from "../../src/lib/auth/loginLimiter.js";

function request(headers = {}) {
  return { headers: new Headers(headers) };
}

describe("login limiter client identity", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not trust spoofable forwarding headers by default", () => {
    expect(getClientIp(request({ "x-forwarded-for": "203.0.113.9" }))).toBe("unknown");
    expect(getClientIp(request({ "x-real-ip": "203.0.113.10" }))).toBe("unknown");
  });

  it("uses socket remoteAddress when proxy headers are not trusted", () => {
    const req = {
      headers: new Headers({ "x-forwarded-for": "203.0.113.9" }),
      socket: { remoteAddress: "192.168.1.42" },
    };
    expect(getClientIp(req)).toBe("192.168.1.42");
  });

  it("can trust forwarding headers when explicitly configured", () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "true");

    expect(getClientIp(request({ "x-forwarded-for": "203.0.113.9, 10.0.0.2" }))).toBe("203.0.113.9");
  });
});
