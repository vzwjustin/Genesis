import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");

describe("PR #74 Gemini follow-up", () => {
  it("cloud apiKey timingSafeStrEqual avoids early length return", () => {
    const src = readFileSync(join(root, "cloud/src/utils/apiKey.js"), "utf8");
    expect(src).toContain("sa.length ^ sb.length");
    expect(src).not.toMatch(/if\s*\(\s*sa\.length\s*!==\s*sb\.length\s*\)\s*\{\s*return false/s);
  });

  it("base executor propagates client abort without retry", () => {
    const src = readFileSync(join(root, "open-sse/executors/base.js"), "utf8");
    expect(src).toContain("if (signal?.aborted) throw error;");
  });
});
