import { describe, it, expect, vi, afterEach } from "vitest";

import { getClientIp } from "../../src/lib/auth/loginLimiter.js";

function request(headers = {}, options = {}) {
  return {
    headers: new Headers(headers),
    ip: options.ip,
    socket: options.socket,
  };
}

describe("login limiter client identity", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not trust spoofable forwarding headers by default", () => {
    expect(getClientIp(request({ "x-forwarded-for": "203.0.113.9" }))).toMatch(/^fp:[0-9a-f]{16}$/);
    expect(getClientIp(request({ "x-real-ip": "203.0.113.10" }))).toMatch(/^fp:[0-9a-f]{16}$/);
  });

  it("uses connection remote address when proxy headers are not trusted", () => {
    expect(getClientIp(request({}, { ip: "127.0.0.1" }))).toBe("127.0.0.1");
    expect(getClientIp(request({}, { socket: { remoteAddress: "::ffff:192.0.2.1" } }))).toBe("192.0.2.1");
  });

  it("uses authorization and user-agent fingerprint when IP is unavailable", () => {
    const first = getClientIp(request({
      authorization: "Bearer secret",
      "user-agent": "TestAgent/1.0",
    }));
    const second = getClientIp(request({
      authorization: "Bearer secret",
      "user-agent": "TestAgent/1.0",
    }));
    const different = getClientIp(request({
      authorization: "Bearer other",
      "user-agent": "TestAgent/1.0",
    }));

    expect(first).toBe(second);
    expect(first).toMatch(/^fp:[0-9a-f]{16}$/);
    expect(different).not.toBe(first);
  });

  it("can trust forwarding headers when explicitly configured", () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "true");

    expect(getClientIp(request({ "x-forwarded-for": "203.0.113.9, 10.0.0.2" }))).toBe("203.0.113.9");
  });
});
