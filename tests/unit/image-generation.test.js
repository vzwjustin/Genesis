/**
 * Unit tests for image generation handlers and provider adapters.
 * No mocks: adapter unit tests, validation-only handler probes, source inspection.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { handleImageGenerationCore } from "../../open-sse/handlers/imageGenerationCore.js";
import { getImageAdapter } from "../../open-sse/handlers/imageProviders/index.js";
import createOpenAIAdapter from "../../open-sse/handlers/imageProviders/openai.js";
import gemini from "../../open-sse/handlers/imageProviders/gemini.js";
import nanobanana from "../../open-sse/handlers/imageProviders/nanobanana.js";
import sdwebui from "../../open-sse/handlers/imageProviders/sdwebui.js";
import cloudflareAi from "../../open-sse/handlers/imageProviders/cloudflareAi.js";

const root = dirname(fileURLToPath(import.meta.url));

describe("handleImageGenerationCore — validation", () => {
  it("validates required prompt field", async () => {
    const result = await handleImageGenerationCore({
      body: { model: "openai/dall-e-3" },
      modelInfo: { provider: "openai", model: "dall-e-3" },
      credentials: { apiKey: "test-key" },
      log: null,
    });
    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toContain("Missing required field: prompt");
  });

  it("rejects unsupported provider", async () => {
    const result = await handleImageGenerationCore({
      body: { prompt: "test" },
      modelInfo: { provider: "unknown-provider", model: "test" },
      credentials: null,
      log: null,
    });
    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toContain("does not support image generation");
  });
});

describe("openai image adapter", () => {
  const openai = createOpenAIAdapter("openai");
  const minimax = createOpenAIAdapter("minimax");
  const openrouter = createOpenAIAdapter("openrouter");

  it("buildUrl for openai", () => {
    expect(openai.buildUrl("dall-e-3", {})).toBe("https://api.openai.com/v1/images/generations");
  });

  it("buildBody includes prompt, n, size", () => {
    const body = openai.buildBody("dall-e-3", { prompt: "A cute cat", n: 1, size: "1024x1024" });
    expect(body.prompt).toBe("A cute cat");
    expect(body.n).toBe(1);
    expect(body.size).toBe("1024x1024");
  });

  it("buildHeaders uses Bearer apiKey", () => {
    const headers = openai.buildHeaders({ apiKey: "test-key" });
    expect(headers.Authorization).toBe("Bearer test-key");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("minimax uses minimaxi endpoint", () => {
    expect(minimax.buildUrl("minimax-image-01", {})).toBe("https://api.minimaxi.com/v1/images/generations");
  });

  it("openrouter adds HTTP-Referer and X-Title", () => {
    const headers = openrouter.buildHeaders({ apiKey: "test-key" });
    expect(headers["HTTP-Referer"]).toBe("https://endpoint-proxy.local");
    expect(headers["X-Title"]).toBe("Endpoint Proxy");
  });

  it("normalize passes through OpenAI response", () => {
    const raw = { created: 1, data: [{ url: "https://example.com/image.png" }] };
    expect(openai.normalize(raw)).toEqual(raw);
  });
});

describe("gemini image adapter", () => {
  it("buildUrl includes generativelanguage host and api key", () => {
    const url = gemini.buildUrl("gemini-image-preview", { apiKey: "test-key" });
    expect(url).toContain("generativelanguage.googleapis.com");
    expect(url).toContain("generateContent");
    expect(url).toContain("key=test-key");
  });

  it("buildBody sets responseModalities TEXT and IMAGE", () => {
    const body = gemini.buildBody("gemini-image-preview", { prompt: "A sunset" });
    expect(body.generationConfig.responseModalities).toEqual(["TEXT", "IMAGE"]);
  });

  it("normalize extracts inline base64 images", () => {
    const normalized = gemini.normalize({
      candidates: [{
        content: {
          parts: [
            { text: "Generated image" },
            { inlineData: { data: "base64imagedata" } },
          ],
        },
      }],
    }, "A sunset");
    expect(normalized.data[0].b64_json).toBe("base64imagedata");
  });
});

describe("nanobanana image adapter", () => {
  it("buildBody for text-to-image uses TEXTTOIAMGE type", () => {
    const body = nanobanana.buildBody("nanobanana-flash", {
      prompt: "A robot",
      n: 2,
      size: "1024x1792",
    });
    expect(body.type).toBe("TEXTTOIAMGE");
    expect(body.numImages).toBe(2);
    expect(body.image_size).toBe("9:16");
  });

  it("buildHeaders includes Authorization Bearer", () => {
    const headers = nanobanana.buildHeaders({ apiKey: "test-key" });
    expect(headers.Authorization).toBe("Bearer test-key");
  });

  it("poll URL pattern is record-info with taskId (source)", () => {
    const src = readFileSync(join(root, "../../open-sse/handlers/imageProviders/nanobanana.js"), "utf8");
    expect(src).toContain("record-info");
    expect(src).toContain("proxyAwareFetch");
  });
});

describe("sdwebui image adapter", () => {
  it("buildBody maps size and batch_size", () => {
    const body = sdwebui.buildBody("sdxl-base-1.0", {
      prompt: "A forest",
      size: "768x768",
      n: 2,
    });
    expect(body.width).toBe(768);
    expect(body.height).toBe(768);
    expect(body.batch_size).toBe(2);
  });

  it("normalize maps images array to OpenAI data format", () => {
    const normalized = sdwebui.normalize({ images: ["b64a", "b64b"] });
    expect(normalized.data).toHaveLength(2);
    expect(normalized.data[0].b64_json).toBe("b64a");
  });
});

describe("cloudflare-ai image adapter", () => {
  it("buildUrl includes account id and model path", () => {
    const url = cloudflareAi.buildUrl("@cf/leonardo/lucid-origin", {
      apiKey: "cf-token",
      providerSpecificData: { accountId: "cf-account" },
    });
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/cf-account/ai/run/@cf/leonardo/lucid-origin"
    );
  });

  it("buildJsonBody maps prompt and dimensions from size", async () => {
    const body = await cloudflareAi.buildBody("@cf/leonardo/lucid-origin", {
      prompt: "A lighthouse",
      size: "1024x1536",
    });
    expect(body.prompt).toBe("A lighthouse");
    expect(body.width).toBe(1024);
    expect(body.height).toBe(1536);
  });

  it("multipart FLUX.2 models omit Content-Type header (source)", () => {
    const src = readFileSync(join(root, "../../open-sse/handlers/imageProviders/cloudflareAi.js"), "utf8");
    expect(src).toContain("flux-2-klein-9b");
    expect(src).toContain("FormData");
  });
});

describe("codex image adapter (source)", () => {
  it("uses codex responses endpoint and version header", () => {
    const src = readFileSync(join(root, "../../open-sse/handlers/imageProviders/codex.js"), "utf8");
    expect(src).toContain("chatgpt.com/backend-api/codex/responses");
    expect(src).toContain('"version": CODEX_VERSION');
    expect(src).toContain("image_generation");
  });
});

describe("imageGenerationCore proxy routing (source)", () => {
  it("routes upstream through proxyAwareFetch", () => {
    const src = readFileSync(join(root, "../../open-sse/handlers/imageGenerationCore.js"), "utf8");
    expect(src).toContain("proxyAwareFetch");
    expect(src).toContain("buildProxyOptionsFromCredentials");
    expect(src).not.toMatch(/\bfetch\s*\(/);
  });

  it("skips refresh loop when executor.supportsTokenRefresh is false", () => {
    const src = readFileSync(join(root, "../../open-sse/handlers/imageGenerationCore.js"), "utf8");
    expect(src).toContain("supportsTokenRefresh === false");
  });
});

describe("image provider registry", () => {
  it("resolves known providers", () => {
    for (const provider of ["openai", "gemini", "minimax", "openrouter", "nanobanana", "sdwebui", "cloudflare-ai"]) {
      expect(getImageAdapter(provider)).toBeTruthy();
    }
  });
});
