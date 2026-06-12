import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-dash-r34-"));
  process.env.DATA_DIR = tempDir;
  try { global._dbAdapter?.instance?.close?.(); } catch { /* ignore */ }
  delete global._dbAdapter;
  vi.resetModules();
  const db = await import("../../src/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch { /* ignore */ }
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("models barrel exports swapProviderConnectionPriorities", () => {
  it("re-exports swapProviderConnectionPriorities from @/models", async () => {
    const models = await import("../../src/models/index.js");
    expect(typeof models.swapProviderConnectionPriorities).toBe("function");
  });
});

describe("diffPricingOverrides per-field tombstones", () => {
  it("emits null for cleared fields while keeping other overrides", async () => {
    const { diffPricingOverrides } = await import("../../src/shared/utils/dashboardHelpers.js");
    const { getDefaultPricing } = await import("../../src/shared/constants/pricing.js");
    const defaults = getDefaultPricing();
    const current = structuredClone(defaults);
    current.models["gpt-4o"].output = 77;
    const existingOverrides = {
      models: {
        "gpt-4o": { input: 99, output: 18 },
      },
    };

    const overrides = diffPricingOverrides(current, defaults, existingOverrides);
    expect(overrides.models["gpt-4o"]).toEqual({ input: null, output: 77 });
  });
});

describe("pricingRepo round-3 fixes", () => {
  beforeEach(async () => {
    const { resetAllPricing } = await import("../../src/lib/db/repos/pricingRepo.js");
    await resetAllPricing();
  });

  it("updatePricing returns merged catalog via getPricing", async () => {
    const { updatePricing } = await import("../../src/lib/db/repos/pricingRepo.js");
    const { getDefaultPricing } = await import("../../src/shared/constants/pricing.js");
    const defaults = getDefaultPricing();

    const merged = await updatePricing({
      models: { "gpt-4o": { input: 77 } },
    });

    expect(merged.models["gpt-4o"].input).toBe(77);
    expect(merged.models["gpt-4o"].output).toBe(defaults.models["gpt-4o"].output);
  });

  it("deletes provider KV row when last model override is cleared", async () => {
    const { updatePricing, getUserPricingOverrides } = await import(
      "../../src/lib/db/repos/pricingRepo.js"
    );

    await updatePricing({
      models: { "gpt-4o": { input: 55 } },
    });
    expect((await getUserPricingOverrides()).models?.["gpt-4o"]).toBeTruthy();

    await updatePricing({ models: { "gpt-4o": null } });
    expect((await getUserPricingOverrides()).models).toBeUndefined();
  });

  it("getPricingForModel merges partial overrides with defaults", async () => {
    const { updatePricing, getPricingForModel } = await import(
      "../../src/lib/db/repos/pricingRepo.js"
    );
    const { getDefaultPricing } = await import("../../src/shared/constants/pricing.js");
    const defaults = getDefaultPricing();

    await updatePricing({ models: { "gpt-4o": { input: 42 } } });
    const pricing = await getPricingForModel("openai", "gpt-4o");

    expect(pricing.input).toBe(42);
    expect(pricing.output).toBe(defaults.models["gpt-4o"].output);
  });
});

describe("connectionsRepo priority 0 and sort", () => {
  beforeEach(async () => {
    const { getAdapter } = await import("../../src/lib/db/driver.js");
    const db = await getAdapter();
    db.run(`DELETE FROM providerConnections`);
  });

  it("sorts priority 0 before priority 1", async () => {
    const { createProviderConnection, getProviderConnections } = await import(
      "../../src/lib/db/repos/connectionsRepo.js"
    );
    const provider = `priority-zero-${Date.now()}`;
    await createProviderConnection({
      provider,
      authType: "apikey",
      name: "High",
      priority: 1,
      apiKey: "k1",
    });
    await createProviderConnection({
      provider,
      authType: "apikey",
      name: "Zero",
      priority: 0,
      apiKey: "k0",
    });

    const list = await getProviderConnections({ provider });
    expect(list.map((c) => c.name)).toEqual(["Zero", "High"]);
  });
});

describe("settingsRepo nested map merges", () => {
  beforeEach(async () => {
    const { updateSettings } = await import("../../src/lib/db/repos/settingsRepo.js");
    await updateSettings({
      rtkFilterConfig: { "git-diff": true, grep: true },
      dnsToolEnabled: { "1.1.1.1": true, "8.8.8.8": true },
    });
  });

  it("patches rtkFilterConfig without wiping other keys", async () => {
    const { updateSettings, getSettings } = await import("../../src/lib/db/repos/settingsRepo.js");
    await updateSettings({ rtkFilterConfig: { grep: false } });
    const settings = await getSettings();
    expect(settings.rtkFilterConfig["git-diff"]).toBe(true);
    expect(settings.rtkFilterConfig.grep).toBe(false);
  });

  it("removes dnsToolEnabled entry with null tombstone", async () => {
    const { updateSettings, getSettings } = await import("../../src/lib/db/repos/settingsRepo.js");
    await updateSettings({ dnsToolEnabled: { "1.1.1.1": null } });
    const settings = await getSettings();
    expect(settings.dnsToolEnabled["1.1.1.1"]).toBeUndefined();
    expect(settings.dnsToolEnabled["8.8.8.8"]).toBe(true);
  });
});

describe("db export/import disabledModels", () => {
  beforeEach(async () => {
    const { getAdapter } = await import("../../src/lib/db/driver.js");
    const db = await getAdapter();
    db.run(`DELETE FROM kv WHERE scope = 'disabledModels'`);
  });

  it("round-trips disabledModels through exportDb/importDb", async () => {
    const { disableModels, getDisabledModels } = await import(
      "../../src/lib/db/repos/disabledModelsRepo.js"
    );
    const { exportDb, importDb } = await import("../../src/lib/db/index.js");

    await disableModels("openai", ["gpt-4o"]);
    const exported = await exportDb();
    expect(exported.disabledModels?.openai).toContain("gpt-4o");

    const db = await (await import("../../src/lib/db/driver.js")).getAdapter();
    db.run(`DELETE FROM kv WHERE scope = 'disabledModels'`);

    await importDb(exported);
    const restored = await getDisabledModels();
    expect(restored.openai).toContain("gpt-4o");
  });
});

describe("driver initPromise recovery", () => {
  it("clears initPromise after init failure so a later call can retry", async () => {
    const state = global._dbAdapter;
    const saved = { instance: state.instance, initPromise: state.initPromise };
    state.instance = null;
    state.initPromise = null;

    const failingInit = Promise.reject(new Error("init failed")).catch((err) => {
      state.initPromise = null;
      throw err;
    });
    state.initPromise = failingInit;

    await expect(failingInit).rejects.toThrow("init failed");
    expect(state.initPromise).toBeNull();

    state.instance = saved.instance;
    state.initPromise = saved.initPromise;
  });
});

describe("custom models API duplicate guard", () => {
  beforeEach(async () => {
    const { getAdapter } = await import("../../src/lib/db/driver.js");
    const db = await getAdapter();
    db.run(`DELETE FROM kv WHERE scope = 'customModels'`);
  });

  it("addCustomModel returns false for duplicate keys", async () => {
    const { addCustomModel } = await import("../../src/lib/db/repos/aliasRepo.js");
    const model = { providerAlias: "openai", id: "my-model", type: "llm", name: "My Model" };
    expect(await addCustomModel(model)).toBe(true);
    expect(await addCustomModel(model)).toBe(false);
  });
});

describe("fetchModelsForConnection anthropic-compatible 401 retry", () => {
  const mocks = {
    proxyAwareFetch: vi.fn(),
    checkAndRefreshToken: vi.fn(),
    refreshTokenByProvider: vi.fn(),
    updateProviderCredentials: vi.fn(),
    resolveConnectionProxyConfig: vi.fn(),
  };

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.resolveConnectionProxyConfig.mockResolvedValue({});
    mocks.checkAndRefreshToken.mockImplementation(async (_provider, creds) => ({ ...creds }));
    mocks.updateProviderCredentials.mockResolvedValue(true);

    vi.doMock("open-sse/utils/proxyFetch.js", () => ({
      proxyAwareFetch: mocks.proxyAwareFetch,
    }));
    vi.doMock("@/lib/network/connectionProxy", () => ({
      resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
    }));
    vi.doMock("@/sse/services/tokenRefresh", () => ({
      checkAndRefreshToken: mocks.checkAndRefreshToken,
      refreshTokenByProvider: mocks.refreshTokenByProvider,
      refreshCopilotToken: vi.fn(),
      updateProviderCredentials: mocks.updateProviderCredentials,
    }));
    vi.doMock("open-sse/services/projectId.js", () => ({
      getProjectIdForConnection: vi.fn(),
    }));
  });

  it("retries anthropic-compatible /models after 401 when refresh succeeds", async () => {
    const connection = {
      id: "conn-anthropic-compat",
      provider: "anthropic-compatible-custom",
      apiKey: "stale-key",
      refreshToken: "refresh",
      providerSpecificData: { baseUrl: "https://anthropic-compatible.test/v1" },
    };

    mocks.proxyAwareFetch
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => "unauthorized" })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "claude-3-opus" }] }),
      });

    mocks.refreshTokenByProvider.mockResolvedValue({
      accessToken: "fresh-token",
      refreshToken: "refresh",
      expiresIn: 3600,
    });

    const { fetchModelsForConnection } = await import("../../src/lib/models/fetchConnectionModels.js");
    const result = await fetchModelsForConnection(connection);

    expect(result.models).toHaveLength(1);
    expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(2);
    expect(mocks.refreshTokenByProvider).toHaveBeenCalled();
  });
});
