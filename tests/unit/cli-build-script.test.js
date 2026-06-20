import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");

describe("CLI build script", () => {
  it("supports Next standalone output nested under the workspace directory", () => {
    const script = readFileSync(join(root, "cli/scripts/build-cli.js"), "utf8");

    expect(script).toContain("findStandaloneApp");
    expect(script).toContain("fs.readdirSync(standaloneRootToUse");
    expect(script).toContain('path.join(standaloneRootToUse, entry.name)');
  });

  it("purges stale webpack cache before Next.js build", () => {
    const script = readFileSync(join(root, "cli/scripts/build-cli.js"), "utf8");

    expect(script).toContain('path.join(buildDistDir, "cache", "webpack")');
    expect(script).toContain("fs.rmSync(webpackCacheDir");
  });

  it("CLI process cleanup does not match unrelated next-server processes", () => {
    const cli = readFileSync(join(root, "cli/cli.js"), "utf8");
    const matcher = cli.match(/function isAppProcessCmdline[\s\S]*?\n\}/)?.[0] || "";

    expect(matcher).not.toContain('cmd.includes("next-server")');
    expect(matcher).toContain("normalizedServerPath");
  });
});
