# Implementation Plan: AI Compression Routing Proxy

## Overview

This implementation plan covers the AI Compression Routing Proxy — a local AI gateway that sits between developer clients (CLIs, IDEs, extensions) and upstream AI provider APIs. The proxy translates between formats (OpenAI, Claude, Gemini, Cursor, Kiro, etc.), compresses request payloads to reduce token usage and latency, and routes traffic across providers with fallback, retry, and per-account cooldown logic.

The implementation is organized into 16 task groups covering: format translation, passthrough mode, model resolution, credential selection, account fallback, combo sequencing, streaming, Anthropic tool cleaning, RTK/Headroom/Caveman compression, outbound proxy, MITM DNS bypass, logging, authentication, statistics tracking, and build/runtime verification. Tasks are ordered so each builds on prior work, with checkpoints for incremental validation.

Passthrough mode is a first-class behavior in this fork. It gets its own dedicated task group because the behavioral rules are extensive and distinct from normal translation.

## Tasks

- [x] 1. Format Detection and Translation Pipeline
  - [x] 1.1 Implement format detection (header → body schema → heuristic) in `open-sse/services/provider.js`
    - Detect OpenAI, Claude, Gemini, Antigravity, and OpenAI-Responses formats
    - Priority order: header presence → body field schema → heuristic fallback
    - _Requirements: 1.1_
  - [x] 1.2 Implement translator registry with source→intermediate→target conversion pattern
    - Lazy-loaded format converters using registry Map
    - Two-step translation: source → OpenAI intermediate → target
    - _Requirements: 1.3_
  - [x] 1.3 Implement response translation (target→source format) for streaming chunks and full JSON
    - Translate provider responses back to the client's expected source format
    - _Requirements: 1.5_
  - [x] 1.4 Return HTTP 400 for any pre-dispatch validation failure (format detection, translation, schema)
    - Descriptive error message for format detection failure, translation failure, model resolution failure, schema violation
    - Use error types: `translation_invalid_body`, `validation_failed`, `unsupported_request`, `missing_required_field`
    - _Requirements: 1.4_
  - [x] 1.5 Ensure translation does NOT run when passthrough mode is active
    - Translation rules do not automatically apply to passthrough mode
    - Guard all translation code paths against passthrough requests
    - _Requirements: 1.2, 1.3_
  - [ ]* 1.6 Write unit tests for format detection (OpenAI, Claude, Gemini, Antigravity, OpenAI-Responses)
    - Test each format with representative request bodies
    - _Requirements: 1.1_
  - [x]* 1.7 Write unit tests for translation validation failures
    - Invalid translator output returns HTTP 400
    - Valid translation with failed post-translation validation returns HTTP 400
    - Valid translation and validation proceeds upstream
    - Translation rules do not accidentally run during passthrough mode
    - _Requirements: 1.3, 1.4_
  - [ ]* 1.8 Write property test for request format translation round-trip
    - **Property 1: Request Format Translation Round-Trip**
    - **Validates: Requirements 1.1, 1.3, 1.5**

- [x] 2. Passthrough Mode
  - [x] 2.1 Implement passthrough detection (same ecosystem client/provider matching)
    - Claude CLI → Anthropic, OpenAI SDK → OpenAI, Cursor → Cursor
    - Use both spellings in comments/searches: `passthrough` and `passthru`
    - _Requirements: 1.2_
  - [x] 2.2 Implement passthrough request forwarding: swap model name + auth header ONLY
    - Do NOT run normal translation
    - Do NOT normalize fields or rename provider-native fields
    - Do NOT drop unknown provider-native fields
    - Do NOT rewrite tool schemas unless a known compatibility rule requires it
    - _Requirements: 1.2_
  - [x] 2.3 Implement passthrough compression guard: do NOT compress unless passthrough compression explicitly enabled
    - Do NOT alter provider-native message arrays unless configured
    - If compression is explicitly enabled and fails, continue with original unmodified content
    - _Requirements: 1.2, 7.3_
  - [x] 2.4 Implement passthrough response preservation
    - Preserve upstream response shape, error shape, streaming behavior, provider-specific fields
    - Do NOT convert to another provider schema unless the endpoint contract explicitly requires it
    - _Requirements: 1.2, 1.5_
  - [x] 2.5 Implement passthrough error handling: fail clearly, do NOT silently fall back to translated mode
    - If passthrough provider resolution fails: return error
    - Do NOT guess the intended provider
    - Do NOT mutate the request into a different provider format
    - _Requirements: 1.2_
  - [x] 2.6 Ensure passthrough still applies: auth enforcement, provider/model resolution, connection selection, outbound proxy, MITM bypass DNS, timeout, retry/cooldown, upstream auth header injection, logging, streaming adaptation when required
    - These are proxy responsibilities and apply regardless of passthrough
    - _Requirements: 1.2, 10.1, 11.1, 13.1_
  - [x] 2.7 Implement passthrough streaming rules
    - If client requested streaming, preserve streaming
    - If client requested non-streaming but upstream always streams, assemble SSE into JSON
    - If assembly fails, discard partial data and return error
    - Never return partial JSON as success
    - _Requirements: 1.2, 6.3, 6.6_
  - [x]* 2.8 Write unit tests for passthrough behavior
    - Passthrough request does not run normal translation
    - Passthrough preserves unknown provider-native fields
    - Passthrough preserves client-requested streaming
    - Passthrough does not compress by default
    - Passthrough still applies auth
    - Passthrough still applies outbound proxy routing
    - Passthrough still applies MITM bypass DNS rules
    - Passthrough provider resolution failure returns an error (not silent fallback)
    - _Requirements: 1.2_
  - [ ]* 2.9 Write property test for passthrough skips translation
    - **Property 6: Passthrough Skips Translation**
    - **Validates: Requirements 1.2**

- [x] 3. Model and Alias Resolution
  - [x] 3.1 Implement model string parsing (`provider/model` vs plain alias vs combo name)
    - Parse model string using `parseModel()` from `services/model.js`
    - _Requirements: 2.1_
  - [x] 3.2 Implement alias registry lookup
    - Plain string lookup in alias registry resolving to provider/model pair
    - _Requirements: 2.2_
  - [x] 3.3 Implement combo expansion into ordered provider/model list
    - Expand combo name into ordered list of provider/model strings
    - A combo match succeeds only when it resolves to a valid actionable provider/model target
    - _Requirements: 2.3_
  - [x] 3.4 Return HTTP 400 when resolution fails (after all methods attempted)
    - Descriptive error message when model string cannot be resolved
    - Do NOT silently fall back or treat combo-name match alone as success
    - _Requirements: 2.4_
  - [x] 3.5 Log resolved routing path for every request
    - Log original Model_String → resolved provider/model
    - _Requirements: 2.5_
  - [x]* 3.6 Write unit tests for alias resolution edge cases (missing alias, ambiguous prefix, combo vs alias)
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

- [x] 4. Provider Credential Selection
  - [x] 4.1 Implement connection filtering (exclude cooldown, exclude invalid credentials)
    - Filter by provider, exclude rateLimitedUntil in future, exclude failed OAuth refresh
    - _Requirements: 3.1_
  - [x] 4.2 Implement priority-based sticky round-robin selection
    - Sort by priority, apply sticky limit for consecutive requests on same connection
    - _Requirements: 3.2_
  - [x] 4.3 Return HTTP 404 when no valid-credential connections exist (including zero configured)
    - Message: "No active credentials for provider: {provider}"
    - Zero connections = zero retries, no initial request attempted
    - _Requirements: 3.3_
  - [x] 4.4 Implement cooldown wait with minimum 1-second retry delay
    - Wait until earliest cooldown reset time; enforce MIN_RETRY_DELAY_MS = 1000
    - Never return Retry-After: 0 for a no-capacity state
    - _Requirements: 3.4_
  - [x] 4.5 Implement OAuth token pre-check and refresh (5-minute expiry window)
    - Refresh token before dispatch when within 5 minutes of expiry
    - _Requirements: 3.5_
  - [x] 4.6 Handle token refresh failure → mark unusable → Account_Fallback
    - Mark connection as unusable; proceed to next available connection
    - _Requirements: 3.6_
  - [ ]* 4.7 Write property test for credential selection excludes cooldowns
    - **Property 3: Credential Selection Excludes Cooldowns**
    - **Validates: Requirements 3.1, 3.3, 4.8**
  - [x]* 4.8 Write unit tests for retry behavior
    - Zero configured connections causes no request attempt (immediate HTTP 404)
    - Unavailable provider returns minimum Retry-After: 1 instead of 0
    - Retry limit matches configured connection count
    - _Requirements: 3.3, 3.4, 4.7, 4.8_

- [x] 5. Checkpoint - Ensure core routing passes
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Account Fallback on Error
  - [x] 6.1 Implement HTTP 429 handling: exponential backoff cooldown + retry next connection
    - Starting at 1s, doubling per consecutive failure; capped at max
    - _Requirements: 4.1_
  - [x] 6.2 Implement HTTP 5xx handling: transient 30s cooldown + retry next connection
    - Fixed 30s cooldown duration for 500/502/503/504
    - _Requirements: 4.2_
  - [x] 6.3 Implement HTTP 401/403 handling: immediate fallback (no cooldown)
    - Trigger Account_Fallback when token refresh fails
    - _Requirements: 4.3_
  - [x] 6.4 Implement HTTP 2xx handling: reset backoff level and cooldown
    - Clear rateLimitedUntil and reset backoffLevel to 0
    - Backoff resets ONLY on 2xx, not on 4xx
    - _Requirements: 4.4_
  - [x] 6.5 Return HTTP 503 when all connections exhausted (at least one 5xx)
    - Include last upstream error message
    - _Requirements: 4.5_
  - [x] 6.6 Enforce max retries = number of configured connections
    - _Requirements: 4.7_
  - [x] 6.7 Zero connections = zero retries, immediate HTTP 404
    - _Requirements: 4.8_
  - [ ]* 6.8 Write property test for backoff exponential growth
    - **Property 5: Backoff Exponential Growth**
    - **Validates: Requirements 4.1**
  - [x]* 6.9 Write unit tests for backoff reset
    - Backoff reset only on 2xx, not on 4xx
    - _Requirements: 4.4_

- [x] 7. Combo Fallback Sequencing
  - [x] 7.1 Implement combo position advancement on 429/5xx only
    - Advance to next model in ordered list; apply cooldown to failed connection
    - _Requirements: 5.1, 5.4, 5.5_
  - [x] 7.2 Implement combo stop on 200 (return response, don't advance)
    - _Requirements: 5.2_
  - [x] 7.3 Implement combo 4xx behavior: return response to client, do NOT advance
    - Only apply 4xx combo behavior when model actually returns HTTP 4xx
    - Do NOT apply to 200, 5xx, network errors, or proxy-internal errors
    - _Requirements: 5.3_
  - [x] 7.4 Return HTTP 503 when all combo models exhausted
    - Include last error message from final model attempt
    - _Requirements: 5.6_
  - [x] 7.5 Ensure combo logic only applies to combo requests, not plain provider/model
    - Non-combo requests MUST NOT read or modify combo state
    - _Requirements: 5.1_
  - [x] 7.6 Handle zero connections for a combo entry: immediately skip and advance
    - _Requirements: 5.1_
    - Note: current behavior returns HTTP 404 from `handleSingleModel` without advancing (Req 5.3 4xx rule). Preflight skip-before-dispatch not yet implemented.
  - [x]* 7.8 Write unit tests for combo sequencing (`combo-sequencing.test.js`)
  - [ ]* 7.7 Write property test for combo advancement only on retriable errors
    - **Property 4: Combo Advancement Only On Retriable Errors**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5**

- [x] 8. Streaming and Non-Streaming Response Handling
  - [x] 8.1 Implement streaming relay (SSE pass-through with format translation)
    - Relay upstream SSE stream to client in Source_Format
    - _Requirements: 6.1_
  - [x] 8.2 Implement non-streaming JSON response assembly
    - Return translated response as application/json
    - _Requirements: 6.2_
  - [x] 8.3 Implement SSE assembly for always-streaming providers (collect → JSON, Content-Type: application/json)
    - Collect full SSE stream, assemble into single JSON response
    - Set Content-Type to application/json on assembled response
    - _Requirements: 6.3_
  - [x] 8.4 Implement Accept header detection for JSON preference
    - Accept contains application/json and not text/event-stream and stream !== true → non-streaming
    - _Requirements: 6.4_
  - [x] 8.5 Implement client disconnect → abort upstream + release resources
    - _Requirements: 6.5_
  - [x] 8.6 Implement stream assembly failure handling: discard ALL partial data, return error
    - Partial JSON MUST NEVER be returned to non-streaming clients
    - Non-streaming clients must receive complete valid JSON or a clear error
    - _Requirements: 6.6_
  - [x]* 8.7 Write unit tests for streaming behavior
    - Always-streaming provider assembles full SSE into JSON for non-streaming client
    - Malformed SSE discards partial content
    - Malformed SSE returns an error
    - Successful assembly returns Content-Type: application/json
    - _Requirements: 6.3, 6.6_
  - [ ]* 8.8 Write property test for SSE assembly discards all partial data on failure
    - **Property 10: SSE Assembly Discards All Partial Data on Failure**
    - **Validates: Requirements 6.6**

- [x] 9. Anthropic Tool Cleaning
  - [x] 9.1 Implement client tool cleaning: strip `model` and `type` when type is missing or equals "function"
    - For client tools (type missing or type === "function"): strip model, strip type
    - _Requirements: 1.6_
  - [x] 9.2 Implement built-in tool handling: preserve all properties, strip provider prefix from `model`
    - For built-in tools: preserve properties, but strip `provider/` prefix from model if present
    - Anthropic rejects prefixed model names (e.g., `cc/claude-opus-4-6`) inside built-in tool definitions
    - _Requirements: 1.6_
  - [x] 9.3 Implement passthrough compatibility fix: apply Anthropic tool model-prefix stripping in passthrough mode
    - This is a known compatibility fix that prevents upstream rejection
    - Passthrough mode still applies this fix ONLY when required to prevent Anthropic rejection
    - _Requirements: 1.2, 1.6_
  - [x]* 9.4 Write unit tests for Anthropic tool cleaning
    - Client tools strip `model` and `type`
    - Built-in tools preserve properties
    - Built-in tool `model` strips provider prefixes like `cc/`
    - Prefixed built-in tool models do not reach Anthropic
    - Passthrough mode still applies this fix only when required to prevent Anthropic rejection
    - _Requirements: 1.6_

- [x] 10. Checkpoint - Ensure routing and streaming pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. RTK Tool-Result Compression
  - [x] 11.1 Implement cache boundary detection and message eligibility filtering
    - Find last cache_control marker; messages at/before boundary are ineligible
    - When no cache_control marker exists, all messages are eligible
    - **HARD CORRECTNESS INVARIANT**: cache boundary content is immutable; violation silently corrupts provider KV prompt cache
    - Implement post-compression integrity check: verify messages at/before boundary are byte-for-byte unchanged
    - If integrity check fails: abort compression, log critical error, use original unmodified content
    - _Requirements: 7.3, 7.4_
  - [x] 11.2 Implement tool result shape detection for all source formats (OpenAI, Claude, Responses, Kiro)
    - OpenAI tool messages, Claude tool_result blocks, OpenAI Responses function_call_output, Kiro toolResults
    - _Requirements: 7.2_
  - [x] 11.3 Implement size gate: skip blobs < 500 bytes or > 10 MiB
    - _Requirements: 7.5_
  - [x] 11.4 Implement content type auto-detection (git diff, git status, grep, build, file tree, ls, numbered dump, log dedup)
    - _Requirements: 7.6_
  - [x] 11.5 Implement named filter application for detected types
    - _Requirements: 7.7_
  - [x] 11.6 Implement smart truncation fallback for unmatched content
    - _Requirements: 7.8_
  - [x] 11.7 Implement secondary fallback: named filter → smart truncation when output >= input; use smart truncation when it produces smaller output than named filter
    - _Requirements: 7.9, 7.10_
  - [x] 11.8 Implement error handling: log error → continue with original content (even if logging fails)
    - Compression must never make the request less reliable than sending the original content
    - _Requirements: 7.11_
  - [x] 11.9 Record compression stats per request (bytes before/after, filter hits) — only when compression actually applied
    - _Requirements: 7.12_
  - [x]* 11.10 Write unit tests for compression behavior
    - Detected git diff uses matching filter
    - Matching filter failure falls back to smart truncation
    - Compression internal error returns original content
    - Compression logging failure does not stop request
    - Passthrough requests are not compressed by default
    - _Requirements: 7.7, 7.8, 7.9, 7.11_
  - [ ]* 11.11 Write property test for cache boundary preservation
    - **Property 2: Cache Boundary Preservation (HARD CORRECTNESS INVARIANT)**
    - Verify messages at/before boundary are byte-for-byte unchanged after RTK compression
    - Verify no boundary-or-earlier content is sent to Headroom
    - Generate: cache_control at position 0, mid, end; verify immutability at all positions
    - This property must NEVER be weakened or made conditional
    - **Validates: Requirements 7.3, 8.2**
  - [ ]* 11.12 Write property test for RTK smart truncation secondary fallback
    - **Property 12: RTK Smart Truncation Secondary Fallback**
    - **Validates: Requirements 7.9, 7.10**

- [x] 12. Headroom ML Compression
  - [x] 12.1 Implement skip conditions: empty tail or system-only tail → hard skip BEFORE probing service
    - No health probe, no summarization request when tail is empty or system-only
    - _Requirements: 8.3_
  - [x] 12.2 Implement Headroom health probe with 30-second caching interval
    - Probe at most once every 30 seconds; cache reachability result
    - Do not probe more frequently just because a rate limit allows it
    - _Requirements: 8.6_
  - [x] 12.3 Implement tail extraction (messages after cache boundary)
    - Content at/before cache boundary excluded — **HARD CORRECTNESS INVARIANT**
    - Cache boundary content MUST NOT be included in any Headroom summarization payload
    - Verify extracted tail does not include boundary-or-earlier messages
    - _Requirements: 8.2_
  - [x] 12.4 Send compressible tail to Headroom proxy and replace on success
    - Replace corresponding messages with compressed result when byte savings > 0
    - _Requirements: 8.4_
  - [x] 12.5 Handle health probe failure → mark unreachable → proceed with original body
    - _Requirements: 8.5_
  - [ ]* 12.6 Write property test for Headroom hard skip before probing
    - **Property 13: Headroom Hard Skip Before Probing**
    - **Validates: Requirements 8.3**
  - [x]* 12.7 Write unit tests: empty tail skip, system-only tail skip (verify no probe issued)
    - _Requirements: 8.3_

- [x] 13. Caveman Terse-Prompt Injection
  - [x] 13.1 Implement Caveman prompt injection per target format family (OpenAI: prepend, Claude: content array)
    - Inject at position appropriate for Target_Format family
    - _Requirements: 9.1, 9.3_
  - [x] 13.2 Implement 3 discrete Caveman levels with varying intensity
    - _Requirements: 9.2_
  - [x] 13.3 Implement concatenation to existing system message when present
    - _Requirements: 9.4_
  - [x] 13.4 Record stats only when injection actually occurs (skip when no eligible injection point)
    - No stats entry when Caveman is configured but injection does not happen
    - _Requirements: 9.5_
  - [x] 13.5 Implement stats failure handling: log failure → proceed unconditionally (even if logging fails)
    - Caveman statistics must never interrupt the request path
    - _Requirements: 9.6_
  - [x]* 13.6 Write unit tests for Caveman statistics
    - Stats success does not stop request
    - Stats failure does not stop request
    - Stats logging failure does not stop request
    - Caveman stats not recorded when injection does not occur
    - _Requirements: 9.5, 9.6_

- [x] 14. Per-Connection Outbound Proxy
  - [x] 14.1 Implement per-connection proxy routing with explicit precedence (per-connection > env vars > Vercel relay > direct)
    - No request should have ambiguous proxy routing
    - Passthrough mode does NOT bypass outbound proxy routing
    - _Requirements: 10.1_
  - [x] 14.2 Implement environment variable proxy detection (HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, case-insensitive)
    - _Requirements: 10.2_
  - [x] 14.3 Implement strictProxy mode (fail fast vs fallback to direct)
    - _Requirements: 10.3_
  - [x] 14.4 Implement NO_PROXY pattern matching and bypass
    - _Requirements: 10.4_
  - [x] 14.5 Implement Vercel relay header forwarding (x-relay-target, x-relay-path)
    - _Requirements: 10.5_
  - [x]* 14.6 Write unit tests for proxy routing
    - Per-connection proxy overrides environment proxy
    - Environment proxy overrides relay/default behavior
    - Direct connection is used only after higher-precedence options do not apply
    - Passthrough still uses selected connection proxy settings
    - _Requirements: 10.1_
  - [ ]* 14.7 Write property test for outbound proxy precedence
    - **Property 15: Outbound Proxy Precedence**
    - **Validates: Requirements 10.1**

- [x] 15. MITM DNS Bypass
  - [x] 15.1 Implement external DNS resolution for bypass hosts (only when no outbound proxy configured)
    - _Requirements: 11.1_
  - [x] 15.2 Implement proxy-delegated DNS when outbound proxy is configured for bypass host
    - Route through outbound proxy; allow proxy to perform DNS resolution
    - Do not perform direct local DNS resolution first
    - _Requirements: 11.2_
  - [x] 15.3 Implement DNS result caching with configurable TTL
    - _Requirements: 11.3_
  - [x] 15.4 Implement hard failure on external DNS failure: NEVER fall back to system DNS for bypass hosts
    - Bypass hosts must avoid MITM/system resolver interference, even if that means failing closed
    - Passthrough mode does NOT bypass MITM bypass DNS rules
    - _Requirements: 11.4_
  - [x] 15.5 Implement guard: proxy DNS resolution requires an actual configured outbound proxy
    - If no outbound proxy configured, do not attempt proxy DNS resolution
    - _Requirements: 11.2_
  - [x]* 15.6 Write unit tests for DNS bypass
    - Bypass host uses external DNS
    - External DNS failure does not fall back to system DNS
    - Outbound proxy allows proxy-side DNS resolution
    - Proxy DNS resolution is not used when no outbound proxy exists
    - Passthrough does not bypass DNS integrity rules
    - _Requirements: 11.1, 11.2, 11.4_
  - [ ]* 15.7 Write property test for DNS bypass never falls back to system DNS
    - **Property 14: DNS Bypass Never Falls Back to System DNS**
    - **Validates: Requirements 11.4**

- [x] 16. Checkpoint - Ensure compression and network pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 17. Request and Usage Logging
  - [x] 17.1 Implement usage entry recording (provider, model, tokens, connection ID, timestamp)
    - Record zero token counts when usage metadata absent
    - _Requirements: 12.1, 12.6_
  - [x] 17.2 Implement in-flight request counting per provider/model/connection
    - Decrement on completion or error
    - _Requirements: 12.2_
  - [x] 17.3 Implement status log lines (PENDING → COMPLETED / FAILED)
    - _Requirements: 12.3_
  - [x] 17.4 Implement full request/response logging (when ENABLE_REQUEST_LOGS=true) for ALL requests regardless of success/failure
    - Write headers and body to separate files in request log directory
    - Log all requests without exception
    - _Requirements: 12.4, 12.5_
  - [x] 17.5 Implement partial result logging: write what was captured when request fails after partial completion
    - Mark log entry as failed/incomplete; do not make partial logs look successful
    - _Requirements: 12.5_
  - [x] 17.6 Implement passthrough logging: label as passthrough, preserve raw shape, redact secrets
    - Do not make passthrough logs look like translated requests
    - _Requirements: 12.4_
  - [x] 17.7 Implement log writer flush/close after each request
    - _Requirements: 12.7_
  - [x] 17.8 Handle log writer errors gracefully (no request disruption)
    - Failed and partial requests are often the most important logs
    - _Requirements: 12.8_
  - [x]* 17.9 Write unit tests for logging
    - Successful request is logged
    - Failed request is logged
    - Partially completed failed request is logged as failed/incomplete
    - Passthrough request is logged as passthrough
    - Logging failure does not break the request path
    - _Requirements: 12.4, 12.5, 12.8_

- [x] 18. API Key Authentication
  - [x] 18.1 Implement requireApiKey enforcement (reject missing auth with 401)
    - When requireApiKey=true: no bypass mechanism allowed; all requests MUST present valid key
    - _Requirements: 13.1, 13.8_
  - [x] 18.2 Implement API key validation against local store
    - _Requirements: 13.2_
  - [x] 18.3 Implement auth bypass when requireApiKey disabled AND no Authorization header present
    - No-auth bypass only applies when Authorization header is completely absent
    - Log that authentication was bypassed
    - _Requirements: 13.4_
  - [x] 18.4 Implement strict invalid-key rejection: ALWAYS reject invalid/expired Bearer tokens with 401 regardless of requireApiKey setting
    - Invalid credentials are never accepted
    - No-auth mode allows absence of credentials, not bad credentials
    - _Requirements: 13.7_
  - [x] 18.5 Implement active key check (exists, not revoked, not expired)
    - _Requirements: 13.5_
  - [x] 18.6 Implement auth logging (timestamp, path, authenticated status, key ID)
    - _Requirements: 13.6_
  - [ ]* 18.7 Write property test for invalid Bearer token always rejected
    - **Property 9: Invalid Bearer Token Always Rejected**
    - **Validates: Requirements 13.7**
  - [x]* 18.8 Write unit tests for auth behavior
    - Invalid Bearer rejected even when requireApiKey disabled
    - No header + requireApiKey disabled → accepted (bypass)
    - No header + requireApiKey enabled → rejected 401
    - _Requirements: 13.1, 13.4, 13.7_

- [x] 19. Compression Statistics Tracking
  - [x] 19.1 Implement SQLite schema for compression stats (id, timestamp, subsystem, bytes_before, bytes_after, filter_hits, level)
    - _Requirements: 14.2_
  - [x] 19.2 Implement stats persistence: write only when compression actually applied
    - A subsystem that is enabled but produced no change does NOT write a record
    - _Requirements: 14.1, 14.2_
  - [x] 19.3 Implement unconditional continuation on stats write failure (regardless of severity)
    - Statistics failures are never severe enough to stop the user request
    - _Requirements: 14.3_
  - [x] 19.4 Implement unconditional continuation even when logging the stats failure itself fails
    - _Requirements: 14.4_
  - [x]* 19.5 Write unit tests for statistics behavior
    - Stats success does not stop request
    - Stats failure does not stop request
    - Stats logging failure does not stop request
    - _Requirements: 14.3, 14.4_
  - [ ]* 19.6 Write property test for compression statistics conditional recording
    - **Property 7: Compression Statistics Conditional Recording**
    - **Validates: Requirements 7.12, 9.5, 9.6, 14.1, 14.3, 14.4**
  - [ ]* 19.7 Write property test for usage tracking on completion
    - **Property 8: Usage Tracking on Completion**
    - **Validates: Requirements 12.1**

- [x] 20. Build and Runtime Verification
  - [x] 20.1 Implement build verification: confirm compiled chunk contains expected critical fixes after rebuild
    - Verify Anthropic tool model-prefix fix in compiled output: `grep -R "model.slice.*indexOf.*+1" cli/app/.next-cli-build/server/chunks`
    - _Requirements: 1.6_
  - [x] 20.2 Document cache clearing requirement for `open-sse/` edits in build scripts or README
    - Clear `.next-cli-build/cache/webpack` (or entire `.next-cli-build`) before rebuilding
    - _Requirements: 1.6_
  - [x]* 20.3 Write build verification tests
    - Cache clearing documented for `open-sse/` edits
    - Compiled chunk contains expected critical fix
    - Global install path is a symlink during development
    - Headless server launches directly through `app/server.js`
    - _Requirements: 1.6_

- [x] 21. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation at logical boundaries
- Property tests validate universal correctness properties from the design document using `fast-check`
- Unit tests validate specific examples and edge cases from AGENTS.md Testing Requirements
- The implementation language is JavaScript (Node.js) matching the existing codebase in `open-sse/` and `cli/`
- Primary design rule: "Fail closed for correctness and security. Fail open for optional side effects."
- **HARD CORRECTNESS INVARIANT — Cache Boundary Preservation**: Content at or before the Cache_Boundary (last `cache_control` marker) is immutable. No compression subsystem (RTK, Headroom, Caveman) may modify it. Violation silently corrupts the provider's KV prompt cache, causing unpredictable model behavior that is extremely difficult to diagnose. This invariant must NEVER be weakened, made conditional, or bypassed for performance reasons.
- Secondary design rule: "Passthrough means passthrough. Do not mutate raw provider-compatible requests unless a security, routing, or explicitly required compatibility rule says so."
- Optional systems (stats, logs, telemetry) must never break the request path. If they fail: log if possible, continue. If logging fails, still continue.
- Clear webpack cache (`rm -rf .next-cli-build/cache/webpack`) before rebuilding the CLI after changes to `open-sse/`
- Auth: invalid Bearer tokens ALWAYS rejected with 401 regardless of requireApiKey; no-auth bypass only when NO Authorization header present
- Combo 4xx: Only apply 4xx combo behavior when model actually returns HTTP 4xx. Do NOT apply to 200, 5xx, network errors, or proxy-internal errors.
- Retry-After minimum: Never return Retry-After: 0 for a no-capacity state. Use minimum of 1.
- Passthrough: first-class behavior with explicit allowed/disallowed mutation lists; does NOT bypass proxy, DNS, auth, or logging
- Stats: record only when compression actually applied, not just when subsystem is enabled
- Proxy precedence: per-connection > env vars > Vercel relay > direct (explicit order)
- DNS bypass: only when no outbound proxy configured; never fall back to system DNS; passthrough does not bypass DNS rules
- Headroom: hard skip (no probe) when tail empty OR system-only
- Debugging Checklist: when runtime behavior does not match source: (1) confirm file is in the fork, (2) clear .next-cli-build, (3) rebuild, (4) confirm symlink, (5) launch server directly, (6) grep compiled chunks, (7) confirm translated vs passthrough path, (8) then debug application logic
- Default assumption: if source looks right but behavior is wrong, the running server is probably stale, not using the fork, or taking a passthrough path instead of a translated path

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "3.1", "19.1"] },
    { "id": 1, "tasks": ["1.2", "1.4", "2.2", "2.3", "3.2", "3.3", "3.4", "3.5"] },
    { "id": 2, "tasks": ["1.3", "1.5", "2.4", "2.5", "2.6", "2.7", "3.6", "4.1", "4.2"] },
    { "id": 3, "tasks": ["1.6", "1.7", "1.8", "2.8", "2.9", "4.3", "4.4", "4.5", "4.6"] },
    { "id": 4, "tasks": ["4.7", "4.8", "6.1", "6.2", "6.3", "6.4"] },
    { "id": 5, "tasks": ["6.5", "6.6", "6.7", "6.8", "6.9", "7.1", "7.2", "7.3"] },
    { "id": 6, "tasks": ["7.4", "7.5", "7.6", "7.7", "8.1", "8.2", "8.3"] },
    { "id": 7, "tasks": ["8.4", "8.5", "8.6", "8.7", "8.8", "9.1", "9.2", "9.3"] },
    { "id": 8, "tasks": ["9.4", "11.1", "11.2", "11.3", "11.4"] },
    { "id": 9, "tasks": ["11.5", "11.6", "11.7", "11.8", "11.9", "12.1", "12.2", "12.3"] },
    { "id": 10, "tasks": ["11.10", "11.11", "11.12", "12.4", "12.5", "12.6", "12.7"] },
    { "id": 11, "tasks": ["13.1", "13.2", "13.3", "13.4", "13.5", "13.6"] },
    { "id": 12, "tasks": ["14.1", "14.2", "14.3", "14.4", "14.5"] },
    { "id": 13, "tasks": ["14.6", "14.7", "15.1", "15.2", "15.3", "15.4", "15.5"] },
    { "id": 14, "tasks": ["15.6", "15.7", "17.1", "17.2", "17.3"] },
    { "id": 15, "tasks": ["17.4", "17.5", "17.6", "17.7", "17.8", "17.9"] },
    { "id": 16, "tasks": ["18.1", "18.2", "18.3", "18.4", "18.5", "18.6"] },
    { "id": 17, "tasks": ["18.7", "18.8", "19.2", "19.3", "19.4"] },
    { "id": 18, "tasks": ["19.5", "19.6", "19.7", "20.1", "20.2", "20.3"] }
  ]
}
```
