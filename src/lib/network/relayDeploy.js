import crypto from "crypto";

export function generateRelayAuthSecret() {
  return crypto.randomBytes(32).toString("hex");
}

export function buildVercelRelayCode(relaySecret) {
  const secret = JSON.stringify(relaySecret);
  return `
export const config = { runtime: "edge" };

const RELAY_SECRET = ${secret};

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

  const targetUrl = target.replace(/\\/$/, "") + relayPath;

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

  const targetUrl = target.replace(/\\/$/, "") + relayPath;
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

    const targetUrl = target.replace(/\\/$/, "") + relayPath;
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
