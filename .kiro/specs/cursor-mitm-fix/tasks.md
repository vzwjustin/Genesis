# Implementation Plan

## Overview

Fix Cursor MITM proxy HTTP/1.1 fallback bug using the exploratory bugfix workflow: write tests to confirm the bug, write preservation tests for unchanged behavior, implement the fix, then validate.

## Tasks

- [ ] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - Cursor HTTP/1.1 Fallback on Degraded Paths
  - **CRITICAL**: This test MUST FAIL on unfixed code — failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior — it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate Cursor requests silently fall to HTTP/1.1
  - **Scoped PBT Approach**: Scope the property to the three concrete failing paths: (1) DNS failure with no proxy, (2) proxy configured, (3) generic proxyFetch bypass
  - Create test file `tests/unit/cursor-http2-bug-condition.test.js`
  - Mock `resolveRealIP()` to return null/throw for DNS failure cases
  - Mock `proxyOptions.enabled = true` for proxy case
  - Test case 1 (DNS fail): When `resolveRealIP("api2.cursor.sh")` throws and no proxy configured, assert the executor either uses HTTP/2 transport or throws a descriptive DNS error — NOT silently sets `shouldForceFetch=true`
  - Test case 2 (Proxy): When `proxyOptions.enabled=true` for `api2.cursor.sh`, assert the system uses HTTP/2-over-CONNECT — NOT HTTP/1.1 ProxyAgent via `makeFetchRequest()`
  - Test case 3 (Generic proxyFetch): When `_proxyAwareFetch()` handles `api2.cursor.sh` with DNS resolving, assert HTTP/2 session is used — NOT `createBypassRequest()` (HTTP/1.1)
  - Test case 4 (Silent catch): When `resolveRealIP()` throws, assert error is propagated — NOT swallowed by empty `catch {}`
  - Run test on UNFIXED code
  - **EXPECTED OUTCOME**: Test FAILS (this is correct — it proves the bug exists: `shouldForceFetch` becomes true, `makeFetchRequest()` is called for Cursor, `createBypassRequest()` is called in proxyFetch, DNS errors are swallowed)
  - Document counterexamples found to understand root cause
  - Mark task complete when test is written, run, and failure is documented
  - _Requirements: 1.1, 1.2, 1.3, 1.4_

- [ ] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Non-Cursor and Happy-Path Behavior Unchanged
  - **IMPORTANT**: Follow observation-first methodology
  - Create test file `tests/unit/cursor-http2-preservation.test.js`
  - Observe: Non-Cursor MITM bypass hosts (`api.individual.githubcopilot.com`, `cloudcode-pa.googleapis.com`, `q.us-east-1.amazonaws.com`) use `createBypassRequest()` (HTTP/1.1) on unfixed code
  - Observe: Cursor happy path (DNS resolves, no proxy, http2 available) uses `makeHttp2Request()` with resolved IP on unfixed code
  - Observe: When `http2 = null` (unavailable), Cursor falls to fetch path on unfixed code
  - Write property-based test: for all non-Cursor MITM bypass hosts, transport is always HTTP/1.1 via `createBypassRequest()` — never HTTP/2
  - Write property-based test: for Cursor happy path (DNS resolves + no proxy + http2 available), transport is always `makeHttp2Request()` with realIP pinning
  - Write property-based test: when `http2` module is unavailable, the fetch fallback path is used regardless of host
  - Write property-based test: proxy routing precedence (per-connection → env → relay → direct) is unchanged for non-Cursor hosts
  - Verify all tests PASS on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (this confirms baseline behavior to preserve)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [ ] 3. Add `isHttp2Required()` helper to `src/shared/constants/mitmToolHosts.js`
  - Export `HTTP2_REQUIRED_HOSTS = ["api2.cursor.sh"]`
  - Export `isHttp2Required(hostname)` function that checks if hostname requires HTTP/2
  - Keep it minimal — just a Set lookup or array includes
  - _Requirements: 2.1, 2.2, 2.3, 2.4_

- [ ] 4. Fix DNS failure handling in `open-sse/executors/cursor.js`
  - Replace `catch { bypassIP = null; }` with explicit error propagation
  - When `resolveRealIP()` fails for Cursor AND no proxy is available, throw: `"External DNS resolution failed for api2.cursor.sh — cannot establish HTTP/2 bypass connection"`
  - When `resolveRealIP()` fails AND proxy IS configured, allow fallback to proxy path (proxy handles DNS)
  - Remove the silent `shouldForceFetch = true` fallback for DNS failure without proxy
  - _Requirements: 2.1, 2.4, 3.1_

- [ ] 5. Add HTTP/2-over-CONNECT proxy support in `open-sse/executors/cursor.js`
  - When `usingProxy=true` AND `http2` is available AND target is `api2.cursor.sh`, use HTTP/2 through CONNECT tunnel
  - Implement CONNECT tunnel: open TCP to proxy, send CONNECT, on 200 response negotiate TLS with ALPN `h2` on the tunneled socket, then `http2.connect()` with `createConnection` returning the TLS socket
  - Fall back to existing `makeFetchRequest()` for non-Cursor hosts with proxy (preservation)
  - _Requirements: 2.2, 3.2, 3.5_

- [ ] 6. Fix generic proxyFetch bypass for Cursor in `open-sse/utils/proxyFetch.js`
  - In the `shouldBypassMitmDns(targetUrl)` block, after `resolveRealIP()` succeeds, check `isHttp2Required(hostname)`
  - If HTTP/2 required: use an HTTP/2 session (import http2, connect with realIP pinning via `createConnection`, similar to cursor executor's `makeHttp2Request()`)
  - If HTTP/2 NOT required: continue using existing `createBypassRequest()` (HTTP/1.1)
  - Import `isHttp2Required` from `../../src/shared/constants/mitmToolHosts.js`
  - _Requirements: 2.3, 3.2_

- [ ] 7. Verify bug condition exploration test now passes
  - **IMPORTANT**: Re-run the SAME test from task 1 — do NOT write a new test
  - Run `npx vitest run tests/unit/cursor-http2-bug-condition.test.js` from tests directory
  - **EXPECTED OUTCOME**: Test PASSES (confirms bug is fixed)
  - _Requirements: 2.1, 2.2, 2.3, 2.4_

- [ ] 8. Verify preservation tests still pass
  - **IMPORTANT**: Re-run the SAME tests from task 2 — do NOT write new tests
  - Run `npx vitest run tests/unit/cursor-http2-preservation.test.js` from tests directory
  - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)

- [ ] 9. Checkpoint - Ensure all tests pass and build succeeds
  - Run full test suite: `cd tests && npx vitest run --reporter=verbose`
  - Clear webpack cache and rebuild: `rm -rf .next-cli-build && (cd cli && npm run build)`
  - Verify compiled output contains HTTP/2 proxy logic: `grep -R "isHttp2Required\|HTTP2_REQUIRED_HOSTS\|CONNECT" cli/app/.next-cli-build/server/chunks`
  - Verify compiled output contains DNS error propagation: `grep -R "External DNS resolution failed" cli/app/.next-cli-build/server/chunks`
  - Ensure all tests pass, ask the user if questions arise

## Task Dependency Graph

```json
{
  "waves": [
    ["1", "2"],
    ["3"],
    ["4", "5", "6"],
    ["7"],
    ["8"],
    ["9"]
  ]
}
```

## Notes

- Tasks 1 and 2 are independent and can be done in parallel — both run BEFORE any code changes
- Task 3 must complete before 4, 5, 6 since those import `isHttp2Required`
- Tasks 4, 5, 6 are independent implementation changes that can be done in parallel
- Task 7 and 8 validate the fix — they re-run existing tests, NOT new tests
- Task 9 is the final checkpoint: full suite + build verification per AGENTS.md requirements
- The canonical rebuild command is: `rm -rf .next-cli-build && (cd cli && npm run build)`
- Test runner: `vitest run` (not watch mode) from `tests/` directory
