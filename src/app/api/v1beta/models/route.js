import { requireRouteAuth } from "@/sse/utils/routeAuth.js";
import { buildModelsList } from "../../v1/models/route.js";

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

/**
 * GET /v1beta/models - Gemini compatible models list
 * Returns models in Gemini API format, filtered like /v1/models.
 */
export async function GET(request) {
  const routeAuth = await requireRouteAuth(request);
  if (!routeAuth.ok) return routeAuth.response;

  try {
    const { models: openAiModels } = await buildModelsList(["llm"]);
    const models = openAiModels.map((model) => ({
      name: `models/${model.id}`,
      displayName: model.id.includes("/") ? model.id.split("/").slice(1).join("/") : model.id,
      description: `${model.owned_by || "provider"} model: ${model.id}`,
      supportedGenerationMethods: ["generateContent"],
      inputTokenLimit: 128000,
      outputTokenLimit: 8192,
    }));

    return Response.json({ models });
  } catch (error) {
    console.log("Error fetching models:", error);
    return Response.json({ error: { message: error.message } }, { status: 500 });
  }
}
