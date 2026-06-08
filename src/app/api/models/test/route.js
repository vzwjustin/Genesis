import { NextResponse } from "next/server";
import { getApiKeys } from "@/lib/localDb";
import { UPDATER_CONFIG } from "@/shared/constants/config";
import { getConsistentMachineId } from "@/shared/utils/machineId";

const CLI_TOKEN_SALT = "9r-cli-auth";
const REQUEST_TIMEOUT_MS = 15000;

async function buildInternalHeaders() {
  const headers = { "Content-Type": "application/json" };
  try {
    const keys = await getApiKeys();
    const apiKey = keys.find((k) => k.isActive !== false)?.key || null;
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  } catch {}
  headers["x-9r-cli-token"] = await getConsistentMachineId(CLI_TOKEN_SALT);
  return headers;
}

function getInternalBaseUrl() {
  return `http://127.0.0.1:${process.env.PORT || UPDATER_CONFIG.appPort}`;
}

async function internalPost(path, body) {
  const headers = await buildInternalHeaders();
  const res = await fetch(`${getInternalBaseUrl()}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
      const { res, rawText, parsed, parseError } = await internalPost("/api/v1/embeddings", {
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

    const { res, rawText, parsed, parseError } = await internalPost("/api/v1/chat/completions", {
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
