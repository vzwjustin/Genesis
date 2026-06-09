import { getApiKeys } from "@/lib/localDb";
import { UPDATER_CONFIG } from "@/shared/constants/config";
import { getConsistentMachineId } from "@/shared/utils/machineId";

const CLI_TOKEN_SALT = "9r-cli-auth";
const DEFAULT_TIMEOUT_MS = 15000;

export function getInternalBaseUrl() {
  return `http://127.0.0.1:${process.env.PORT || UPDATER_CONFIG.appPort}`;
}

export async function buildInternalApiHeaders(extra = {}) {
  const headers = { "Content-Type": "application/json", ...extra };
  try {
    const keys = await getApiKeys();
    const apiKey = keys.find((k) => k.isActive !== false)?.key || null;
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  } catch {}
  headers["x-9r-cli-token"] = await getConsistentMachineId(CLI_TOKEN_SALT);
  return headers;
}

/**
 * Loopback fetch to this server's API routes (dashboard self-test harness).
 */
export async function internalApiFetch(path, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, headers: extraHeaders, ...rest } = options;
  const headers = await buildInternalApiHeaders(extraHeaders);
  return fetch(`${getInternalBaseUrl()}${path}`, {
    ...rest,
    headers,
    signal: rest.signal ?? AbortSignal.timeout(timeoutMs),
  });
}

export async function internalApiPost(path, body, options = {}) {
  const res = await internalApiFetch(path, {
    method: "POST",
    body: JSON.stringify(body),
    ...options,
  });
  const rawText = await res.text().catch(() => "");
  let parsed = null;
  let parseError = null;
  if (rawText) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parseError = "Invalid JSON response";
    }
  } else if (res.ok) {
    parseError = "Empty response body";
  }
  return { res, rawText, parsed, parseError };
}

export async function internalApiGet(path, options = {}) {
  return internalApiFetch(path, { method: "GET", ...options });
}
