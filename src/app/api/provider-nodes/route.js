import { NextResponse } from "next/server";
import { createProviderNode, getProviderNodes } from "@/models";
import { OPENAI_COMPATIBLE_PREFIX, ANTHROPIC_COMPATIBLE_PREFIX, CUSTOM_EMBEDDING_PREFIX } from "@/shared/constants/providers";
import { generateId } from "@/shared/utils";
import { requireSpawnRouteAuth } from "@/lib/auth/spawnRouteAuth";
import { validateProviderBaseUrl } from "open-sse/utils/ssrfGuardCore.js";

export const dynamic = "force-dynamic";

const OPENAI_COMPATIBLE_DEFAULTS = {
  baseUrl: "https://api.openai.com/v1",
};

const ANTHROPIC_COMPATIBLE_DEFAULTS = {
  baseUrl: "https://api.anthropic.com/v1",
};

const CUSTOM_EMBEDDING_DEFAULTS = {
  baseUrl: "https://api.openai.com/v1",
};

function normalizeProviderNodeBaseUrl(baseUrl, fallbackBaseUrl, endpointSuffix = "") {
  let sanitizedBaseUrl = (baseUrl || fallbackBaseUrl).trim().replace(/\/$/, "");
  if (endpointSuffix && sanitizedBaseUrl.endsWith(endpointSuffix)) {
    sanitizedBaseUrl = sanitizedBaseUrl.slice(0, -endpointSuffix.length);
  }
  return validateProviderBaseUrl(sanitizedBaseUrl);
}

function invalidBaseUrlResponse() {
  return NextResponse.json({ error: "Invalid base URL" }, { status: 400 });
}

// GET /api/provider-nodes - List all provider nodes
export async function GET(request) {
  const auth = await requireSpawnRouteAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const nodes = await getProviderNodes();
    return NextResponse.json({ nodes });
  } catch (error) {
    console.log("Error fetching provider nodes:", error);
    return NextResponse.json({ error: "Failed to fetch provider nodes" }, { status: 500 });
  }
}

// POST /api/provider-nodes - Create provider node
export async function POST(request) {
  const auth = await requireSpawnRouteAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const body = await request.json();
    const { name, prefix, apiType, baseUrl, type } = body;

    if (typeof name !== "string" || !name.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    if (typeof prefix !== "string" || !prefix.trim()) {
      return NextResponse.json({ error: "Prefix is required" }, { status: 400 });
    }

    // Determine type
    const nodeType = type || "openai-compatible";

    if (nodeType === "openai-compatible") {
      if (!apiType || !["chat", "responses"].includes(apiType)) {
        return NextResponse.json({ error: "Invalid OpenAI compatible API type" }, { status: 400 });
      }

      let sanitizedBaseUrl;
      try {
        sanitizedBaseUrl = normalizeProviderNodeBaseUrl(baseUrl, OPENAI_COMPATIBLE_DEFAULTS.baseUrl);
      } catch {
        return invalidBaseUrlResponse();
      }

      const node = await createProviderNode({
        id: `${OPENAI_COMPATIBLE_PREFIX}${apiType}-${generateId()}`,
        type: "openai-compatible",
        prefix: prefix.trim(),
        apiType,
        baseUrl: sanitizedBaseUrl,
        name: name.trim(),
      });
      return NextResponse.json({ node }, { status: 201 });
    }

    if (nodeType === "custom-embedding") {
      let sanitizedBaseUrl;
      try {
        sanitizedBaseUrl = normalizeProviderNodeBaseUrl(baseUrl, CUSTOM_EMBEDDING_DEFAULTS.baseUrl, "/embeddings");
      } catch {
        return invalidBaseUrlResponse();
      }

      const node = await createProviderNode({
        id: `${CUSTOM_EMBEDDING_PREFIX}${generateId()}`,
        type: "custom-embedding",
        prefix: prefix.trim(),
        baseUrl: sanitizedBaseUrl,
        name: name.trim(),
      });
      return NextResponse.json({ node }, { status: 201 });
    }

    if (nodeType === "anthropic-compatible") {
      let sanitizedBaseUrl;
      try {
        sanitizedBaseUrl = normalizeProviderNodeBaseUrl(baseUrl, ANTHROPIC_COMPATIBLE_DEFAULTS.baseUrl, "/messages");
      } catch {
        return invalidBaseUrlResponse();
      }

      const node = await createProviderNode({
        id: `${ANTHROPIC_COMPATIBLE_PREFIX}${generateId()}`,
        type: "anthropic-compatible",
        prefix: prefix.trim(),
        baseUrl: sanitizedBaseUrl,
        name: name.trim(),
      });
      return NextResponse.json({ node }, { status: 201 });
    }

    return NextResponse.json({ error: "Invalid provider node type" }, { status: 400 });
  } catch (error) {
    console.log("Error creating provider node:", error);
    return NextResponse.json({ error: "Failed to create provider node" }, { status: 500 });
  }
}
