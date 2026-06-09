import { requireRouteAuth } from "@/sse/utils/routeAuth.js";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { internalApiGet } from "@/lib/internalApi.js";

// Provider → internal voices API path (loopback via internalApiGet).
const PROVIDER_API = {
  elevenlabs: "/api/media-providers/tts/elevenlabs/voices",
  deepgram: "/api/media-providers/tts/deepgram/voices",
  inworld: "/api/media-providers/tts/inworld/voices",
  "edge-tts": "/api/media-providers/tts/voices?provider=edge-tts",
  "local-device": "/api/media-providers/tts/voices?provider=local-device",
};

export async function OPTIONS() {
  return new Response(null, {
    headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" },
  });
}

// GET /v1/audio/voices?provider={p}[&lang=xx]
// Returns OpenAI-style list with each voice's full model id ready for /v1/audio/speech
export async function GET(request) {
  const routeAuth = await requireRouteAuth(request);
  if (!routeAuth.ok) return routeAuth.response;

  try {
    const { searchParams } = new URL(request.url);
    const provider = searchParams.get("provider");
    const lang = searchParams.get("lang");

    if (!provider || !PROVIDER_API[provider]) {
      return Response.json(
        { error: { message: `provider must be one of: ${Object.keys(PROVIDER_API).join(", ")}`, type: "invalid_request_error" } },
        { status: 400, headers: { "Access-Control-Allow-Origin": "*" } },
      );
    }

    const basePath = PROVIDER_API[provider];
    const path = lang
      ? `${basePath}${basePath.includes("?") ? "&" : "?"}lang=${encodeURIComponent(lang)}`
      : basePath;
    const res = await internalApiGet(path, { cache: "no-store" });
    let data;
    try {
      data = await res.json();
    } catch {
      return Response.json(
        { error: { message: "Invalid JSON from voices upstream", type: "server_error" } },
        { status: 502, headers: { "Access-Control-Allow-Origin": "*" } },
      );
    }
    if (!res.ok || data.error) {
      return Response.json(
        { error: { message: data.error || `Upstream ${res.status}`, type: "server_error" } },
        { status: res.status, headers: { "Access-Control-Allow-Origin": "*" } },
      );
    }

    // Internal API shape: { voices } when lang filter, else { byLang, languages }
    const rawVoices = lang
      ? (data.voices || [])
      : Object.values(data.byLang || {}).flatMap((l) => l.voices || []);

    // Use provider alias for /v1/audio/speech model param (matches skill convention e.g. el/, dg/, edge-tts/)
    const alias = AI_PROVIDERS[provider]?.alias || provider;
    const data_out = rawVoices.map((v) => ({
      id: v.id,
      name: v.name,
      lang: v.lang || "",
      gender: v.gender || "",
      model: `${alias}/${v.id}`,
    }));

    return Response.json({ object: "list", data: data_out }, {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  } catch (err) {
    return Response.json(
      { error: { message: err.message || "Failed", type: "server_error" } },
      { status: 502, headers: { "Access-Control-Allow-Origin": "*" } },
    );
  }
}
