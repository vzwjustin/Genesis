import { saveRequestUsage, appendRequestLog, saveRequestDetail } from "@/lib/usageDb.js";
import { COLORS } from "../../utils/stream.js";

const OPTIONAL_PARAMS = [
  "temperature", "top_p", "top_k",
  "max_tokens", "max_completion_tokens",
  "thinking", "reasoning", "enable_thinking",
  "presence_penalty", "frequency_penalty",
  "seed", "stop", "tools", "tool_choice",
  "response_format", "prediction", "store", "metadata",
  "n", "logprobs", "top_logprobs", "logit_bias",
  "user", "parallel_tool_calls"
];

export function extractRequestConfig(body, stream) {
  const config = { messages: body.messages || [], model: body.model, stream };
  for (const param of OPTIONAL_PARAMS) {
    if (body[param] !== undefined) config[param] = body[param];
  }
  return config;
}

export function extractUsageFromResponse(responseBody) {
  if (!responseBody || typeof responseBody !== "object") return null;

  // Claude format
  if (responseBody.usage?.input_tokens !== undefined) {
    return {
      prompt_tokens: responseBody.usage.input_tokens || 0,
      completion_tokens: responseBody.usage.output_tokens || 0,
      cache_read_input_tokens: responseBody.usage.cache_read_input_tokens,
      cache_creation_input_tokens: responseBody.usage.cache_creation_input_tokens
    };
  }

  // OpenAI format
  if (responseBody.usage?.prompt_tokens !== undefined) {
    return {
      prompt_tokens: responseBody.usage.prompt_tokens || 0,
      completion_tokens: responseBody.usage.completion_tokens || 0,
      cached_tokens: responseBody.usage.prompt_tokens_details?.cached_tokens,
      reasoning_tokens: responseBody.usage.completion_tokens_details?.reasoning_tokens
    };
  }

  // Gemini format (including Antigravity { response: { usageMetadata } } wrapper)
  const usageMetadata = responseBody.usageMetadata || responseBody.response?.usageMetadata;
  if (usageMetadata) {
    return {
      prompt_tokens: usageMetadata.promptTokenCount || 0,
      completion_tokens: usageMetadata.candidatesTokenCount || 0,
      reasoning_tokens: usageMetadata.thoughtsTokenCount
    };
  }

  return null;
}

export function buildRequestDetail(base, overrides = {}) {
  return {
    provider: base.provider || "unknown",
    model: base.model || "unknown",
    connectionId: base.connectionId || undefined,
    timestamp: new Date().toISOString(),
    latency: base.latency || { ttft: 0, total: 0 },
    tokens: base.tokens || { prompt_tokens: 0, completion_tokens: 0 },
    request: base.request,
    providerRequest: base.providerRequest || null,
    providerResponse: base.providerResponse || null,
    response: base.response || {},
    status: base.status || "success",
    ...overrides
  };
}

export function saveUsageStats({ provider, model, tokens, connectionId, apiKey, endpoint, label = "USAGE", idempotencyKey = null }) {
  if (!tokens || typeof tokens !== "object") return;

  const inTokens = tokens.input_tokens ?? tokens.prompt_tokens ?? 0;
  const outTokens = tokens.output_tokens ?? tokens.completion_tokens ?? 0;

  if (inTokens === 0 && outTokens === 0) return;

  const cacheRead = tokens.cache_read_input_tokens ?? tokens.cached_tokens;
  const cacheCreate = tokens.cache_creation_input_tokens;
  const reasoning = tokens.reasoning_tokens;

  const providerName = provider || "unknown";
  const accountId = connectionId == null ? "" : String(connectionId);
  const time = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const accountSuffix = accountId ? ` | account=${accountId.slice(0, 8)}...` : "";
  let logLine = `${COLORS.green}[${time}] 📊 [${label}] ${providerName.toUpperCase()} | in=${inTokens} | out=${outTokens}${accountSuffix}`;
  if (cacheRead) logLine += ` | cache_read=${cacheRead}`;
  if (cacheCreate) logLine += ` | cache_create=${cacheCreate}`;
  if (reasoning) logLine += ` | reasoning=${reasoning}`;
  console.log(`${logLine}${COLORS.reset}`);

  // Normalize to OpenAI token shape for storage (preserve cache fields for hit-rate stats)
  const normalized = {
    prompt_tokens: tokens.prompt_tokens ?? tokens.input_tokens ?? 0,
    completion_tokens: tokens.completion_tokens ?? tokens.output_tokens ?? 0,
    cache_read_input_tokens: cacheRead || 0,
    cache_creation_input_tokens: cacheCreate || 0,
    reasoning_tokens: reasoning || 0,
    ...(tokens.estimated === true ? { estimated: true } : {}),
  };

  try {
    Promise.resolve(saveRequestUsage({
      provider: providerName,
      model: model || "unknown",
      tokens: normalized,
      timestamp: new Date().toISOString(),
      connectionId: connectionId || undefined,
      apiKey: apiKey || undefined,
      endpoint: endpoint || null,
      idempotencyKey: idempotencyKey || null
    })).catch(() => {});
  } catch {
    // Usage persistence is optional; request handling must continue.
  }
}
