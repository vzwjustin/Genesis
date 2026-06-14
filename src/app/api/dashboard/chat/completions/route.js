import { handleChat } from "@/sse/handlers/chat.js";
import { initTranslators } from "open-sse/translator/index.js";
import { getApiKeys, getSettingsSafe, validateApiKey } from "@/lib/localDb";
import { isLoopbackRequest } from "@/shared/utils/loopbackRequest.js";
import {
  getGatewayApiKeyCandidates,
  isLocalhostSentinelKey,
  looksLikegenesisApiKey,
  PROVIDER_API_KEY_HEADER_NAMES,
  verifyApiKeyCrc,
} from "@/shared/utils/apiKey.js";

let initialized = false;

async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
  }
}

async function getUsableGatewayKey(request) {
  for (const token of getGatewayApiKeyCandidates(request)) {
    if (isLocalhostSentinelKey(token)) {
      if (isLoopbackRequest(request)) return token;
      continue;
    }
    if (verifyApiKeyCrc(token) && await validateApiKey(token)) return token;
  }
  return null;
}

async function shouldInjectGatewayKey(request, settings) {
  if (await getUsableGatewayKey(request)) return false;
  if (settings?.requireApiKey === true) return true;
  // Remote/tunnel dashboard sessions cannot use loopback no-auth bypass in handleChat.
  return !isLoopbackRequest(request);
}

/** Remove stale gateway credentials; keep the usable key and sentinel values. */
function stripStaleGatewayHeaders(headers, preserveToken = null) {
  const staleXApiKey = headers.get("x-api-key")?.trim();
  if (
    staleXApiKey
    && looksLikegenesisApiKey(staleXApiKey)
    && !isLocalhostSentinelKey(staleXApiKey)
    && staleXApiKey !== preserveToken
  ) {
    headers.delete("x-api-key");
  }
  const auth = headers.get("Authorization")?.trim();
  if (auth) {
    const bearerMatch = auth.match(/^Bearer\s+(.+)$/i);
    const apiKeyMatch = auth.match(/^Api-?Key\s+(.+)$/i);
    const tokenSchemeMatch = auth.match(/^Token\s+(.+)$/i);
    const token = bearerMatch?.[1]?.trim()
      ?? apiKeyMatch?.[1]?.trim()
      ?? tokenSchemeMatch?.[1]?.trim()
      ?? (/^sk[-_]/i.test(auth) ? auth : null);
    if (
      token
      && looksLikegenesisApiKey(token)
      && !isLocalhostSentinelKey(token)
      && token !== preserveToken
    ) {
      headers.delete("Authorization");
    }
  }
  for (const name of PROVIDER_API_KEY_HEADER_NAMES) {
    const value = headers.get(name)?.trim();
    if (
      value
      && looksLikegenesisApiKey(value)
      && !isLocalhostSentinelKey(value)
      && value !== preserveToken
    ) {
      headers.delete(name);
    }
  }
}

/**
 * Dashboard chat completions — session-protected proxy to the main chat handler.
 * Injects an internal API key when requireApiKey=true so logged-in users need not
 * paste a key into the Basic Chat UI.
 */
export async function POST(request) {
  await ensureInitialized();

  const settings = await getSettingsSafe();
  const headers = new Headers(request.headers);

  const needsInject = await shouldInjectGatewayKey(request, settings);
  const usableKey = await getUsableGatewayKey(request);
  if (needsInject || usableKey) {
    stripStaleGatewayHeaders(headers, usableKey);
  }
  if (needsInject) {
    try {
      const keys = await getApiKeys();
      const apiKey = keys.find((k) => k.isActive !== false)?.key;
      if (apiKey) {
        headers.set("Authorization", `Bearer ${apiKey}`);
      }
    } catch {
      // Fall through — handleChat will return 401 if key is required but missing
    }
  }

  const body = await request.text();
  const internalRequest = new Request(new URL("/api/v1/chat/completions", request.url), {
    method: "POST",
    headers,
    body,
  });

  return handleChat(internalRequest);
}
