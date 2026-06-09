import crypto from "crypto";

export const TEST_API_KEY_SECRET = "test-api-key-secret-for-vitest";

/** Pin HMAC secret so generated keys are deterministic in unit tests. */
export function useTestApiKeySecret() {
  process.env.API_KEY_SECRET = TEST_API_KEY_SECRET;
}

/** Build sk-{machineId}-{keyId}-{crc8} using the test secret. */
export function makeTestApiKey(machineId = "deadbeef", keyId = "validk") {
  const crc = crypto
    .createHmac("sha256", TEST_API_KEY_SECRET)
    .update(machineId + keyId)
    .digest("hex")
    .slice(0, 8);
  return `sk-${machineId}-${keyId}-${crc}`;
}
