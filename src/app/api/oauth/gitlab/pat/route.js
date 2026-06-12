import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";
import { assertSafeFetchUrlWithDns } from "open-sse/utils/ssrfGuard.js";
import { oauthFetch } from "@/lib/oauth/utils/oauthFetch.js";
import { requireSpawnRouteAuth } from "@/lib/auth/spawnRouteAuth";

const GITLAB_DEFAULT_BASE = "https://gitlab.com";

/**
 * POST /api/oauth/gitlab/pat
 * Authenticate GitLab Duo with a Personal Access Token (PAT)
 */
export async function POST(request) {
  try {
    const auth = await requireSpawnRouteAuth(request);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    const { token, baseUrl } = body;
    if (!token?.trim()) {
      return NextResponse.json({ error: "Personal Access Token is required" }, { status: 400 });
    }

    const base = (baseUrl?.trim() || GITLAB_DEFAULT_BASE).replace(/\/$/, "");
    try {
    await assertSafeFetchUrlWithDns(base);
    } catch {
      return NextResponse.json({ error: "Invalid or blocked GitLab base URL" }, { status: 400 });
    }

    // Verify token by fetching current user
    const userRes = await oauthFetch(`${base}/api/v4/user`, {
      headers: { "Private-Token": token.trim(), Accept: "application/json" },
    });

    if (!userRes.ok) {
      const err = await userRes.text();
      return NextResponse.json({ error: `GitLab token verification failed: ${err}` }, { status: 401 });
    }

    const user = await userRes.json();
    const email = user.email || user.public_email || "";

    await createProviderConnection({
      provider: "gitlab",
      authType: "oauth",
      accessToken: token.trim(),
      refreshToken: null,
      expiresAt: null,
      email,
      displayName: user.name || user.username || email,
      testStatus: "active",
      providerSpecificData: {
        username: user.username || "",
        email,
        name: user.name || "",
        baseUrl: base,
        authKind: "personal_access_token",
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("GitLab PAT auth error:", error?.message);
    return NextResponse.json({ error: "Failed to authenticate GitLab token" }, { status: 500 });
  }
}
