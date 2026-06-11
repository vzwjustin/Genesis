import crypto from "crypto";
import fs from "fs";
import path from "path";
import { DATA_DIR } from "@/lib/dataDir";

const SECRET_FILE = path.join(DATA_DIR, "auth", "api-key-secret");
const LEGACY_DEFAULT = "endpoint-proxy-api-key-secret";

let cachedSecret = null;

/**
 * Per-install API key HMAC secret. Persisted on first use so CRCs are not
 * forgeable with the hardcoded legacy default.
 */
export function getApiKeySecret() {
  if (process.env.API_KEY_SECRET) return process.env.API_KEY_SECRET;
  if (cachedSecret) return cachedSecret;

  try {
    const fromFile = fs.readFileSync(SECRET_FILE, "utf8").trim();
    if (fromFile) {
      cachedSecret = fromFile;
      return cachedSecret;
    }
  } catch {
    // generate below
  }

  cachedSecret = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
    fs.writeFileSync(SECRET_FILE, cachedSecret, { mode: 0o600 });
  } catch (e) {
    console.warn("[apiKeySecret] Could not persist secret, using in-memory only:", e.message);
  }
  return cachedSecret;
}

/** @deprecated exposed for tests verifying migration away from legacy default */
export const LEGACY_API_KEY_SECRET = LEGACY_DEFAULT;
