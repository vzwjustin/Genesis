import { handleChat } from "@/sse/handlers/chat.js";
// initTranslators is synchronous and guarded by its own module-level flag;
// no route-level wrapper is needed.
import { initTranslators } from "open-sse/translator/index.js";

initTranslators();

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

export async function POST(request) {
  return await handleChat(request);
}

