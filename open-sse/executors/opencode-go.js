import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { hasAnthropicCacheBreakpoints } from "../rtk/cacheBoundary.js";

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

  buildHeaders(credentials, stream = true, model = "") {
    const key = credentials?.apiKey || credentials?.accessToken;
    const headers = { "Content-Type": "application/json" };

    if (CLAUDE_FORMAT_MODELS.has(model)) {
      headers["x-api-key"] = key;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers["Authorization"] = `Bearer ${key}`;
    }

    if (stream) headers["Accept"] = "text/event-stream";
    return headers;
  }

  transformRequest(model, body) {
    if (hasAnthropicCacheBreakpoints(body)) return body;
    return injectReasoningContent({ provider: this.provider, model, body });
  }
}
