import { NextResponse } from "next/server";
import { generatePKCE } from "@/lib/oauth/utils/pkce";
import { KiroService } from "@/lib/oauth/services/kiro";
import { requireSpawnRouteAuth } from "@/lib/auth/spawnRouteAuth";

/**
 * GET /api/oauth/kiro/social-authorize
 * Generate Google/GitHub social login URL for manual callback flow
 * Uses kiro:// custom protocol as required by AWS Cognito
 */
export async function GET(request) {
  const auth = await requireSpawnRouteAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const { searchParams } = new URL(request.url);
    const provider = searchParams.get("provider"); // "google" or "github"

    if (!provider || !["google", "github"].includes(provider)) {
      return NextResponse.json(
        { error: "Invalid provider. Use 'google' or 'github'" },
        { status: 400 }
      );
    }

    // Generate PKCE for social auth
    const { codeVerifier, codeChallenge, state } = generatePKCE();

    const kiroService = new KiroService();
    const authUrl = kiroService.buildSocialLoginUrl(
      provider,
      codeChallenge,
      state
    );

    const response = NextResponse.json({
      authUrl,
      state,
      codeVerifier,
      codeChallenge,
      provider,
    });
    response.cookies.set("kiro_social_oauth_state", state, {
      httpOnly: true,
      sameSite: "lax",
      secure: request.nextUrl?.protocol === "https:",
      path: "/api/oauth/kiro",
      maxAge: 10 * 60,
    });
    return response;
  } catch (error) {
    console.error("Kiro social authorize error:", error?.message);
    return NextResponse.json({ error: "Failed to start Kiro social authorization" }, { status: 500 });
  }
}
