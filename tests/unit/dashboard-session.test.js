import { afterEach, describe, expect, it } from "vitest";
import { shouldUseSecureCookie } from "../../src/lib/auth/dashboardSession.js";

function request(headers = {}) {
  return {
    headers: {
      get(name) {
        return headers[name.toLowerCase()] ?? null;
      },
    },
  };
}

describe("shouldUseSecureCookie", () => {
  afterEach(() => {
    delete process.env.AUTH_COOKIE_SECURE;
    delete process.env.TRUST_PROXY_HEADERS;
  });

  it("ignores x-forwarded-proto unless TRUST_PROXY_HEADERS is enabled", () => {
    const req = request({ "x-forwarded-proto": "https" });
    expect(shouldUseSecureCookie(req)).toBe(false);
  });

  it("uses x-forwarded-proto when TRUST_PROXY_HEADERS is true", () => {
    process.env.TRUST_PROXY_HEADERS = "true";
    const req = request({ "x-forwarded-proto": "https" });
    expect(shouldUseSecureCookie(req)).toBe(true);
  });

  it("honors AUTH_COOKIE_SECURE override", () => {
    process.env.AUTH_COOKIE_SECURE = "true";
    const req = request({});
    expect(shouldUseSecureCookie(req)).toBe(true);
  });
});
