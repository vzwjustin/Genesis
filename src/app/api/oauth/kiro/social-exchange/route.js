import { NextResponse } from "next/server";
import { KiroService } from "@/lib/oauth/services/kiro";
import { createProviderConnection } from "@/models";
import { autoSetupMitmForProvider } from "@/lib/mitm/autoSetupForProvider";
import { requireSpawnRouteAuth } from "@/lib/auth/spawnRouteAuth";
import { cookies } from "next/headers";

/**
 * POST /api/oauth/kiro/social-exchange
 * Exchange authorization code for tokens (Google/GitHub social login)
 * Callback URL will be in format: kiro://kiro.kiroAgent/authenticate-success?code=XXX&state=YYY
 */
export async function POST(request) {
  const auth = await requireSpawnRouteAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const { code, codeVerifier, provider, state } = await request.json();

    if (!code || !codeVerifier || !state) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    if (!provider || !["google", "github"].includes(provider)) {
      return NextResponse.json(
        { error: "Invalid provider" },
        { status: 400 }
      );
    }

    const cookieStore = await cookies();
    const expectedState = cookieStore.get("kiro_social_oauth_state")?.value;
    if (!expectedState || state !== expectedState) {
      return NextResponse.json({ error: "OAuth state mismatch" }, { status: 400 });
    }

    const kiroService = new KiroService();

    // Exchange code for tokens (redirect_uri handled internally)
    const tokenData = await kiroService.exchangeSocialCode(
      code,
      codeVerifier
    );

    // Extract email from JWT if available
    const email = kiroService.extractEmailFromJWT(tokenData.accessToken);

    // Save to database
    const connection = await createProviderConnection({
      provider: "kiro",
      authType: "oauth",
      accessToken: tokenData.accessToken,
      refreshToken: tokenData.refreshToken,
      expiresAt: tokenData.expiresIn
        ? new Date(Date.now() + tokenData.expiresIn * 1000).toISOString()
        : null,
      email: email || null,
      providerSpecificData: {
        profileArn: tokenData.profileArn,
        authMethod: provider, // "google" or "github"
        provider: provider.charAt(0).toUpperCase() + provider.slice(1),
      },
      testStatus: "active",
    });

    const mitm = await autoSetupMitmForProvider("kiro");

    const response = NextResponse.json({
      success: true,
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
      },
      mitm,
    });
    response.cookies.set("kiro_social_oauth_state", "", {
      httpOnly: true,
      sameSite: "lax",
      secure: request.nextUrl?.protocol === "https:",
      path: "/api/oauth/kiro",
      maxAge: 0,
    });
    return response;
  } catch (error) {
    console.error("Kiro social exchange error:", error?.message);
    return NextResponse.json({ error: "Failed to complete Kiro social exchange" }, { status: 500 });
  }
}
