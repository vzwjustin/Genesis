import crypto from "crypto";

export function generateRelayAuthSecret() {
  return crypto.randomBytes(32).toString("hex");
}

const RELAY_SAFETY_HELPERS = `
function isPrivateRelayHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\\[|\\]$/g, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "metadata.google.internal") return true;
  if (host.includes(":")) return true;
  const parts = host.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

function normalizeRelayTarget(target, relayPath) {
  const base = new URL(target);
  if (base.protocol !== "https:") throw new Error("Relay target must use https");
  if (base.username || base.password) throw new Error("Relay target must not contain credentials");
  if (isPrivateRelayHost(base.hostname)) throw new Error("Relay target host is not allowed");
  const path = relayPath || "/";
  if (!path.startsWith("/")) throw new Error("Relay path must start with /");
  return base.origin + base.pathname.replace(/\\/$/, "") + path;
}
`;

const RELAY_TARGET_ERROR = `
function relayTargetError(error) {
  return new Response(JSON.stringify({ error: error.message || "Invalid relay target" }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}
`;

export function buildVercelRelayCode(relaySecret) {
  const secret = JSON.stringify(relaySecret);
  return `
export const config = { runtime: "edge" };

const RELAY_SECRET = ${secret};
${RELAY_SAFETY_HELPERS}
${RELAY_TARGET_ERROR}

export default async function handler(req) {
  const auth = req.headers.get("x-relay-auth");
  if (!auth || auth !== RELAY_SECRET) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const target = req.headers.get("x-relay-target");
  const relayPath = req.headers.get("x-relay-path") || "/";
  if (!target) {
    return new Response(JSON.stringify({ error: "Missing x-relay-target header" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  let targetUrl;
  try {
    targetUrl = normalizeRelayTarget(target, relayPath);
  } catch (error) {
    return relayTargetError(error);
  }

  const headers = new Headers(req.headers);
  headers.delete("x-relay-target");
  headers.delete("x-relay-path");
  headers.delete("x-relay-auth");
  headers.delete("host");

  const response = await fetch(targetUrl, {
    method: req.method,
    headers,
    body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
    duplex: "half",
    redirect: "manual",
  });

  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  });
}
`;
}

export function buildDenoRelayCode(relaySecret) {
  const secret = JSON.stringify(relaySecret);
  return `const RELAY_SECRET = ${secret};
${RELAY_SAFETY_HELPERS}
${RELAY_TARGET_ERROR}

Deno.serve(async (request) => {
  const auth = request.headers.get("x-relay-auth");
  if (!auth || auth !== RELAY_SECRET) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const target = request.headers.get("x-relay-target");
  const relayPath = request.headers.get("x-relay-path") || "/";

  if (!target) {
    return new Response(JSON.stringify({ error: "Missing x-relay-target header" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  let targetUrl;
  try {
    targetUrl = normalizeRelayTarget(target, relayPath);
  } catch (error) {
    return relayTargetError(error);
  }
  const newHeaders = new Headers(request.headers);
  newHeaders.delete("x-relay-target");
  newHeaders.delete("x-relay-path");
  newHeaders.delete("x-relay-auth");
  newHeaders.delete("host");

  const init = {
    method: request.method,
    headers: newHeaders,
    redirect: "manual",
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }

  try {
    const response = await fetch(targetUrl, init);
    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
});`;
}

export function buildCloudflareRelayCode(relaySecret) {
  const secret = JSON.stringify(relaySecret);
  return `
const RELAY_SECRET = ${secret};
${RELAY_SAFETY_HELPERS}
${RELAY_TARGET_ERROR}

export default {
  async fetch(request, env, ctx) {
    const auth = request.headers.get("x-relay-auth");
    if (!auth || auth !== RELAY_SECRET) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }

    const target = request.headers.get("x-relay-target");
    const relayPath = request.headers.get("x-relay-path") || "/";
    
    if (!target) {
      return new Response(JSON.stringify({ error: "Missing x-relay-target header" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    let targetUrl;
    try {
      targetUrl = normalizeRelayTarget(target, relayPath);
    } catch (error) {
      return relayTargetError(error);
    }
    const newRequestInit = {
      method: request.method,
      headers: new Headers(request.headers),
      redirect: "manual",
    };

    if (request.method !== "GET" && request.method !== "HEAD") {
      newRequestInit.body = request.body;
      newRequestInit.duplex = "half";
    }

    newRequestInit.headers.delete("x-relay-target");
    newRequestInit.headers.delete("x-relay-path");
    newRequestInit.headers.delete("x-relay-auth");
    newRequestInit.headers.delete("host");

    try {
      const response = await fetch(targetUrl, newRequestInit);
      return new Response(response.body, {
        status: response.status,
        headers: response.headers,
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }
  },
};
`;
}
