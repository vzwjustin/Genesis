import { getProviderConnections } from "@/lib/localDb.js";
import { getExecutor, refreshTokenByProvider } from "open-sse/index.js";
import { requireSpawnRouteAuth } from "@/lib/auth/spawnRouteAuth";
import {
  hasAnthropicCacheBreakpoints,
  snapshotCacheProtectedBody,
} from "open-sse/rtk/cacheBoundary.js";

export async function POST(request) {
  const auth = await requireSpawnRouteAuth(request);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  try {
    const { provider, model, body } = await request.json();

    if (!provider || !model || !body) {
      return Response.json({ success: false, error: "provider, model, and body required" }, { status: 400 });
    }

    const connections = await getProviderConnections({ provider });
    const connection = connections.find(c => c.isActive !== false);
    if (!connection) {
      return Response.json({ success: false, error: `No active connection for provider: ${provider}` }, { status: 400 });
    }

    const credentials = {
      apiKey: connection.apiKey,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      copilotToken: connection.copilotToken,
      projectId: connection.projectId,
      providerSpecificData: connection.providerSpecificData
    };

    const executor = getExecutor(provider);
    const stream = body.stream !== false;
    const cacheProtectedSnapshot = snapshotCacheProtectedBody(body);
    const execOpts = {
      model,
      body,
      stream,
      credentials: cacheProtectedSnapshot
        ? { ...credentials, _preserveClientCache: true }
        : credentials,
      cacheProtectedSnapshot,
      passthrough: hasAnthropicCacheBreakpoints(body),
    };

    let { response } = await executor.execute(execOpts);

    // Auto-refresh token on 401/403 and retry (same as chatCore.js)
    if (response.status === 401 || response.status === 403) {
      const newCredentials = await refreshTokenByProvider(provider, credentials);
      if (newCredentials?.accessToken || newCredentials?.copilotToken) {
        Object.assign(credentials, newCredentials);
        execOpts.credentials = cacheProtectedSnapshot
          ? { ...credentials, _preserveClientCache: true }
          : credentials;
        ({ response } = await executor.execute(execOpts));
      }
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Translator] Provider error ${response.status}:`, errorText.slice(0, 500));
      return Response.json({ success: false, error: `Provider error: ${response.status}`, details: errorText }, { status: response.status });
    }

    const contentType = response.headers.get("content-type")
      || (stream ? "text/event-stream" : "application/json");

    return new Response(response.body, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      }
    });
  } catch (error) {
    console.error("[Translator] Send error:", error);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}
