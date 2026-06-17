import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));

function read(rel) {
  return readFileSync(join(root, "../..", rel), "utf8");
}

describe("CLI config writer escaping", () => {
  it("escapes jcode env values before writing provider-genesis.env", () => {
    const src = read("src/app/api/cli-tools/jcode-settings/route.js");
    expect(src).toContain("quoteEnvValue");
    expect(src).toContain("isEnvKey(key)");
    expect(src).not.toContain('`${key}="${value}"');
  });

  it("uses quoted serializers for Hermes YAML and env writes", () => {
    const src = read("src/app/api/cli-tools/hermes-settings/route.js");
    expect(src).toContain("yamlString");
    expect(src).toContain("quoteEnvValue");
    expect(src).toContain("default: ${yamlString(model)}");
    expect(src).toContain("base_url: ${yamlString(baseUrl)}");
    expect(src).toContain("${key}=${quoteEnvValue(value)}");
  });

  it("uses quoted serializers for DeepSeek TOML values", () => {
    const src = read("src/app/api/cli-tools/deepseek-tui-settings/route.js");
    expect(src).toContain("tomlString");
    expect(src).toContain("base_url = ${tomlString(normalizedBaseUrl)}");
    expect(src).toContain("api_key = ${tomlString(apiKey)}");
    expect(src).toContain("model = ${tomlString(model)}");
  });
});

describe("translator debug route hardening", () => {
  it("marks translator debug APIs as local-only and masks generated headers", () => {
    const guard = read("src/dashboardGuard.js");
    const translateRoute = read("src/app/api/translator/translate/route.js");

    expect(guard).toContain('"/api/translator/"');
    expect(translateRoute).toContain("maskSensitiveHeaders");
  });
});
