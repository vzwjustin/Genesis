/**
 * Build and runtime verification tests (Task 20)
 * Requirements: 1.6
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");

describe("build verification (Task 20)", () => {
  it("AGENTS.md documents webpack cache clearing for open-sse edits", () => {
    const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
    expect(agents).toContain(".next-cli-build/cache/webpack");
    expect(agents).toContain("open-sse/");
  });

  it("Anthropic built-in tool model-prefix fix exists in claudeHelper source", () => {
    const src = readFileSync(join(root, "open-sse/translator/helpers/claudeHelper.js"), "utf8");
    expect(src).toContain("stripProviderModelPrefix");
    expect(src).toMatch(/KNOWN_TOOL_MODEL_PREFIXES/);
  });

  it("headless server entrypoint exists (built server.js or cli wrapper)", () => {
    const builtServer = join(root, "cli/app/server.js");
    const cliWrapper = join(root, "cli/cli.js");
    expect(existsSync(builtServer) || existsSync(cliWrapper)).toBe(true);
  });

  it("CLI build script references standalone output discovery", () => {
    const script = readFileSync(join(root, "cli/scripts/build-cli.js"), "utf8");
    expect(script).toContain("findStandaloneApp");
    expect(script).toContain(".next-cli-build");
  });

  it("CLI build script clears webpack cache before rebuild", () => {
    const script = readFileSync(join(root, "cli/scripts/build-cli.js"), "utf8");
    expect(script).toContain("cache/webpack");
    expect(script).toMatch(/rmSync|rm\(/);
  });

  it("compiled CLI chunks contain Anthropic tool model-prefix strip when build exists", () => {
    const chunksDir = join(root, "cli/app/.next-cli-build/server/chunks");
    if (!existsSync(chunksDir)) return;

    const hit = readdirSync(chunksDir)
      .filter((name) => name.endsWith(".js"))
      .some((name) => readFileSync(join(chunksDir, name), "utf8").includes('indexOf("/")+1'));

    expect(hit).toBe(true);
  });
});
