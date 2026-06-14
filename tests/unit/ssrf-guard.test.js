import { describe, it, expect } from "vitest";
import {
  isSafeFetchUrl,
  assertSafeFetchUrl,
  isBlockedHostname,
  assertSafeResolvedHostname,
} from "../../open-sse/utils/ssrfGuard.js";

describe("ssrfGuard", () => {
  it("allows public https URLs", () => {
    expect(isSafeFetchUrl("https://example.com/image.png")).toBe(true);
  });

  it("blocks localhost and private IPs", () => {
    expect(isBlockedHostname("localhost")).toBe(true);
    expect(isBlockedHostname("127.0.0.1")).toBe(true);
    expect(isBlockedHostname("10.0.0.1")).toBe(true);
    expect(isBlockedHostname("100.64.0.1")).toBe(true);
    expect(isBlockedHostname("192.168.1.1")).toBe(true);
    expect(isBlockedHostname("169.254.169.254")).toBe(true);
    expect(isSafeFetchUrl("http://127.0.0.1/secret")).toBe(false);
    expect(isSafeFetchUrl("https://metadata.google.internal/computeMetadata/v1/")).toBe(false);
  });

  it("rejects URLs with embedded credentials", () => {
    expect(() => assertSafeFetchUrl("https://user:pass@example.com")).toThrow();
  });

  it("blocks IPv4-mapped IPv6 in hex-normalized form (URL normalization bypass)", () => {
    // new URL("http://[::ffff:127.0.0.1]") normalizes host to "::ffff:7f00:1"
    expect(isBlockedHostname("::ffff:7f00:1")).toBe(true); // 127.0.0.1
    expect(isBlockedHostname("::ffff:a9fe:a9fe")).toBe(true); // 169.254.169.254 metadata
    expect(isBlockedHostname("::ffff:0a00:1")).toBe(true); // 10.0.0.1
    expect(isSafeFetchUrl("http://[::ffff:127.0.0.1]/secret", { requireHttps: false, allowHttp: true })).toBe(false);
    expect(isSafeFetchUrl("http://[::ffff:169.254.169.254]/latest/meta-data/", { requireHttps: false, allowHttp: true })).toBe(false);
    // still allows mapped public IPs
    expect(isBlockedHostname("::ffff:0808:0808")).toBe(false); // 8.8.8.8
  });

  it("assertSafeResolvedHostname blocks literal private IPs", async () => {
    await expect(assertSafeResolvedHostname("10.0.0.1")).rejects.toThrow(/not allowed/);
  });

  it("assertSafeResolvedHostname allows loopback when configured", async () => {
    await expect(assertSafeResolvedHostname("127.0.0.1", { allowLoopback: true })).resolves.toBeUndefined();
  });

  it("does not allow 0.0.0.0 when loopback URLs are enabled", () => {
    expect(() =>
      assertSafeFetchUrl("http://0.0.0.0:20128", {
        requireHttps: false,
        allowHttp: true,
        allowLoopback: true,
      })
    ).toThrow(/not allowed/);
  });

  it("blocks multicast, reserved, and documentation/benchmark IPv4 ranges", () => {
    // Multicast 224.0.0.0/4 + reserved/broadcast 240.0.0.0/4 (mirrors the v6 ff00::/8 block)
    expect(isBlockedHostname("224.0.0.1")).toBe(true);
    expect(isBlockedHostname("239.255.255.250")).toBe(true);
    expect(isBlockedHostname("240.0.0.1")).toBe(true);
    expect(isBlockedHostname("255.255.255.255")).toBe(true);
    // Benchmark 198.18.0.0/15 (RFC 2544)
    expect(isBlockedHostname("198.18.0.1")).toBe(true);
    expect(isBlockedHostname("198.19.255.255")).toBe(true);
    // Documentation / TEST-NET blocks (RFC 5737) + 192.0.0.0/24 (RFC 6890)
    expect(isBlockedHostname("192.0.2.1")).toBe(true);
    expect(isBlockedHostname("192.0.0.8")).toBe(true);
    expect(isBlockedHostname("198.51.100.1")).toBe(true);
    expect(isBlockedHostname("203.0.113.1")).toBe(true);
    // Regression: ordinary public IPs still allowed
    expect(isBlockedHostname("8.8.8.8")).toBe(false);
    expect(isBlockedHostname("198.20.0.1")).toBe(false);
    expect(isBlockedHostname("203.1.0.1")).toBe(false);
  });
});
