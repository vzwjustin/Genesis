import { NextResponse } from "next/server";
import { internalApiPost } from "@/lib/internalApi.js";

function failurePayload({ latencyMs, res, rawText, parsed, parseError, defaultError }) {
  if (!res.ok) {
    const detail = parsed?.error?.message || parsed?.error || parsed?.msg || parsed?.message || rawText;
    return {
      ok: false,
      latencyMs,
      status: res.status,
      error: `HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 240)}` : ""}`,
    };
  }
  if (parseError) {
    return { ok: false, latencyMs, status: res.status, error: parseError };
  }
  return { ok: false, latencyMs, status: res.status, error: defaultError };
}

// POST /api/models/test - Ping a single model via internal completions or embeddings
export async function POST(request) {
  try {
    const { model, kind } = await request.json();
    if (!model) return NextResponse.json({ error: "Model required" }, { status: 400 });

    const start = Date.now();

    if (kind === "embedding") {
      const { res, rawText, parsed, parseError } = await internalApiPost("/api/v1/embeddings", {
        model,
        input: "test",
      });
      const latencyMs = Date.now() - start;

      if (!res.ok || parseError) {
        return NextResponse.json(
          failurePayload({
            latencyMs,
            res,
            rawText,
            parsed,
            parseError,
            defaultError: "Provider returned no embedding data",
          })
        );
      }

      const hasEmbedding =
        Array.isArray(parsed?.data) &&
        parsed.data.length > 0 &&
        Array.isArray(parsed.data[0]?.embedding);
      if (!hasEmbedding) {
        return NextResponse.json({
          ok: false,
          latencyMs,
          status: res.status,
          error: "Provider returned no embedding data",
        });
      }
      return NextResponse.json({ ok: true, latencyMs, error: null, status: res.status });
    }

    const { res, rawText, parsed, parseError } = await internalApiPost("/api/v1/chat/completions", {
      model,
      max_tokens: 1,
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    });
    const latencyMs = Date.now() - start;

    if (!res.ok || parseError) {
      return NextResponse.json(
        failurePayload({
          latencyMs,
          res,
          rawText,
          parsed,
          parseError,
          defaultError: "Provider returned no completion choices for this model",
        })
      );
    }

    const providerStatus = parsed?.status;
    const providerMsg = parsed?.msg || parsed?.message;
    const hasProviderErrorStatus =
      providerStatus !== undefined &&
      providerStatus !== null &&
      String(providerStatus) !== "200" &&
      String(providerStatus) !== "0";
    if (hasProviderErrorStatus && providerMsg) {
      return NextResponse.json({
        ok: false,
        latencyMs,
        status: res.status,
        error: `Provider status ${providerStatus}: ${String(providerMsg).slice(0, 240)}`,
      });
    }

    if (parsed?.error) {
      const providerError = parsed?.error?.message || parsed?.error || "Provider returned an error";
      return NextResponse.json({
        ok: false,
        latencyMs,
        status: res.status,
        error: String(providerError).slice(0, 240),
      });
    }

    const hasChoices = Array.isArray(parsed?.choices) && parsed.choices.length > 0;
    if (!hasChoices) {
      return NextResponse.json({
        ok: false,
        latencyMs,
        status: res.status,
        error: "Provider returned no completion choices for this model",
      });
    }

    return NextResponse.json({ ok: true, latencyMs, error: null, status: res.status });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
