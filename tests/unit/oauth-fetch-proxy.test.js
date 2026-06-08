/**
 * OAuth HTTP routing through proxyAwareFetch
 * No mocks: source inspection audit across oauth modules.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const oauthRoot = join(dirname(fileURLToPath(import.meta.url)), "../../src/lib/oauth");

function listJsFiles(dir) {
  const entries = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (name.isDirectory()) entries.push(...listJsFiles(path));
    else if (name.name.endsWith(".js")) entries.push(path);
  }
  return entries;
}

describe("oauthFetch helper", () => {
  it("delegates to proxyAwareFetch with null proxy options", () => {
    const src = readFileSync(join(oauthRoot, "utils/oauthFetch.js"), "utf8");
    expect(src).toContain("proxyAwareFetch");
    expect(src).toContain("return proxyAwareFetch(url, init, proxyOptions)");
    expect(src).toContain("proxyOptions = null");
    expect(src).not.toMatch(/\bfetch\s*\(/);
  });

  it("oauthFetchWithTimeout uses AbortController", () => {
    const src = readFileSync(join(oauthRoot, "utils/oauthFetch.js"), "utf8");
    expect(src).toContain("AbortController");
    expect(src).toContain("oauthFetchWithTimeout");
  });
});

describe("OAuth module bare fetch audit", () => {
  it("does not use bare fetch() in oauth services or providers", () => {
    const offenders = [];
    for (const file of listJsFiles(oauthRoot)) {
      const src = readFileSync(file, "utf8");
      if (/\bfetch\s*\(/.test(src)) offenders.push(file.replace(oauthRoot + "/", ""));
    }
    expect(offenders).toEqual([]);
  });

  it("routes oauth HTTP through oauthFetch or proxyAwareFetch", () => {
    const providersSrc = readFileSync(join(oauthRoot, "providers.js"), "utf8");
    expect(providersSrc).toContain("oauthFetch");
    expect(providersSrc).not.toMatch(/\bfetch\s*\(/);

    const kiroSrc = readFileSync(join(oauthRoot, "services/kiro.js"), "utf8");
    expect(kiroSrc).toContain("proxyAwareFetch");
    expect(kiroSrc).not.toMatch(/\bfetch\s*\(/);
  });
});

describe("OIDC auth module proxy parity", () => {
  it("oidc.js uses oauthFetch not bare fetch", () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../src/lib/auth/oidc.js"),
      "utf8"
    );
    expect(src).toContain("oauthFetch");
    expect(src).not.toMatch(/\bfetch\s*\(/);
  });
});
