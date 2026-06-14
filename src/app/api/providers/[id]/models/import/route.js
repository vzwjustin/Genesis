import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/models";
import { requireSpawnRouteAuth } from "@/lib/auth/spawnRouteAuth";
import { autoImportProviderModels } from "@/lib/models/autoImportProviderModels.js";

/**
 * POST /api/providers/[id]/models/import — fetch upstream models and register aliases.
 */
export async function POST(request, { params }) {
  const auth = await requireSpawnRouteAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    const result = await autoImportProviderModels(connection);

    if (result.error) {
      return NextResponse.json({ ok: false, status: "degraded", ...result });
    }

    if (result.warning && result.imported === 0 && !result.total) {
      const softFailure = result.authFailure
        || result.upstreamFailure
        || /session expired|reconnect|401|403|token|falling back|no models returned/i.test(result.warning);
      if (softFailure) {
        return NextResponse.json({ ok: false, status: "degraded", ...result });
      }
      return NextResponse.json(
        { error: result.warning, ...result },
        { status: 400 },
      );
    }

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("Error importing provider models:", error?.message);
    return NextResponse.json({ error: "Failed to import models" }, { status: 500 });
  }
}
