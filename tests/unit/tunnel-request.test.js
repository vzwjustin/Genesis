import { describe, it, expect } from "vitest";
import {
  getTunnelHostnames,
  isTunnelRequest,
  isTunnelDashboardAccessDenied,
} from "../../src/shared/utils/tunnelRequest.js";

describe("tunnelRequest helpers", () => {
  const settings = {
    tunnelUrl: "http://[::1]:20128",
    tailscaleUrl: "https://machine.tailnet.ts.net",
    tunnelDashboardAccess: false,
  };

  it("extracts tunnel and tailscale hostnames", () => {
    expect(getTunnelHostnames(settings)).toEqual({
      tunnelHost: "::1",
      tailscaleHost: "machine.tailnet.ts.net",
    });
  });

  it("detects tunnel host requests", () => {
    const request = { headers: new Headers({ host: "[::1]:20128" }) };
    expect(isTunnelRequest(request, settings)).toBe(true);
  });

  it("denies dashboard access on tunnel when exposure is disabled", () => {
    const request = { headers: new Headers({ host: "[::1]:20128" }) };
    expect(isTunnelDashboardAccessDenied(request, settings)).toBe(true);
  });

  it("allows dashboard access on tunnel when exposure is enabled", () => {
    const request = { headers: new Headers({ host: "[::1]:20128" }) };
    expect(
      isTunnelDashboardAccessDenied(request, { ...settings, tunnelDashboardAccess: true })
    ).toBe(false);
  });

  it("does not treat LAN hosts as tunnel hosts", () => {
    const request = { headers: new Headers({ host: "192.168.8.201:20128" }) };
    expect(isTunnelRequest(request, settings)).toBe(false);
  });

  it("detects tunnel via x-forwarded-host when TRUST_PROXY_HEADERS is enabled", () => {
    const prev = process.env.TRUST_PROXY_HEADERS;
    process.env.TRUST_PROXY_HEADERS = "true";
    try {
      const request = {
        headers: new Headers({
          host: "localhost:20128",
          "x-forwarded-host": "[::1]:20128",
        }),
      };
      expect(isTunnelRequest(request, settings)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.TRUST_PROXY_HEADERS;
      else process.env.TRUST_PROXY_HEADERS = prev;
    }
  });
});
