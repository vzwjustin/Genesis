import { NextResponse } from "next/server";
import { FILTERS } from "./filters.js";
import { assertSafeFetchUrl } from "open-sse/utils/ssrfGuard.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { FREE_PROVIDERS, FREE_TIER_PROVIDERS } from "@/shared/constants/providers";
import { requireSpawnRouteAuth } from "@/lib/auth/spawnRouteAuth";

export const dynamic = "force-dynamic";

const ALLOWED_MODELS_URLS = new Set(
  [...Object.values(FREE_PROVIDERS), ...Object.values(FREE_TIER_PROVIDERS)]
    .map((p) => p.modelsFetcher?.url)
    .filter(Boolean)
);

export async function GET(request) {
  const auth = await requireSpawnRouteAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { searchParams } = new URL(request.url);
  const url = searchParams.get("url");
  const type = searchParams.get("type");

  if (!url || !type) {
    return NextResponse.json({ error: "Missing url or type" }, { status: 400 });
  }

  const filter = FILTERS[type];
  if (!filter) {
    return NextResponse.json({ error: "Unknown filter type" }, { status: 400 });
  }

  if (!ALLOWED_MODELS_URLS.has(url)) {
    return NextResponse.json({ error: "URL not allowed" }, { status: 400 });
  }

  try {
    assertSafeFetchUrl(url);
  } catch (err) {
    return NextResponse.json({ error: err.message || "Invalid URL" }, { status: 400 });
  }

  try {
    const res = await proxyAwareFetch(url);
    if (!res.ok) {
      return NextResponse.json({ data: [] });
    }
    const json = await res.json();
    const raw = json.data ?? json.models ?? json;
    const data = filter(Array.isArray(raw) ? raw : []);
    return NextResponse.json({ data });
  } catch {
    return NextResponse.json({ data: [] });
  }
}
