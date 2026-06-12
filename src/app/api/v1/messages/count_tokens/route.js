import { requireRouteAuth } from "@/sse/utils/routeAuth.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "*"
};

function estimateContentLength(content) {
  if (content == null) return 0;
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return JSON.stringify(content).length;

  let total = 0;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && part.text) {
      total += part.text.length;
    } else {
      total += JSON.stringify(part).length;
    }
  }
  return total;
}

function estimateSystemLength(system) {
  if (system == null) return 0;
  if (typeof system === "string") return system.length;
  if (Array.isArray(system)) return estimateContentLength(system);
  return JSON.stringify(system).length;
}

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, { headers: CORS_HEADERS });
}

/**
 * POST /v1/messages/count_tokens - Mock token count response
 */
export async function POST(request) {
  const routeAuth = await requireRouteAuth(request);
  if (!routeAuth.ok) return routeAuth.response;

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS }
    });
  }

  let totalChars = estimateSystemLength(body.system);

  if (Array.isArray(body.tools)) {
    totalChars += JSON.stringify(body.tools).length;
  }

  const messages = body.messages || [];
  for (const msg of messages) {
    totalChars += estimateContentLength(msg.content);
    if (msg.tool_calls) {
      totalChars += JSON.stringify(msg.tool_calls).length;
    }
    if (msg.tool_use_id) {
      totalChars += String(msg.tool_use_id).length;
    }
  }

  const inputTokens = Math.ceil(totalChars / 4);

  return new Response(JSON.stringify({
    input_tokens: inputTokens
  }), {
    headers: { "Content-Type": "application/json", ...CORS_HEADERS }
  });
}
