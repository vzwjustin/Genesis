import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

describe("mitm cert install — macOS trust check", () => {
  it("checkCertInstalledMac uses verify-cert (CN-agnostic, no CN name lookup)", () => {
    const src = fs.readFileSync(
      path.join(import.meta.dirname, "..", "..", "src", "mitm", "cert", "install.js"),
      "utf8",
    );
    const fn = src.slice(src.indexOf("function checkCertInstalledMac"), src.indexOf("function checkCertInstalledWindows"));
    expect(fn).toContain("verify-cert");
    expect(fn).not.toContain('find-certificate -a -c "Genesis MITM Root CA"');
    expect(src).toContain("9Router MITM Root CA");
  });

  it.skipIf(process.platform !== "darwin")(
    "detects trusted migrated 9Router root CA on disk",
    async () => {
      const cert = path.join(process.env.HOME, ".genesis/mitm/rootCA.crt");
      if (!fs.existsSync(cert)) return;

      const { checkCertInstalled } = await import("../../src/mitm/cert/install.js");
      expect(await checkCertInstalled(cert)).toBe(true);
    },
  );
});
