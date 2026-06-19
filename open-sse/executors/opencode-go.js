import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { ANTHROPIC_API_VERSION } from "../providers/shared.js";

// Models that use /zen/go/v1/messages (Anthropic/Claude format + x-api-key auth)
const CLAUDE_FORMAT_MODELS = new Set(["minimax-m2.5", "minimax-m2.7"]);

const BASE = "https://opencode.ai/zen/go/v1";

export class OpenCodeGoExecutor extends BaseExecutor {
  constructor() {
    super("opencode-go", PROVIDERS["opencode-go"]);
  }

  buildUrl(model) {
    return CLAUDE_FORMAT_MODELS.has(model)
      ? `${BASE}/messages`
      : `${BASE}/chat/completions`;
  }

  buildHeaders(credentials, stream = true, model) {
    const key = credentials?.apiKey || credentials?.accessToken;
    const headers = { "Content-Type": "application/json" };
    // Prefer the model arg threaded through execute(); fall back to the
    // per-request context stashed by transformRequest. Never read singleton
    // state — concurrent requests would clobber each other's auth scheme.
    const resolvedModel = model ?? credentials?._opencodeGoCtx?.model;

    if (CLAUDE_FORMAT_MODELS.has(resolvedModel)) {
      headers["x-api-key"] = key;
      headers["anthropic-version"] = ANTHROPIC_API_VERSION;
    } else {
      headers["Authorization"] = `Bearer ${key}`;
    }

    if (stream) headers["Accept"] = "text/event-stream";
    return headers;
  }

  transformRequest(model, body, stream, credentials) {
    if (credentials) credentials._opencodeGoCtx = { model };
    return injectReasoningContent({ provider: this.provider, model, body });
  }
}
