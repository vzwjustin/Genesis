import { handleChat } from "@/sse/handlers/chat.js";
import { initTranslators } from "open-sse/translator/index.js";
import { getApiKeys, getSettings } from "@/lib/localDb";

let initialized = false;

async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
  }
}

/**
 * Dashboard chat completions — session-protected proxy to the main chat handler.
 * Injects an internal API key when requireApiKey=true so logged-in users need not
 * paste a key into the Basic Chat UI.
 */
export async function POST(request) {
  await ensureInitialized();

  const settings = await getSettings();
  const headers = new Headers(request.headers);
  const hasCredential = headers.get("Authorization")?.startsWith("Bearer ") || headers.get("x-api-key");

  if (settings.requireApiKey && !hasCredential) {
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
