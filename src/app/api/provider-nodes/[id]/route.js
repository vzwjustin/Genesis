import { NextResponse } from "next/server";
import { deleteProviderConnectionsByProvider, deleteProviderNode, getProviderConnections, getProviderNodeById, updateProviderConnection, updateProviderNode } from "@/models";
import { requireSpawnRouteAuth } from "@/lib/auth/spawnRouteAuth";
import { validateProviderBaseUrl } from "open-sse/utils/ssrfGuardCore.js";

function normalizeProviderNodeBaseUrl(baseUrl, endpointSuffix = "") {
  let sanitizedBaseUrl = baseUrl.trim().replace(/\/$/, "");
  if (endpointSuffix && sanitizedBaseUrl.endsWith(endpointSuffix)) {
    sanitizedBaseUrl = sanitizedBaseUrl.slice(0, -endpointSuffix.length);
  }
  return validateProviderBaseUrl(sanitizedBaseUrl);
}

function invalidBaseUrlResponse() {
  return NextResponse.json({ error: "Invalid base URL" }, { status: 400 });
}

// PUT /api/provider-nodes/[id] - Update provider node
export async function PUT(request, { params }) {
  const auth = await requireSpawnRouteAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const { id } = await params;
    const body = await request.json();
    const { name, prefix, apiType, baseUrl } = body;
    const node = await getProviderNodeById(id);

    if (!node) {
      return NextResponse.json({ error: "Provider node not found" }, { status: 404 });
    }

    if (typeof name !== "string" || !name.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    if (typeof prefix !== "string" || !prefix.trim()) {
      return NextResponse.json({ error: "Prefix is required" }, { status: 400 });
    }

    // Only validate apiType for OpenAI Compatible nodes
    if (node.type === "openai-compatible" && (!apiType || !["chat", "responses"].includes(apiType))) {
      return NextResponse.json({ error: "Invalid OpenAI compatible API type" }, { status: 400 });
    }

    if (typeof baseUrl !== "string") {
      return invalidBaseUrlResponse();
    }

    if (!baseUrl.trim()) {
      return NextResponse.json({ error: "Base URL is required" }, { status: 400 });
    }

    let sanitizedBaseUrl;
    try {
      const endpointSuffix = node.type === "anthropic-compatible"
        ? "/messages"
        : node.type === "custom-embedding"
          ? "/embeddings"
          : "";
      sanitizedBaseUrl = normalizeProviderNodeBaseUrl(baseUrl, endpointSuffix);
    } catch {
      return invalidBaseUrlResponse();
    }

    const updates = {
      name: name.trim(),
      prefix: prefix.trim(),
      baseUrl: sanitizedBaseUrl,
    };

    if (node.type === "openai-compatible") {
      updates.apiType = apiType;
    }

    const updated = await updateProviderNode(id, updates);

    const connections = await getProviderConnections({ provider: id });
    await Promise.all(connections.map((connection) => (
      updateProviderConnection(connection.id, {
        providerSpecificData: {
          ...(connection.providerSpecificData || {}),
          prefix: prefix.trim(),
          apiType: node.type === "openai-compatible" ? apiType : undefined,
          baseUrl: sanitizedBaseUrl,
          nodeName: updated.name,
        }
      })
    )));

    return NextResponse.json({ node: updated });
  } catch (error) {
    console.log("Error updating provider node:", error);
    return NextResponse.json({ error: "Failed to update provider node" }, { status: 500 });
  }
}

// DELETE /api/provider-nodes/[id] - Delete provider node and its connections
export async function DELETE(request, { params }) {
  const auth = await requireSpawnRouteAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const { id } = await params;
    const node = await getProviderNodeById(id);

    if (!node) {
      return NextResponse.json({ error: "Provider node not found" }, { status: 404 });
    }

    await deleteProviderConnectionsByProvider(id);
    await deleteProviderNode(id);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting provider node:", error);
    return NextResponse.json({ error: "Failed to delete provider node" }, { status: 500 });
  }
}
