import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const dnsConfig = require("../../src/mitm/dns/dnsConfig.js");

const read = (rel) => fs.readFileSync(path.join(import.meta.dirname, "..", "..", rel), "utf8");

describe("MITM dnsConfig — managed hosts tagging", () => {
  it("tags new entries with genesis-mitm marker", () => {
    expect(dnsConfig.formatManagedHostsEntry("api.example.com")).toBe(
      "127.0.0.1 api.example.com # genesis-mitm",
    );
  });

  it("hostsLineMatchesHost uses exact token match, not substring", () => {
    const { hostsLineMatchesHost } = dnsConfig;
    expect(hostsLineMatchesHost("127.0.0.1 daily-cloudcode-pa.googleapis.com # genesis-mitm", "cloudcode-pa.googleapis.com")).toBe(false);
    expect(hostsLineMatchesHost("127.0.0.1 cloudcode-pa.googleapis.com # genesis-mitm", "cloudcode-pa.googleapis.com")).toBe(true);
  });

  it("filterOutManagedHosts removes only tagged lines", () => {
    const content = [
      "127.0.0.1 manual.example.com",
      "127.0.0.1 api.example.com # genesis-mitm",
      "127.0.0.1 other.example.com # genesis-mitm",
    ].join("\n");
    const next = dnsConfig.filterOutManagedHosts(content, ["api.example.com"]);
    expect(next).toContain("manual.example.com");
    expect(next).not.toContain("api.example.com");
    expect(next).toContain("other.example.com");
  });
});

describe("MITM manager — Windows hosts cleanup", () => {
  it("uses filterOutManagedHosts instead of substring includes", () => {
    const src = read("src/mitm/manager.js");
    expect(src).toContain("filterOutManagedHosts");
    expect(src).not.toMatch(/allHosts\.some\(h => l\.includes\(h\)\)/);
    expect(src).toContain("MANAGED_HOSTS_MARKER");
  });
});

describe("MITM server — passthrough host guard", () => {
  it("validates Host against TARGET_HOSTS and requires SNI==Host", () => {
    const src = read("src/mitm/server.js");
    expect(src).toContain("function validatePassthroughRequest");
    expect(src).toContain("isAllowedMitmSniHost(hostHeader)");
    expect(src).toContain("Passthrough SNI/Host mismatch");
    expect(src).toMatch(/validatePassthroughRequest\(req\)/);
  });
});

describe("MITM cert install — uninstall legacy CNs", () => {
  it("always purges legacy CNs and does not early-return before uninstall", () => {
    const src = read("src/mitm/cert/install.js");
    expect(src).toContain("async function purgeLegacyRootCAs");
    expect(src).toMatch(/await purgeLegacyRootCAs\(sudoPassword\)/);
    expect(src).not.toMatch(/if \(!isInstalled\) \{\s*log\("🔐 Cert: not found/);
    expect(src).toContain("execFileWithSudo");
  });
});

describe("cloudflared — killCloudflaredByPort port guard", () => {
  it("requires an integer port before shelling out", () => {
    const src = read("src/lib/tunnel/cloudflare/cloudflared.js");
    expect(src).toMatch(/Number\.isInteger\(port\)/);
    expect(src).toContain("execFileSync");
  });
});
