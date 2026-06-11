import { describe, it, expect } from "vitest";
import {
  normalizeHostHeaderHostname,
  isPrivateLanHostname,
  isPrivateLanIp,
} from "../../src/shared/utils/host.js";

describe("normalizeHostHeaderHostname", () => {
  it("normalizes host headers with ports", () => {
    expect(normalizeHostHeaderHostname("localhost:20128")).toBe("localhost");
    expect(normalizeHostHeaderHostname("127.0.0.1:20128")).toBe("127.0.0.1");
  });

  it("normalizes IPv6 loopback forms", () => {
    expect(normalizeHostHeaderHostname("[::1]:20128")).toBe("::1");
    expect(normalizeHostHeaderHostname("::1")).toBe("::1");
  });

  it("rejects malformed bracketed hosts", () => {
    expect(normalizeHostHeaderHostname("[::1")).toBe("");
  });
});

describe("isPrivateLanHostname", () => {
  it("matches RFC1918 ranges", () => {
    expect(isPrivateLanHostname("192.168.1.1")).toBe(true);
    expect(isPrivateLanHostname("10.0.0.5")).toBe(true);
    expect(isPrivateLanHostname("172.16.0.1")).toBe(true);
    expect(isPrivateLanHostname("172.31.255.255")).toBe(true);
  });

  it("excludes loopback and public hosts", () => {
    expect(isPrivateLanHostname("127.0.0.1")).toBe(false);
    expect(isPrivateLanHostname("localhost")).toBe(false);
    expect(isPrivateLanHostname("::1")).toBe(false);
    expect(isPrivateLanHostname("8.8.8.8")).toBe(false);
    expect(isPrivateLanHostname("router.example.com")).toBe(false);
    expect(isPrivateLanHostname("172.15.0.1")).toBe(false);
    expect(isPrivateLanHostname("172.32.0.1")).toBe(false);
  });
});

describe("isPrivateLanIp", () => {
  it("matches RFC1918 socket addresses", () => {
    expect(isPrivateLanIp("192.168.1.10")).toBe(true);
    expect(isPrivateLanIp("::ffff:192.168.1.10")).toBe(true);
  });

  it("excludes public socket addresses", () => {
    expect(isPrivateLanIp("203.0.113.9")).toBe(false);
    expect(isPrivateLanIp("127.0.0.1")).toBe(false);
  });
});
