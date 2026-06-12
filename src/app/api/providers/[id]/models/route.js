import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/models";
import { requireSpawnRouteAuth } from "@/lib/auth/spawnRouteAuth";
import { fetchModelsForConnection } from "@/lib/models/fetchConnectionModels.js";

/**
 * GET /api/providers/[id]/models - Get models list from provider
 */
export async function GET(request, { params }) {
  const auth = await requireSpawnRouteAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    const result = await fetchModelsForConnection(connection);
    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: result.status || 500 });
    }

    return NextResponse.json({
      provider: connection.provider,
      connectionId: connection.id,
      models: result.models || [],
      ...(result.warning ? { warning: result.warning } : {}),
    });
  } catch (error) {
    console.error("Error fetching provider models:", error?.message);
    return NextResponse.json({ error: "Failed to fetch models" }, { status: 500 });
  }
}
