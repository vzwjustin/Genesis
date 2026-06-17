import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getApiKeys: vi.fn(),
  getConsistentMachineId: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getApiKeys: mocks.getApiKeys,
}));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: mocks.getConsistentMachineId,
}));

describe("buildInternalApiHeaders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
  });

  it("includes Bearer API key and CLI token when keys load successfully", async () => {
    mocks.getApiKeys.mockResolvedValue([{ key: "sk-test-key", isActive: true }]);
    const { buildInternalApiHeaders } = await import("../../src/lib/internalApi.js");
    const headers = await buildInternalApiHeaders();

    expect(headers.Authorization).toBe("Bearer sk-test-key");
    expect(headers["x-9r-cli-token"]).toBe("cli-token");
  });

  it("propagates getApiKeys failure instead of swallowing it", async () => {
    const dbError = new Error("db unavailable");
    mocks.getApiKeys.mockRejectedValue(dbError);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { buildInternalApiHeaders } = await import("../../src/lib/internalApi.js");

    await expect(buildInternalApiHeaders()).rejects.toThrow("db unavailable");
    expect(consoleSpy).toHaveBeenCalledWith("[internalApi] Failed to load API keys:", dbError);
    consoleSpy.mockRestore();
  });
});
