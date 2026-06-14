import { NextResponse } from "next/server";
import { createProxyPool } from "@/models";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { buildDenoRelayCode, generateRelayAuthSecret } from "@/lib/network/relayDeploy.js";
import { requireSpawnRouteAuth } from "@/lib/auth/spawnRouteAuth";

const DENO_V2_API = "https://api.deno.com/v2";

export async function POST(request) {
  try {
    const auth = await requireSpawnRouteAuth(request);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const body = await request.json();
    const denoToken = body.denoToken?.trim();
    const orgDomain = body.orgDomain?.trim();
    const projectName = body.projectName?.trim() || `relay-${Date.now().toString(36)}`;

    if (!orgDomain) {
      return NextResponse.json({ error: "Organization domain is required" }, { status: 400 });
    }

    if (!denoToken) {
      return NextResponse.json({ error: "Deno Deploy API token is required" }, { status: 400 });
    }

    const relayAuthSecret = generateRelayAuthSecret();
    const DENO_RELAY_CODE = buildDenoRelayCode(relayAuthSecret);

    const headers = {
      Authorization: `Bearer ${denoToken}`,
      "Content-Type": "application/json",
    };

    const createAppRes = await proxyAwareFetch(`${DENO_V2_API}/apps`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        slug: projectName,
        labels: { "custom.kind": "genesis-relay" },
        config: {
          install: "deno install",
          runtime: {
            type: "dynamic",
            entrypoint: "main.ts",
          },
        },
      }),
    });

    if (!createAppRes.ok) {
      const text = await createAppRes.text().catch(() => "");
      if (createAppRes.status === 409) {
        return NextResponse.json(
          { error: `App "${projectName}" already exists. Choose a different name.` },
          { status: 409 }
        );
      }
      return NextResponse.json(
        { error: `Failed to create app (${createAppRes.status}): ${text}` },
        { status: createAppRes.status }
      );
    }

    const app = await createAppRes.json();

    const deployRes = await proxyAwareFetch(`${DENO_V2_API}/apps/${app.id}/deploy`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        assets: {
          "main.ts": {
            kind: "file",
            content: DENO_RELAY_CODE,
            encoding: "utf-8",
          },
        },
      }),
    });

    if (!deployRes.ok) {
      const text = await deployRes.text().catch(() => "");
      console.error("Deno Deploy error:", deployRes.status, text);
      await proxyAwareFetch(`${DENO_V2_API}/apps/${app.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${denoToken}` },
      }).catch(() => {});
      return NextResponse.json(
        { error: `Deploy failed (${deployRes.status}): ${text}` },
        { status: deployRes.status }
      );
    }

    const revision = await deployRes.json();
    const revisionId = revision.id;

    let status = revision.status;
    let attempts = 0;
    const maxAttempts = 30; // 30 * 2s = 60s max
    while (status === "queued" || status === "building") {
      if (attempts >= maxAttempts) {
        throw new Error("Deploy timed out after 60 seconds");
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const statusRes = await proxyAwareFetch(`${DENO_V2_API}/revisions/${revisionId}`, {
        headers: { Authorization: `Bearer ${denoToken}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!statusRes.ok) break;
      const statusData = await statusRes.json();
      status = statusData.status;
      attempts++;
    }

    if (status !== "succeeded") {
      await proxyAwareFetch(`${DENO_V2_API}/apps/${app.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${denoToken}` },
      }).catch(() => {});
      return NextResponse.json(
        { error: `Deploy failed with status: ${status}` },
        { status: 500 }
      );
    }

    const orgSlug = orgDomain.split(".")[0];
    const deployUrl = `https://${projectName}.${orgSlug}.deno.net`;
    console.log("Deno deployUrl:", deployUrl);

    const proxyPool = await createProxyPool({
      name: projectName,
      proxyUrl: deployUrl,
      type: "deno",
      noProxy: "",
      isActive: true,
      strictProxy: true,
      relayAuthSecret,
    });

    return NextResponse.json({ proxyPool, deployUrl }, { status: 201 });
  } catch (error) {
    console.error("Error deploying Deno Deploy relay:", error?.stack || error);
    return NextResponse.json({ error: "Deno relay deployment failed" }, { status: 500 });
  }
}
