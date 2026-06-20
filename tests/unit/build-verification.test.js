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

  it("Anthropic built-in tool model-prefix fix exists in helper source", () => {
    // claudeHelper re-exports the strip; the prefix table lives in anthropicToolModel.js.
    const helper = readFileSync(join(root, "open-sse/translator/helpers/claudeHelper.js"), "utf8");
    expect(helper).toContain("stripProviderModelPrefix");
    const toolModel = readFileSync(join(root, "open-sse/translator/helpers/anthropicToolModel.js"), "utf8");
    expect(toolModel).toMatch(/KNOWN_TOOL_MODEL_PREFIXES/);
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

    // Stable marker from anthropicToolModel.js prefix table / fallback (survives minification).
    const hit = readdirSync(chunksDir)
      .filter((name) => name.endsWith(".js"))
      .some((name) => {
        const src = readFileSync(join(chunksDir, name), "utf8");
        return src.includes("claude-opus-4-8") && src.includes("cc/") && /(lastIndexOf|indexOf)\("\/"\)\+1/.test(src);
      });

    expect(hit).toBe(true);
  });

  it("compiled CLI chunks bundle openai-to-cursor translator (not createRequire-only)", () => {
    const chunksDir = join(root, "cli/app/.next-cli-build/server/chunks");
    if (!existsSync(chunksDir)) return;

    const chunks = readdirSync(chunksDir)
      .filter((name) => name.endsWith(".js"))
      .map((name) => readFileSync(join(chunksDir, name), "utf8"));

    const hasCursorTranslatorBody = chunks.some((src) =>
      src.includes("Cursor does not support remote image_url content blocks"),
    );
    const usesRuntimeCreateRequireForTranslators = chunks.some((src) =>
      src.includes("createRequire") && src.includes("open-sse/translator/index.js"),
    );

    expect(hasCursorTranslatorBody).toBe(true);
    expect(usesRuntimeCreateRequireForTranslators).toBe(false);
  });

  it("compiled fix verifier fails when CLI build is missing", () => {
    const script = readFileSync(join(root, "scripts/verify-compiled-anthropic-fix.sh"), "utf8");
    expect(script).toContain("FAIL: no CLI build");
    expect(script).not.toContain("SKIP: no CLI build");
  });
});
