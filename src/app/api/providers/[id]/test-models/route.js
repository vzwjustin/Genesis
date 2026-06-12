import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/lib/localDb";
import { getProviderModels, PROVIDER_ID_TO_ALIAS } from "open-sse/config/providerModels.js";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "@/shared/constants/providers";
import { internalApiGet, internalApiPost } from "@/lib/internalApi.js";
import { requireSpawnRouteAuth } from "@/lib/auth/spawnRouteAuth";

/**
 * Ping a single model via internal completions endpoint (OpenAI format).
 * open-sse handles all provider translation automatically.
 */
async function pingModel(modelId) {
  const start = Date.now();
  try {
    const { res, parsed, parseError } = await internalApiPost("/api/v1/chat/completions", {
      model: modelId,
      max_tokens: 1,
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    });
    const latencyMs = Date.now() - start;
    let ok = res.status === 200;
    let error = null;
    if (ok) {
      if (parseError) {
        ok = false;
        error = parseError;
      } else {
        ok = Array.isArray(parsed?.choices) && parsed.choices.length > 0;
        if (!ok) error = "HTTP 200 but response missing choices";
      }
    } else {
      const detail = parsed?.error?.message || parsed?.error || "";
      error = `HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 120)}` : ""}`;
    }
    return { ok, latencyMs, error };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: err.message };
  }
}

/**
 * POST /api/providers/[id]/test-models
 * id = connectionId — used only to resolve provider + model list.
 * Actual requests go through /api/v1/chat/completions (open-sse handles everything).
 */
export async function POST(request, { params }) {
  const auth = await requireSpawnRouteAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);
    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    const providerId = connection.provider;
    const isCompatible = isOpenAICompatibleProvider(providerId) || isAnthropicCompatibleProvider(providerId);
    const alias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;

    let models = getProviderModels(alias);

    // Compatible providers: fetch live model list
    if (isCompatible && models.length === 0) {
      try {
        const modelsRes = await internalApiGet(`/api/providers/${id}/models`);
        if (modelsRes.ok) {
          const data = await modelsRes.json();
          models = (data.models || []).map((m) => ({ id: m.id || m.name, name: m.name || m.id }));
        }
      } catch { /* fallback to empty */ }
    }

    if (models.length === 0) {
      return NextResponse.json({ error: "No models configured for this provider" }, { status: 400 });
    }

    // Warm up with first model to trigger token refresh (if needed) before parallel calls.
    const [first, ...rest] = models;
    const firstResult = await pingModel(`${alias}/${first.id}`);
    const results = [{ modelId: first.id, name: first.name || first.id, ...firstResult }];

    if (rest.length > 0) {
      const restResults = await Promise.all(
        rest.map(async (model) => {
          const result = await pingModel(`${alias}/${model.id}`);
          return { modelId: model.id, name: model.name || model.id, ...result };
        })
      );
      results.push(...restResults);
    }

    return NextResponse.json({ provider: providerId, connectionId: id, results });
  } catch (error) {
    console.error("Error testing models:", error?.message);
    return NextResponse.json({ error: "Test failed" }, { status: 500 });
  }
}
