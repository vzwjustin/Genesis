# Cursor MITM HTTP/2 Fix — Bugfix Design

## Overview

Cursor's API (`api2.cursor.sh`) is HTTP/2-only and returns status 464 on HTTP/1.1 connections. The proxy has multiple fallback paths that inadvertently downgrade to HTTP/1.1 when the happy path (direct HTTP/2 with DNS bypass IP) is unavailable. This fix ensures all Cursor-bound paths either use HTTP/2 or fail closed with a clear error, rather than silently falling to HTTP/1.1 and receiving cryptic 464 responses.

The fix targets three files: the cursor executor's routing logic, the generic `proxyFetch` bypass path, and touches the MITM host constants for HTTP/2-requirement awareness.

## Glossary

- **Bug_Condition (C)**: A request to `api2.cursor.sh` that takes any path other than the direct HTTP/2 happy path — specifically when DNS resolution fails, a proxy is configured, or the generic `proxyFetch` bypass handles the request
- **Property (P)**: The request either uses HTTP/2 transport (directly or via CONNECT tunnel) or fails closed with a clear error — never silently downgrades to HTTP/1.1
- **Preservation**: Existing behavior for non-Cursor MITM bypass hosts (GitHub Copilot, Google Cloud Code, AWS Q) that accept HTTP/1.1, and the Cursor happy path (DNS resolves, no proxy, HTTP/2 direct)
- **`makeHttp2Request()`**: The method in `open-sse/executors/cursor.js` that sends requests over HTTP/2 with optional real-IP pinning via `tls.connect()`
- **`createBypassRequest()`**: The function in `open-sse/utils/proxyFetch.js` that opens an HTTP/1.1 socket via `https.request()` for MITM bypass hosts
- **`_proxyAwareFetch()`**: The main routing function in `proxyFetch.js` that decides transport based on proxy config, DNS bypass, and relay settings
- **`shouldForceFetch`**: Boolean in cursor executor's `execute()` that routes the request to `makeFetchRequest()` (HTTP/1.1) instead of `makeHttp2Request()`
- **MITM bypass host**: A host in the `MITM_BYPASS_HOSTS` list that must not use system DNS (to avoid `/etc/hosts` poisoning)

## Bug Details

### Bug Condition

The bug manifests when a request targets `api2.cursor.sh` and any of the following conditions forces the transport off the HTTP/2 happy path: (1) external DNS resolution fails, (2) an outbound proxy is configured, or (3) the generic `proxyFetch` MITM bypass path handles the request. In all three cases, the system falls back to HTTP/1.1 transports that Cursor's ALB rejects with status 464.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type { hostname: string, dnsResult: IP|null, proxyConfigured: boolean, h2Available: boolean, path: "executor"|"proxyFetch" }
  OUTPUT: boolean

  LET isCursor = (input.hostname == "api2.cursor.sh")

  // Path 1: DNS fails in executor → shouldForceFetch=true → HTTP/1.1 fetch
  LET dnsFailFallback = isCursor AND input.dnsResult == null AND NOT input.proxyConfigured AND input.h2Available

  // Path 2: Proxy configured → shouldForceFetch=true → ProxyAgent HTTP/1.1
  LET proxyFallback = isCursor AND input.proxyConfigured

  // Path 3: Generic proxyFetch handles Cursor bypass → createBypassRequest (HTTP/1.1)
  LET genericBypassFallback = isCursor AND input.path == "proxyFetch" AND input.dnsResult != null

  // Path 4: DNS fails silently in executor (empty catch swallows error)
  LET dnsSwallowed = isCursor AND input.dnsResult == null AND input.h2Available

  RETURN dnsFailFallback OR proxyFallback OR genericBypassFallback OR dnsSwallowed
END FUNCTION
```

### Examples

- **DNS failure, no proxy**: `resolveRealIP("api2.cursor.sh")` returns `null` → `bypassIP=null` → `shouldForceFetch=true` → `makeFetchRequest()` → undici/native fetch over HTTP/1.1 → **464**
- **Proxy configured**: `proxyOptions.enabled=true` → `usingProxy=true` → `shouldForceFetch=true` → `proxyAwareFetch()` with ProxyAgent dispatcher (HTTP/1.1) → **464**
- **Generic proxyFetch bypass**: Request to `api2.cursor.sh` handled by `_proxyAwareFetch()` MITM bypass block → `resolveRealIP()` succeeds → `createBypassRequest()` opens `https.request()` (HTTP/1.1) → **464**
- **DNS failure silent swallow**: `resolveRealIP()` throws → empty `catch {}` in executor sets `bypassIP=null` → falls to fetch path silently, no error propagated to caller

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- Direct HTTP/2 happy path: DNS resolves, no proxy, `makeHttp2Request()` with `realIP` pinning continues working exactly as before
- Non-Cursor MITM bypass hosts (`api.individual.githubcopilot.com`, `cloudcode-pa.googleapis.com`, `q.us-east-1.amazonaws.com`) continue using HTTP/1.1 `createBypassRequest()` — those APIs accept HTTP/1.1
- Environments where `http2` module is unavailable continue using the fetch fallback path (existing degraded behavior)
- Passthrough mode for Cursor still enforces MITM bypass DNS rules
- Connect-RPC protobuf response parsing and SSE/JSON transformation remain unchanged
- Proxy routing precedence (per-connection → environment → relay → direct) remains unchanged for non-Cursor hosts

**Scope:**
All inputs that do NOT target `api2.cursor.sh` through a degraded path should be completely unaffected by this fix. This includes:
- Requests to non-Cursor providers (Anthropic, OpenAI, Copilot, etc.)
- Cursor requests on the happy path (DNS resolves, no proxy, HTTP/2 available)
- Non-MITM-bypass hosts routed through proxies

## Hypothesized Root Cause

Based on the bug description, the most likely issues are:

1. **Silent DNS failure in cursor executor**: The `try { bypassIP = await resolveRealIP(...) } catch { bypassIP = null; }` pattern in `execute()` swallows DNS errors. When `bypassIP=null` and `needsDnsBypass=true`, `shouldForceFetch` becomes true, routing to the HTTP/1.1 fetch path. The catch should propagate the error for Cursor since HTTP/2 is required.

2. **No HTTP/2 proxy transport**: When `usingProxy=true`, the executor unconditionally routes to `makeFetchRequest()` → `proxyAwareFetch()`, which uses undici's `ProxyAgent` dispatcher. Undici's ProxyAgent performs HTTP/1.1 CONNECT tunnels but does not negotiate HTTP/2 (ALPN `h2`) on the tunneled connection. The proxy path needs an HTTP/2-over-CONNECT implementation.

3. **Generic `createBypassRequest()` is HTTP/1.1 only**: The `_proxyAwareFetch()` MITM bypass block calls `createBypassRequest()` which uses node's `https.request()` — inherently HTTP/1.1. For Cursor-bound requests that reach this path, it should use an HTTP/2 session instead (similar to `makeHttp2Request()`).

4. **No HTTP/2 requirement awareness in proxyFetch**: The `MITM_BYPASS_HOSTS` list treats all hosts uniformly. There's no mechanism to know that `api2.cursor.sh` requires HTTP/2 while other bypass hosts accept HTTP/1.1, so the generic bypass path always uses the HTTP/1.1 `createBypassRequest()`.

## Correctness Properties

Property 1: Bug Condition - Cursor requests fail closed or use HTTP/2

_For any_ request where the target is `api2.cursor.sh` and the normal HTTP/2 direct path is unavailable (DNS fails OR proxy configured OR generic proxyFetch bypass), the system SHALL either (a) use HTTP/2 transport (via CONNECT tunnel with ALPN h2 negotiation or direct h2 session) or (b) fail with a clear, descriptive error indicating why HTTP/2 could not be established — never silently fall back to HTTP/1.1.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4**

Property 2: Preservation - Non-Cursor and happy-path behavior unchanged

_For any_ request where the target is NOT `api2.cursor.sh` OR where the target IS `api2.cursor.sh` but the happy path succeeds (DNS resolves, no proxy, http2 available), the fixed code SHALL produce exactly the same transport behavior and response as the original code, preserving HTTP/1.1 bypass for non-Cursor hosts and direct HTTP/2 for the Cursor happy path.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**

## Fix Implementation

### Changes Required

Assuming our root cause analysis is correct:

**File**: `open-sse/executors/cursor.js`

**Function**: `execute()`

**Specific Changes**:
1. **Propagate DNS failure explicitly**: Replace the empty `catch { bypassIP = null; }` with error propagation. When `resolveRealIP()` fails for Cursor and no proxy is available, throw a clear error: `"External DNS resolution failed for api2.cursor.sh — cannot establish HTTP/2 bypass connection"`

2. **HTTP/2-over-proxy for Cursor**: When `usingProxy=true` and `http2` is available, instead of routing to `makeFetchRequest()`, establish an HTTP/2 session through a CONNECT tunnel. Use `http2.connect()` with a `createConnection` that first opens a CONNECT tunnel through the proxy, then negotiates TLS+ALPN h2 on the tunneled socket.

3. **Remove silent `shouldForceFetch` fallback for DNS failure**: When `needsDnsBypass=true` and `bypassIP=null` and no proxy is configured, do not set `shouldForceFetch=true`. Instead, throw immediately (fail closed).

**File**: `open-sse/utils/proxyFetch.js`

**Function**: `_proxyAwareFetch()` MITM bypass block

**Specific Changes**:
4. **HTTP/2 bypass for Cursor in generic path**: In the `shouldBypassMitmDns(targetUrl)` block, after `resolveRealIP()` succeeds, check if the host requires HTTP/2 (i.e., `api2.cursor.sh`). If so, use an HTTP/2 session (similar to `makeHttp2Request()`) instead of `createBypassRequest()`. This covers cases where Cursor requests reach `proxyFetch` outside the executor (e.g., non-standard routing).

5. **HTTP/2 requirement helper**: Add a helper function (or import from `mitmToolHosts.js`) that identifies which bypass hosts require HTTP/2. Initially this is just `api2.cursor.sh`.

**File**: `src/shared/constants/mitmToolHosts.js`

**Specific Changes**:
6. **Export HTTP/2-required hosts**: Add an exported constant or function (e.g., `HTTP2_REQUIRED_HOSTS = ["api2.cursor.sh"]` and `isHttp2Required(hostname)`) so both the executor and proxyFetch can determine transport requirements without hardcoding.

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that demonstrate the bug on unfixed code, then verify the fix works correctly and preserves existing behavior.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix. Confirm or refute the root cause analysis. If we refute, we will need to re-hypothesize.

**Test Plan**: Write unit tests that mock DNS resolution failure, proxy configuration, and the generic proxyFetch path for Cursor-bound requests. Run these tests on the UNFIXED code to observe that requests fall to HTTP/1.1 paths.

**Test Cases**:
1. **DNS Failure Fallback Test**: Mock `resolveRealIP()` returning null for `api2.cursor.sh`, no proxy → observe `shouldForceFetch=true` and `makeFetchRequest()` called (will use HTTP/1.1 on unfixed code)
2. **Proxy Configured Test**: Set `proxyOptions.enabled=true` with a cursor URL → observe `shouldForceFetch=true` and `makeFetchRequest()` called (HTTP/1.1 on unfixed code)
3. **Generic ProxyFetch Bypass Test**: Call `proxyAwareFetch("https://api2.cursor.sh/...", ...)` with DNS resolving → observe `createBypassRequest()` called (HTTP/1.1 on unfixed code)
4. **Silent DNS Error Test**: Mock `resolveRealIP()` throwing an exception → observe error is swallowed and `bypassIP` set to null silently (on unfixed code)

**Expected Counterexamples**:
- `makeFetchRequest()` is invoked for Cursor when it should be `makeHttp2Request()` or an error
- `createBypassRequest()` is invoked for Cursor in the generic proxyFetch path
- DNS errors are caught and discarded without propagation
- Possible causes: missing HTTP/2 transport in proxy path, no host-aware protocol selection in `createBypassRequest()`, empty catch block

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed function produces the expected behavior.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  result := execute_fixed(input) OR proxyAwareFetch_fixed(input)
  ASSERT result.transport == "h2" OR result.error CONTAINS "DNS" OR result.error CONTAINS "HTTP/2"
  ASSERT result.status != 464
  ASSERT result.transport != "http/1.1"
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed function produces the same result as the original function.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT execute_original(input).transport == execute_fixed(input).transport
  ASSERT proxyAwareFetch_original(input).transport == proxyAwareFetch_fixed(input).transport
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many test cases automatically across the input domain (varying hostnames, proxy configs, DNS states)
- It catches edge cases like subdomain matching, null proxy options, partial configs
- It provides strong guarantees that non-Cursor hosts and happy-path Cursor remain unchanged

**Test Plan**: Observe behavior on UNFIXED code first for non-Cursor MITM bypass hosts and happy-path Cursor, then write property-based tests capturing that behavior.

**Test Cases**:
1. **Non-Cursor Bypass Preservation**: Verify `createBypassRequest()` continues to be called for `api.individual.githubcopilot.com`, `cloudcode-pa.googleapis.com`, etc. on both unfixed and fixed code
2. **Happy Path Preservation**: Verify `makeHttp2Request()` with resolved IP continues to be called for Cursor when DNS succeeds and no proxy is configured
3. **No-http2 Environment Preservation**: Verify that when `http2=null`, the fetch fallback path is still used (environments without http2 support)
4. **Proxy Routing Precedence Preservation**: Verify non-Cursor hosts with proxies continue using the existing dispatcher-based routing

### Unit Tests

- Test that DNS failure for Cursor throws a descriptive error (not silently falls to fetch)
- Test that proxy-configured Cursor uses HTTP/2 CONNECT tunnel (mock socket negotiation)
- Test that generic proxyFetch uses HTTP/2 for `api2.cursor.sh` after DNS resolve
- Test that `isHttp2Required("api2.cursor.sh")` returns true
- Test that `isHttp2Required("api.individual.githubcopilot.com")` returns false
- Test edge case: DNS failure + proxy configured → proxy CONNECT tunnel used (not error)

### Property-Based Tests

- Generate random hostnames from MITM_BYPASS_HOSTS and verify only `api2.cursor.sh` triggers HTTP/2 requirement
- Generate random combinations of `{ dnsResult, proxyConfigured, h2Available }` for Cursor and verify the output is always HTTP/2 or explicit error (never HTTP/1.1 silent fallback)
- Generate random non-Cursor bypass host requests and verify transport is always HTTP/1.1 `createBypassRequest()` (preservation)

### Integration Tests

- End-to-end test: Cursor request with mocked upstream HTTP/2 server behind a CONNECT proxy → verify 200 response with valid protobuf
- End-to-end test: Cursor request with DNS failure and no proxy → verify clear error message returned to caller
- End-to-end test: Non-Cursor MITM bypass host → verify HTTP/1.1 bypass still works unchanged
- Build verification: After fix, `rm -rf .next-cli-build && (cd cli && npm run build)` then grep compiled chunks for HTTP/2 proxy logic
