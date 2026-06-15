// Custom node providers (openai-compatible-* / custom-embedding-*) — baseUrl from credentials
import createOpenAIEmbeddingAdapter from "./openai.js";
import { validateProviderBaseUrl } from "../../utils/ssrfGuard.js";

const baseAdapter = createOpenAIEmbeddingAdapter("openai");

const openaiCompatNodeEmbeddingAdapter = {
  ...baseAdapter,
  buildUrl: (_model, creds) => {
    const rawBaseUrl = creds?.providerSpecificData?.baseUrl || "https://api.openai.com/v1";
    const baseUrl = validateProviderBaseUrl(rawBaseUrl).replace(/\/embeddings$/, "");
    return `${baseUrl}/embeddings`;
  },
};

export default openaiCompatNodeEmbeddingAdapter;
