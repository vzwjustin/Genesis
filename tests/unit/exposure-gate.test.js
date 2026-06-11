import { describe, it, expect } from "vitest";
import {
  getRemoteExposureBlockReason,
  hasCustomPassword,
  isRemoteExposureActive,
  isRemoteExposureRequest,
} from "../../src/lib/security/exposureGate.js";

describe("exposureGate", () => {
  it("requires custom password before remote exposure", () => {
    expect(hasCustomPassword({})).toBe(false);
    expect(getRemoteExposureBlockReason({ requireLogin: true })).toContain("custom password");
  });

  it("requires login before remote exposure", () => {
    expect(
      getRemoteExposureBlockReason({ password: "hashed", requireLogin: false })
    ).toContain("dashboard login");
  });

  it("requires API key before remote exposure when requireApiKey is not enabled", () => {
    expect(
      getRemoteExposureBlockReason({ password: "hashed", requireLogin: true })
    ).toContain("API key");
  });

  it("allows exposure when password, login, and API key requirement are enabled", () => {
    expect(
      getRemoteExposureBlockReason({
        password: "hashed",
        requireLogin: true,
        requireApiKey: true,
      })
    ).toBeNull();
  });

  it("detects active remote exposure from tunnel, tailscale, or cloud settings", () => {
    expect(isRemoteExposureActive({ tunnelEnabled: true })).toBe(true);
    expect(isRemoteExposureActive({ tunnelDashboardAccess: true })).toBe(true);
    expect(isRemoteExposureActive({ tailscaleEnabled: true })).toBe(true);
    expect(isRemoteExposureActive({ cloudEnabled: true })).toBe(true);
    expect(isRemoteExposureActive({ tunnelEnabled: false })).toBe(false);
  });

  it("detects remote exposure settings updates", () => {
    expect(isRemoteExposureRequest({ tunnelEnabled: true })).toBe(true);
    expect(isRemoteExposureRequest({ tunnelDashboardAccess: true })).toBe(true);
    expect(isRemoteExposureRequest({ cloudEnabled: true })).toBe(true);
    expect(isRemoteExposureRequest({ requireLogin: false })).toBe(false);
  });
});
