import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

describe("Kiro MITM tool rounds", () => {
  it("does not passthrough tool rounds — intercept handles toolResults and toolUses", () => {
    const serverSrc = readFileSync(join(root, "../../src/mitm/server.js"), "utf8");
    expect(serverSrc).not.toContain("kiroRequiresPassthrough");
    expect(serverSrc).not.toMatch(/kiro passthrough \(tool round\)/);
  });
});
