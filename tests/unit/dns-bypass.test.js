/**
 * MITM DNS bypass tests (Tasks 15.1, 15.4, 15.5)
 * Requirements: 11.1, 11.4
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("dns", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    Resolver: class MockResolver {
      setServers() {}
      resolve4(_hostname, callback) {
        process.nextTick(() => callback(new Error("ENOTFOUND")));
      }
    },
  };
});

import {
  shouldBypassMitmDns,
  resolveRealIP,
  MITM_BYPASS_HOSTS,
} from "../../open-sse/utils/proxyFetch.js";

const root = join(import.meta.dirname, "..", "..");

describe("MITM bypass host detection", () => {
  it("detects configured bypass hosts", () => {
    expect(shouldBypassMitmDns("https://api2.cursor.sh/v1/chat")).toBe(true);
    expect(shouldBypassMitmDns("https://api.openai.com/v1/chat")).toBe(false);
    expect(MITM_BYPASS_HOSTS).toContain("api2.cursor.sh");
  });

  it("does not match substring hostname spoofing", () => {
    expect(shouldBypassMitmDns("https://xapi2.cursor.sh/v1/chat")).toBe(false);
    expect(shouldBypassMitmDns("https://evil-api2.cursor.sh.attacker.com/v1")).toBe(false);
  });

  it("matches exact host and subdomains", () => {
    expect(shouldBypassMitmDns("https://sub.api2.cursor.sh/v1/chat")).toBe(true);
  });

  it("detects regional Kiro and CodeWhisperer hosts via isKiroMitmHost", () => {
    expect(shouldBypassMitmDns("https://runtime.eu-central-1.kiro.dev/generate")).toBe(true);
    expect(shouldBypassMitmDns("https://q.eu-central-1.amazonaws.com/v1/chat")).toBe(true);
    expect(shouldBypassMitmDns("https://codewhisperer.eu-central-1.amazonaws.com/v1/chat")).toBe(true);
    expect(shouldBypassMitmDns("https://q.us-gov-east-1.amazonaws.com/v1/chat")).toBe(true);
    expect(shouldBypassMitmDns("https://management.us-east-1.kiro.dev/limits")).toBe(false);
  });
});

describe("DNS bypass fail-closed (Requirement 11.4)", () => {
  it("proxyFetch throws on external DNS failure instead of falling through to system DNS", () => {
    const src = readFileSync(join(root, "open-sse/utils/proxyFetch.js"), "utf8");
    expect(src).toContain("External DNS resolution failed for MITM bypass host");
    expect(src).not.toMatch(/if \(realIP\) return await createBypassRequest[\s\S]*originalFetch\(url, options\)/);
  });

  it("resolveRealIP returns null on DNS failure without throwing", async () => {
    const ip = await resolveRealIP("definitely-not-a-real-host.invalid");
    expect(ip).toBeNull();
  });
});
