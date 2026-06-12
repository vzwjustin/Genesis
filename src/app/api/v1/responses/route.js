import { handleChat } from "@/sse/handlers/chat.js";
import { initTranslators } from "open-sse/translator/index.js";

let initialized = false;

async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
  }
}

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

/**
 * POST /v1/responses - OpenAI Responses API format
 *
 * Handled by handleChat → chatCore (openai-responses format auto-detected via
 * provider.js / formats.js). Responses-specific SSE assembly lives in
 * open-sse/handlers/chatCore/sseToJsonHandler.js — not a separate handler module.
 */
export async function POST(request) {
  await ensureInitialized();
  return await handleChat(request);
}
