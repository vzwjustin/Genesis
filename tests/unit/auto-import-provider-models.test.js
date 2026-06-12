import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = {
  fetchModelsForConnection: vi.fn(),
  getModelAliases: vi.fn(),
  setModelAlias: vi.fn(),
};

vi.mock("../../src/lib/models/fetchConnectionModels.js", () => ({
  fetchModelsForConnection: mocks.fetchModelsForConnection,
}));

vi.mock("@/models", () => ({
  getModelAliases: mocks.getModelAliases,
  setModelAlias: mocks.setModelAlias,
}));

describe("resolveModelAlias", () => {
  it("uses identity alias for standard providers", async () => {
    const { resolveModelAlias } = await import("../../src/lib/models/resolveModelAlias.js");
    expect(resolveModelAlias("gpt-4o-mini", "openai", {})).toBe("gpt-4o-mini");
    expect(resolveModelAlias("gpt-4o-mini", "openai", { "gpt-4o-mini": "openai/gpt-4o-mini" })).toBeNull();
  });

  it("uses prefixed alias for passthrough providers when base alias is taken", async () => {
    const { resolveModelAlias } = await import("../../src/lib/models/resolveModelAlias.js");
    expect(
      resolveModelAlias("anthropic/claude-sonnet-4.6", "openrouter", { "claude-sonnet-4.6": "openrouter/other" }),
    ).toBe("openrouter-claude-sonnet-4.6");
  });
});

describe("autoImportProviderModels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getModelAliases.mockResolvedValue({});
    mocks.setModelAlias.mockResolvedValue(undefined);
  });

  it("imports models not in static catalog", async () => {
    mocks.fetchModelsForConnection.mockResolvedValue({
      models: [{ id: "brand-new-model" }, { id: "gpt-4o" }],
    });

    const { autoImportProviderModels } = await import("../../src/lib/models/autoImportProviderModels.js");
    const result = await autoImportProviderModels({ id: "conn-1", provider: "openai" });

    expect(result.imported).toBe(1);
    expect(mocks.setModelAlias).toHaveBeenCalledWith("brand-new-model", "openai/brand-new-model");
    expect(mocks.setModelAlias).toHaveBeenCalledTimes(1);
  });

  it("strips provider prefix from upstream model ids", async () => {
    mocks.fetchModelsForConnection.mockResolvedValue({
      models: [{ id: "qoder/upstream-only-model" }],
    });

    const { autoImportProviderModels } = await import("../../src/lib/models/autoImportProviderModels.js");
    const result = await autoImportProviderModels({ id: "conn-2", provider: "qoder" });

    expect(result.imported).toBe(1);
    expect(mocks.setModelAlias).toHaveBeenCalledWith("upstream-only-model", "qd/upstream-only-model");
  });

  it("reports upstreamFailure when listing returns no models with warning", async () => {
    mocks.fetchModelsForConnection.mockResolvedValue({
      models: [],
      warning: "Failed to fetch Gemini CLI models: 403 forbidden",
    });

    const { autoImportProviderModels } = await import("../../src/lib/models/autoImportProviderModels.js");
    const result = await autoImportProviderModels({ id: "conn-gemini", provider: "gemini-cli" });

    expect(result.imported).toBe(0);
    expect(result.upstreamFailure).toBe(true);
    expect(result.warning).toContain("Gemini CLI");
  });

  it("fail-open when upstream listing is unsupported", async () => {
    mocks.fetchModelsForConnection.mockResolvedValue({
      error: "Provider cursor does not support models listing",
      status: 400,
    });

    const { autoImportProviderModels } = await import("../../src/lib/models/autoImportProviderModels.js");
    const result = await autoImportProviderModels({ id: "conn-3", provider: "cursor" });

    expect(result.imported).toBe(0);
    expect(mocks.setModelAlias).not.toHaveBeenCalled();
  });
});

describe("createProviderConnection auto-import hook", () => {
  it("calls autoImportProviderModels after connection create", () => {
    const { readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const src = readFileSync(
      join(import.meta.dirname, "../../src/lib/db/repos/connectionsRepo.js"),
      "utf8",
    );
    expect(src).toContain("autoImportProviderModels");
  });
});
