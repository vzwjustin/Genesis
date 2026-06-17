import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");

describe("CLI default bind host", () => {
  it("defaults to loopback-only 127.0.0.1 (not 0.0.0.0)", () => {
    const src = readFileSync(join(root, "cli/cli.js"), "utf8");
    expect(src).toContain('const DEFAULT_HOST = "127.0.0.1"');
    expect(src).not.toContain('const DEFAULT_HOST = "0.0.0.0"');
  });

  it("keeps --host flag for explicit bind override", () => {
    const src = readFileSync(join(root, "cli/cli.js"), "utf8");
    expect(src).toContain("--host");
    expect(src).toContain("HOSTNAME: host");
  });
});
