# Bugfix Requirements Document

## Introduction

The Cursor MITM proxy intercept fails when the upstream request path falls back to HTTP/1.1. Cursor's API (`api2.cursor.sh`) is HTTP/2-only and returns status 464 when receiving HTTP/1.1 connections. The proxy's DNS bypass and proxy-routing fallback paths both use HTTP/1.1 transports (node `https.request()` or undici fetch with ProxyAgent), causing all non-happy-path scenarios to fail with 464 errors. This makes Cursor MITM unreliable whenever external DNS resolution fails or an outbound proxy is configured.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN external DNS resolution via 8.8.8.8 fails for `api2.cursor.sh` (e.g., firewall blocks outbound UDP/53) AND no outbound proxy is configured THEN the system sets `shouldForceFetch=true` and sends the request via `proxyAwareFetch()` using HTTP/1.1, causing Cursor's ALB to return status 464

1.2 WHEN an outbound proxy is configured (connection proxy or environment HTTPS_PROXY) AND the target is `api2.cursor.sh` THEN the system sets `shouldForceFetch=true` and routes through the proxy via undici ProxyAgent (HTTP/1.1), causing Cursor's ALB to return status 464

1.3 WHEN the generic `proxyFetch` MITM bypass path handles a request to `api2.cursor.sh` (outside the cursor executor) THEN the system uses `createBypassRequest()` which opens an HTTP/1.1 socket via `https.request()`, causing Cursor's ALB to return status 464

1.4 WHEN external DNS resolution fails AND `strictProxy` is not false AND no proxy is configured THEN the cursor executor catches the `resolveRealIP` failure silently (via empty catch) and falls to the HTTP/1.1 fetch path instead of surfacing the DNS failure as an error to the caller

### Expected Behavior (Correct)

2.1 WHEN external DNS resolution fails for `api2.cursor.sh` AND no outbound proxy is configured THEN the system SHALL fail the request with a clear DNS bypass error indicating that external DNS is unreachable, rather than falling back to HTTP/1.1

2.2 WHEN an outbound proxy is configured AND the target is `api2.cursor.sh` THEN the system SHALL route the request through the proxy using HTTP/2 (via ALPN negotiation or h2-over-CONNECT tunnel), so that Cursor's API receives an HTTP/2 connection and does not return 464

2.3 WHEN the generic `proxyFetch` MITM bypass path handles a request to `api2.cursor.sh` THEN the system SHALL use an HTTP/2 transport (consistent with the cursor executor's `makeHttp2Request`) instead of the HTTP/1.1 `createBypassRequest()` fallback

2.4 WHEN external DNS resolution fails for `api2.cursor.sh` THEN the cursor executor SHALL propagate the DNS failure as an explicit error (not silently swallow it) so the caller receives a meaningful error message rather than a cryptic 464 or connection error

### Unchanged Behavior (Regression Prevention)

3.1 WHEN external DNS resolution succeeds for `api2.cursor.sh` AND no outbound proxy is configured THEN the system SHALL CONTINUE TO use `makeHttp2Request()` with the resolved real IP pinned to the TLS socket (existing happy path)

3.2 WHEN a request targets a non-Cursor MITM bypass host (e.g., `api.individual.githubcopilot.com`, `cloudcode-pa.googleapis.com`) THEN the system SHALL CONTINUE TO use the HTTP/1.1 `createBypassRequest()` path, since those APIs accept HTTP/1.1

3.3 WHEN `http2` module is unavailable in the runtime THEN the system SHALL CONTINUE TO fall back to the fetch path (current behavior for environments without http2 support)

3.4 WHEN Cursor requests succeed via the HTTP/2 happy path THEN the system SHALL CONTINUE TO correctly parse the Connect-RPC protobuf response frames and transform them to SSE/JSON format

3.5 WHEN the proxy is operating in passthrough mode for Cursor THEN the system SHALL CONTINUE TO enforce MITM bypass DNS rules and return raw provider-native bytes without protobuf transformation
