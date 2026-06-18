import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

async function hmacHex(secret, message) {
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

async function buildNewFormatKey(machineId, keyId, secret) {
  const crc = (await hmacHex(secret, machineId + keyId)).slice(0, 8);
  return `sk-${machineId}-${keyId}-${crc}`;
}

describe("cloud apiKey CRC verification", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    delete globalThis.API_KEY_SECRET;
    delete globalThis.LEGACY_API_KEY_SECRET;
  });

  it("accepts keys signed with configured API_KEY_SECRET", async () => {
    vi.stubEnv("API_KEY_SECRET", "production-secret");
    const { parseApiKey } = await import("../../cloud/src/utils/apiKey.js");
    const apiKey = await buildNewFormatKey("machinea", "key1", "production-secret");

    await expect(parseApiKey(apiKey)).resolves.toEqual({
      machineId: "machinea",
      keyId: "key1",
      isNewFormat: true,
    });
  });

  it("rejects legacy-default keys unless LEGACY_API_KEY_SECRET is configured", async () => {
    vi.stubEnv("API_KEY_SECRET", "production-secret");
    const { parseApiKey } = await import("../../cloud/src/utils/apiKey.js");
    const legacyKey = await buildNewFormatKey(
      "machinea",
      "key1",
      "endpoint-proxy-api-key-secret"
    );

    await expect(parseApiKey(legacyKey)).resolves.toBeNull();
  });

  it("accepts legacy keys when LEGACY_API_KEY_SECRET is explicitly configured", async () => {
    vi.stubEnv("API_KEY_SECRET", "production-secret");
    vi.stubEnv("LEGACY_API_KEY_SECRET", "endpoint-proxy-api-key-secret");
    const { parseApiKey } = await import("../../cloud/src/utils/apiKey.js");
    const legacyKey = await buildNewFormatKey(
      "machinea",
      "key1",
      "endpoint-proxy-api-key-secret"
    );

    await expect(parseApiKey(legacyKey)).resolves.toEqual({
      machineId: "machinea",
      keyId: "key1",
      isNewFormat: true,
    });
  });
});
