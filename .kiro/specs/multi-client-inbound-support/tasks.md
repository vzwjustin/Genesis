# Implementation Plan: Multi-Client Inbound Support

## Overview

This plan extends the existing 9router-fork (genesis) inbound contract so Kiro IDE and OpenCode clients can reach any configured upstream provider. The work is predominantly **extending existing code** (`src/sse/`, `open-sse/`, `src/app/api/v1/*`, `src/app/api/cli-tools/opencode-settings`), with one net-new route (`cli-tools/kiro-settings`), one new shared helper (`open-sse/config/wireType.js`), and new error helpers (`open-sse/utils/error.js`).

Tasks are incremental and test-driven. Each feature behavior change is paired with a property-based test (fast-check + vitest, ≥100 iterations) tagged `// Feature: multi-client-inbound-support, Property {n}` covering the 30 correctness properties in the design, plus targeted unit/example tests. Per AGENTS.md: fail closed for correctness/security, fail open for optional logging.

## Pre-Implementation

- [x] 1. Resolve open questions blocking dependent tasks
  - Confirm the **Kiro IDE config file path** (under `getCliHomeDir()`) and the exact **provider-block JSON schema** Kiro IDE reads — inspect a real Kiro IDE config or documented schema. Record findings in the spec; until confirmed, the Kiro writer (Task 11) mirrors the OpenCode shape (provider blocks keyed by name, `options.baseURL`/`options.apiKey`). Blocks Task 11.
  - Confirm the **`stream_assembly_failed` vs `sse_assembly_failed`** decision: the design assumes alias-only at the response boundary (keep internal `PROXY_INTERNAL_ERROR_CODES.SSE_ASSEMBLY_FAILED` + `502`, expose `error.type = "stream_assembly_failed"` to the client). Confirm no other caller depends on the client-facing type. Blocks Task 8.2.
  - Document both answers as decisions in `design.md` Open Questions before implementing the dependent pieces.
  - _Requirements: 4.1, 6.6_

## Tasks

- [ ] 2. Add shared wire-type classifier and error helpers (foundation)
  - [x] 2.1 Create `open-sse/config/wireType.js`
    - Export `getWireType(providerModelString, { family } = {})` returning `"anthropic" | "openai"`.
    - Anthropic prefixes: OpenCode/narrow family = `/^(cc\/|claude[-/])/i`; Kiro/broad family adds `kr/`, `kimi/`, `glm/`, `minimax/`. Accept a `family` arg to select the prefix set per caller; export the prefix sets so callers stay consistent.
    - No behavior change for existing OpenCode classification (same regex for the narrow family).
    - _Requirements: 1.4, 3.2, 3.3, 4.2, 4.3_

  - [ ]* 2.2 Write property test for wire-type classification
    - **Property 15 (wire-block assignment foundation): block assignment matches Wire_Type for any model mix**
    - **Validates: Requirements 3.2, 3.3, 4.2, 4.3**
    - Generators: arbitrary `Provider_Model_String` sets (openai/anthropic/mixed) for both narrow and broad families; assert `getWireType` partitions correctly.
    - fast-check + vitest, ≥100 iterations, tag `// Feature: multi-client-inbound-support, Property 15`.

  - [x] 2.3 Add `modelNotFoundResponse` and `noConnectionsResponse` to `open-sse/utils/error.js`
    - `modelNotFoundResponse(modelStr, availableModelIds)` → HTTP `404`, body `{ error: { type: "model_not_found", message, model, available_models } }`.
    - `noConnectionsResponse(providerAlias)` → HTTP `503`, body `{ error: { type: "no_active_connections", message, provider } }`.
    - Match existing `errorResponse`/`buildErrorBody` envelope conventions.
    - _Requirements: 1.2, 1.3_

  - [ ]* 2.4 Write unit tests for new error helpers
    - Assert exact status codes, `error.type`, and body fields for both helpers.
    - _Requirements: 1.2, 1.3_

- [x] 3. Implement model ID resolution failures (Req 1)
  - [x] 3.1 Add `listRegisteredModelIds()` and wire 404/503 into `handleSingleModelChat`
    - Add `listRegisteredModelIds()` built from `buildModelsList(['llm'])` so the "available models" list is consistent with `/v1/models`.
    - In `src/sse/handlers/chat.js`: replace the `if (!modelInfo.provider)` `400 validation_failed` branch with `return modelNotFoundResponse(modelStr, await listRegisteredModelIds())` (404).
    - Replace the existing zero-connections branch (`!isNoAuthProvider && maxRetries === 0`, detected via `resolveProviderRetryLimits`) `noActiveCredentialsResponse` with `noConnectionsResponse(alias)` (503).
    - Preserve registered-alias resolution via `getModelInfo`/`parseModel` (case-sensitive, first-`/` split); no new resolution logic.
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

  - [ ]* 3.2 Write property test: registered strings resolve to mapped provider
    - **Property 1: Registered model strings resolve to their mapped provider**
    - **Validates: Requirements 1.1**
    - Generator: alias ∈ `ALIAS_TO_PROVIDER_ID` keys × arbitrary non-empty `model_id`; oracle = `{ provider: ALIAS_TO_PROVIDER_ID[a], model }`.
    - fast-check + vitest, ≥100 iterations, tag `// Feature: multi-client-inbound-support, Property 1`.

  - [ ]* 3.3 Write property test: unknown model → 404 with available list
    - **Property 2: Unknown model strings fail closed with 404 and the available list**
    - **Validates: Requirements 1.2**
    - Generator: strings with non-registered prefix (not alias/combo/provider-node). Assert 404, `error.type = "model_not_found"`, `error.model === input`, `error.available_models === registry list`.
    - fast-check + vitest, ≥100 iterations, tag `// Feature: multi-client-inbound-support, Property 2`.

  - [ ]* 3.4 Write property test: resolution lookup is case-sensitive and exact
    - **Property 4: Resolution lookup is case-sensitive and exact**
    - **Validates: Requirements 1.4**
    - Generator: registered alias `a` + case mutation differing from `a`; assert mutated fails, exact resolves.
    - fast-check + vitest, ≥100 iterations, tag `// Feature: multi-client-inbound-support, Property 4`.

  - [ ]* 3.5 Write property test: zero connections → 503
    - **Property 5: Provider with zero connections fails closed with 503**
    - **Validates: Requirements 1.3**
    - Generator: registered provider with zero configured connections; assert 503, `error.type = "no_active_connections"`, `error.provider === alias`.
    - fast-check + vitest, ≥100 iterations, tag `// Feature: multi-client-inbound-support, Property 5`.

  - [ ]* 3.6 Write property test: upstream non-2xx surfaced verbatim
    - **Property 9: Upstream non-2xx is surfaced verbatim, not reclassified**
    - **Validates: Requirements 1.7**
    - Generator: arbitrary upstream non-2xx status+body after successful resolution; assert same status+body returned, not reclassified as resolution failure.
    - fast-check + vitest, ≥100 iterations, tag `// Feature: multi-client-inbound-support, Property 9`.

- [x] 4. Tighten inbound authentication contract (Req 2)
  - [x] 4.1 Emit `unauthorized` error type for auth rejections
    - In `src/sse/services/auth.js`: pass `{ errorType: "unauthorized" }` to `errorResponse(HTTP_STATUS.UNAUTHORIZED, ...)` for auth-rejection responses so the wire `error.type` is `unauthorized` (status unchanged).
    - Keep existing fail-closed behavior: DB-failure default `requireApiKey:true`; present-credential validation always enforced; no-header bypass only for verifiable loopback when `requireApiKey:false` (logged).
    - Confirm `src/sse/utils/routeAuth.js` (`requireRouteAuth`) and `handleChat` both delegate to the same `authenticateRequest` so all three paths are uniform — no per-path divergence.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_

  - [ ]* 4.2 Write property test: auth decision uniform across all paths
    - **Property 6: Authentication decision is uniform across all inbound paths**
    - **Validates: Requirements 2.7, 5.6, 5.7**
    - Generator: (Authorization header value, requireApiKey) × {`/v1/chat/completions`, `/v1/messages`, `/v1/models`}; assert identical accept/reject decision and status per path.
    - fast-check + vitest, ≥100 iterations, tag `// Feature: multi-client-inbound-support, Property 6`.

  - [ ]* 4.3 Write property test: valid keys accepted under both settings
    - **Property 7: Valid keys are accepted under both settings**
    - **Validates: Requirements 2.1, 2.5**
    - Generator: stored non-revoked key × `requireApiKey ∈ {true,false}`; assert accept.
    - fast-check + vitest, ≥100 iterations, tag `// Feature: multi-client-inbound-support, Property 7`.

  - [ ]* 4.4 Write property test: invalid/malformed credentials always rejected
    - **Property 8: Invalid or malformed credentials are always rejected**
    - **Validates: Requirements 2.3, 2.6**
    - Generator: malformed headers / non-matching bearer tokens × `requireApiKey ∈ {true,false}`; assert 401, `error.type = "unauthorized"`.
    - fast-check + vitest, ≥100 iterations, tag `// Feature: multi-client-inbound-support, Property 8`.

  - [ ]* 4.5 Write unit/example tests for auth edge cases
    - No-`Authorization`-header `401` when `requireApiKey=true` (Req 2.2); `requireApiKey=false` loopback bypass accepted + logged (Req 2.4).
    - _Requirements: 2.2, 2.4_

- [x] 5. Checkpoint - resolution + auth
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Confirm wire-type routing independent of inbound endpoint (Req 1.5/1.6)
  - [x] 6.1 Verify/adjust `handleChatCore` target-format computation
    - In `open-sse/handlers/chatCore.js`: confirm `targetFormat = getModelTargetFormat(alias, model) || getTargetFormat(provider)` is applied for both `/v1/chat/completions` and `/v1/messages` source detection (`detectFormat`/`detectFormatByEndpoint`). No new code expected; add a guard/assertion only if a gap is found.
    - _Requirements: 1.5, 1.6_

  - [ ]* 6.2 Write property test: wire-type determines translation path
    - **Property 3: Wire-type determines the translation path independent of inbound endpoint**
    - **Validates: Requirements 1.5, 1.6**
    - Generator: resolved `Provider_Model_String` (anthropic/openai-wire) × inbound endpoint ∈ {chat/completions, messages}; assert `targetFormat` is `"claude"` for anthropic-wire, `"openai"` for openai-wire, regardless of endpoint.
    - fast-check + vitest, ≥100 iterations, tag `// Feature: multi-client-inbound-support, Property 3`.

- [x] 7. Implement Anthropic built-in tool model-prefix fix + cross-wire translation (Req 6.1–6.4)
  - [x] 7.1 Apply built-in tool model-prefix strip in `claudeHelper.js`
    - In `open-sse/translator/helpers/claudeHelper.js` (`prepareClaudeRequest`/`cleanAnthropicToolDefinitions`, ~lines 196–208): client tools (`!type || type === "function"`) strip `model` + `type`; built-in tools preserve properties but strip provider prefix from `model` via `model.slice(model.indexOf("/") + 1)` when it includes `/`.
    - This is the only tool mutation allowed in passthrough (Req 6.4); prefixed built-in tool models must never reach Anthropic.
    - _Requirements: 6.4_

  - [x] 7.2 Confirm cross-wire translation + invalid-body fail-closed in `handleChatCore`
    - Confirm OpenAI→Anthropic and Anthropic→OpenAI translation via `translateRequest(sourceFormat, targetFormat, ...)`; thrown error or falsy/non-object result → `createErrorResult(400, ..., { errorType: "translation_invalid_body" })` and **no upstream forward**. Adjust only if a gap is found.
    - _Requirements: 6.1, 6.2, 6.3_

  - [ ]* 7.3 Write property test: cross-wire translation valid + no source-only fields
    - **Property 10: Cross-wire translation produces a valid target body that leaks no source-only fields**
    - **Validates: Requirements 6.1, 6.2**
    - Generator: OpenAI bodies → anthropic-wire model, and Anthropic bodies → openai-wire model; assert translated body validates against target schema and contains no source-exclusive field.
    - fast-check + vitest, ≥100 iterations, tag `// Feature: multi-client-inbound-support, Property 10`.

  - [ ]* 7.4 Write property test: schema-invalid translation fails closed
    - **Property 11: Schema-invalid translation fails closed without forwarding**
    - **Validates: Requirements 6.3**
    - Generator: translator-failing inputs; assert 400, `error.type = "translation_invalid_body"`, no upstream forward.
    - fast-check + vitest, ≥100 iterations, tag `// Feature: multi-client-inbound-support, Property 11`.

  - [ ]* 7.5 Write property test: same-wire passthrough mutates only built-in-tool model prefix
    - **Property 12: Same-wire passthrough mutates only the built-in-tool model prefix**
    - **Validates: Requirements 6.4**
    - Generator: same-wire bodies (incl. client + built-in tools); assert forwarded body byte-identical except provider-prefix strip on Anthropic built-in tool `model`; no other add/remove/rename.
    - fast-check + vitest, ≥100 iterations, tag `// Feature: multi-client-inbound-support, Property 12`.

  - [ ]* 7.6 Write unit tests for Anthropic tool cleaning (AGENTS.md list)
    - Client tools strip `model`+`type`; built-in tools preserve props; built-in `model` strips `cc/` etc.; prefixed built-in models never reach Anthropic; passthrough applies fix only when required.
    - _Requirements: 6.4_

- [x] 8. Confirm streaming + forced SSE→JSON assembly contract (Req 6.5/6.6)
  - [x] 8.1 Verify streaming re-serialization into inbound wire (Req 6.5)
    - Confirm `handleStreamingResponse` re-serializes upstream SSE into the inbound wire's stream format; a re-serialization failure terminates the stream with a terminal error event and emits no further data events. Adjust only if a gap is found.
    - _Requirements: 6.5_

  - [x] 8.2 Expose `stream_assembly_failed` client error type for forced assembly (Req 6.6)
    - In `handleForcedSSEToJson` (always-streaming providers, client `stream:false`): on assembly failure discard all partial data, return HTTP `502`. Expose client-facing `error.type = "stream_assembly_failed"` while keeping internal `PROXY_INTERNAL_ERROR_CODES.SSE_ASSEMBLY_FAILED` (alias-only per Task 1 decision).
    - _Requirements: 6.6_

  - [ ]* 8.3 Write property test: streaming re-serialized into inbound wire
    - **Property 13: Streaming responses are re-serialized into the inbound wire format**
    - **Validates: Requirements 6.5**
    - Generator: arbitrary SSE event sequences with injected malformed events; assert every emitted event well-formed in inbound wire, malformed → terminal error event + no further data.
    - fast-check + vitest, ≥100 iterations, tag `// Feature: multi-client-inbound-support, Property 13`.

  - [ ]* 8.4 Write property test: forced assembly yields complete JSON or 502
    - **Property 14: Forced SSE→JSON assembly yields complete JSON or fails closed**
    - **Validates: Requirements 6.6**
    - Generator: complete vs truncated/malformed SSE streams to non-streaming client; assert complete → single valid JSON; truncated → 502 `stream_assembly_failed`, no partial JSON.
    - fast-check + vitest, ≥100 iterations, tag `// Feature: multi-client-inbound-support, Property 14`.

- [x] 9. Checkpoint - wire translation + streaming
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Extend OpenCode config-writer (Req 3)
  - [x] 10.1 Add POST validation and delegate wire classification
    - In `src/app/api/cli-tools/opencode-settings/route.js`: add explicit POST validation — `baseUrl` must be HTTP/HTTPS with no trailing slash, `models` non-empty array of strings, `apiKey` present/non-empty. On failure return `400` `{ error: { fields: [...] } }` and **do not write** the file.
    - Refactor local `isClaudeWireModel` to delegate to `getWireType(..., { family: "narrow" })` (same regex, no behavior change).
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.8_

  - [x] 10.2 Fix GET-not-exist shape and PATCH-not-exist status
    - GET when file absent → `{ diagnostics: { fileExists: false, misconfigured: false } }` (keep richer fields additively). When present, diagnostics report `misconfigured`/`expectedNpm`/`expectedBaseURL` via `diagnoseGenesisOpenCodeConfig`.
    - PATCH `{ repairClaudeWire: true }` when file absent → `404`; when present run `repairGenesisProviderSplit` preserving all model entries.
    - _Requirements: 3.6, 3.7_

  - [ ]* 10.3 Write property test: writers assign each model to correct wire block
    - **Property 15: Config writers assign each model to the correct wire block**
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 4.1, 4.2, 4.3, 4.4**
    - Generator: non-empty `Provider_Model_String` sets (openai/anthropic/mixed); assert anthropic→`@ai-sdk/anthropic` `baseURL={baseUrl}` (no `/v1`), openai→openai-compatible `baseURL={baseUrl}/v1`, shared `apiKey`, config has `provider` object + `model` field.
    - fast-check + vitest, ≥100 iterations, tag `// Feature: multi-client-inbound-support, Property 15`.

  - [ ]* 10.4 Write property test: active model prefix matches first model's wire
    - **Property 16: The active model prefix matches the first model's wire type**
    - **Validates: Requirements 3.5**
    - fast-check + vitest, ≥100 iterations, tag `// Feature: multi-client-inbound-support, Property 16`.

  - [ ]* 10.5 Write property test: invalid input fails closed, no write
    - **Property 17: Invalid config-writer input fails closed with field-level 400 and no write**
    - **Validates: Requirements 3.8, 4.5**
    - Generator: missing/non-HTTP(S) `baseUrl`, empty `models`, absent `apiKey`; assert 400 with field list, no file written.
    - fast-check + vitest, ≥100 iterations, tag `// Feature: multi-client-inbound-support, Property 17`.

  - [ ]* 10.6 Write property test: repair preserves full model set
    - **Property 18: Wire repair preserves the full model set**
    - **Validates: Requirements 3.7**
    - fast-check + vitest, ≥100 iterations, tag `// Feature: multi-client-inbound-support, Property 18`.

  - [ ]* 10.7 Write property test: misconfiguration diagnosis correct
    - **Property 19: Misconfiguration diagnosis is correct over arbitrary configs**
    - **Validates: Requirements 3.6**
    - fast-check + vitest, ≥100 iterations, tag `// Feature: multi-client-inbound-support, Property 19`.

  - [ ]* 10.8 Write unit tests for GET-absent and PATCH-absent
    - GET `fileExists:false` shape; PATCH `404` when file absent.
    - _Requirements: 3.6, 3.7_

- [x] 11. Create Kiro IDE config-writer route (Req 4) — NEW
  - [x] 11.1 Implement `src/app/api/cli-tools/kiro-settings/route.js`
    - Depends on Task 1 (confirmed Kiro path + schema). Model on the OpenCode writer and existing `cli-tools/*-settings` conventions (`requireSpawnRouteAuth`, `getCliHomeDir()`, `fs/promises`).
    - POST: split via `getWireType(..., { family: "broad" })` — Claude-compatible (`cc/`, `kr/`, `kimi/`, `glm/`, `minimax/`) → Anthropic-compatible block `baseURL={baseUrl}` (no `/v1`); OpenAI-compatible (`cx/`, `gc/`, `gh/`, `openai/`, `deepseek/`) → OpenAI-compatible block `baseURL={baseUrl}/v1`; mixed → separate blocks, same `apiKey`. Write the Kiro config file.
    - POST validation (Req 4.1/4.5): valid HTTP/HTTPS `baseUrl`, non-empty `models`, non-empty `apiKey`, else `400` with offending fields and no write.
    - GET (Req 4.6): `{ exists: false }` when absent; `{ exists: true, wireType: "anthropic"|"openai"|"mixed" }` when a genesis block is present.
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

  - [ ]* 11.2 Write property test: Kiro GET wireType consistent with stored models
    - **Property 20: Config GET reports wire type consistent with stored models**
    - **Validates: Requirements 4.6**
    - Generator: present Kiro configs (all-claude / all-openai / mixed); assert `wireType` = `anthropic`/`openai`/`mixed` accordingly.
    - fast-check + vitest, ≥100 iterations, tag `// Feature: multi-client-inbound-support, Property 20`.
    - (Note: Property 15 in Task 10.3 also covers Kiro block assignment Req 4.1–4.4; Property 17 in Task 10.5 covers Kiro invalid-input Req 4.5.)

  - [ ]* 11.3 Write unit test for Kiro GET-absent
    - GET when file absent → `{ exists: false }`.
    - _Requirements: 4.6_

- [x] 12. Checkpoint - config writers
  - Ensure all tests pass, ask the user if questions arise.

- [x] 13. Extend model enumeration `/v1/models` + `buildModelsList` (Req 5)
  - [x] 13.1 Add Claude-family variants, warnings array, and requires_auth flag
    - In `src/app/api/v1/models/route.js` (`buildModelsList`): for Claude-family aliases (`cc`, `kr`, `kimi`, `glm`, `minimax`, gated by `getWireType==="anthropic"` + family membership), after dynamic discovery also emit `${id}-thinking` and `${id}-agentic` entries (Req 5.2).
    - Thread a top-level `warnings` array through `buildModelsList`: on `LIVE_MODEL_RESOLVERS` discovery failure push `{ provider, reason }` and still include the static catalog (Req 5.3). GET response = `{ object:"list", data, ...(warnings.length ? { warnings } : {}) }`.
    - Tag each model object with `requires_auth: true` when its connection entry has no active access token (Req 5.5).
    - Preserve: per-provider active-connection iteration (Req 5.1), `id = ${alias}/${modelId}` (Req 5.4), `requireRouteAuth` (Req 5.6/5.7).
    - Extend return contract to `{ models, warnings }`.
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [ ]* 13.2 Write property test: enumeration includes every connected provider
    - **Property 21: Model enumeration includes every connected provider**
    - **Validates: Requirements 5.1**
    - Generator: arbitrary active connection sets (with/without tokens); assert ≥1 entry per provider with ≥1 connection regardless of token validity.
    - fast-check + vitest, ≥100 iterations, tag `// Feature: multi-client-inbound-support, Property 21`.

  - [ ]* 13.3 Write property test: Claude-family includes thinking/agentic variants
    - **Property 22: Claude-family discovery includes thinking and agentic variants**
    - **Validates: Requirements 5.2**
    - fast-check + vitest, ≥100 iterations, tag `// Feature: multi-client-inbound-support, Property 22`.

  - [ ]* 13.4 Write property test: discovery failure → static fallback + warning
    - **Property 23: Discovery failure falls back to the static catalog with a warning**
    - **Validates: Requirements 5.3**
    - Generator: providers with a mocked throwing discovery resolver; assert static catalog still present + `warnings` entry `{ provider, reason }`, never omitted.
    - fast-check + vitest, ≥100 iterations, tag `// Feature: multi-client-inbound-support, Property 23`.

  - [ ]* 13.5 Write property test: every id is a full Provider_Model_String
    - **Property 24: Every enumerated model id is a full Provider_Model_String**
    - **Validates: Requirements 5.4**
    - fast-check + vitest, ≥100 iterations, tag `// Feature: multi-client-inbound-support, Property 24`.

  - [ ]* 13.6 Write property test: tokenless connections flagged requires_auth
    - **Property 25: Tokenless connections expose static models flagged requires_auth**
    - **Validates: Requirements 5.5**
    - fast-check + vitest, ≥100 iterations, tag `// Feature: multi-client-inbound-support, Property 25`.

- [x] 14. Add structured inbound request logging (Req 7) — fail open
  - [x] 14.1 Add `logInboundSummary` and emit from `handleChat`
    - In `open-sse/utils/requestLogger.js`: export `logInboundSummary({ inboundWire, rawModel, resolvedModel, status, authFailureReason, unresolvedModel, registeredModels })` — never throws (wrap with the existing `safeWrite` swallow pattern; route fields through `redactSensitiveText`/`maskSensitiveHeaders`/`sanitizeLogValue`).
    - Emit a single completion summary from `src/sse/handlers/chat.js` on success or error containing exactly: `inboundWire`, `rawModel`, `resolvedProviderModelString | null`, `status` (Req 7.1).
    - On resolution failure include `unresolvedModel` + full registered `Provider_Model_String` set (Req 7.2). On auth failure include `reason ∈ {missing_header, invalid_key, malformed_header}` and never the key/raw Authorization value (Req 7.3).
    - Gate on `ENABLE_REQUEST_LOGS`; no-op logger when disabled. Any logging error swallowed; request proceeds (Req 7.4).
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [ ]* 14.2 Write property test: completed requests logged with required fields
    - **Property 26: Completed requests are logged with the required fields**
    - **Validates: Requirements 7.1**
    - Generator: request outcomes (success/error, resolved/unresolved); assert fields present and `resolved` is `null` exactly when resolution failed.
    - fast-check + vitest, ≥100 iterations, tag `// Feature: multi-client-inbound-support, Property 26`.

  - [ ]* 14.3 Write property test: resolution-failure logs include unresolved + registry
    - **Property 27: Resolution-failure logs include the unresolved string and the registry set**
    - **Validates: Requirements 7.2**
    - fast-check + vitest, ≥100 iterations, tag `// Feature: multi-client-inbound-support, Property 27`.

  - [ ]* 14.4 Write property test: auth-failure logs classify reason without leaking
    - **Property 28: Auth-failure logs classify the reason without leaking credentials**
    - **Validates: Requirements 7.3**
    - Generator: auth-failing requests; assert reason ∈ set and serialized entry contains neither key value nor raw Authorization value.
    - fast-check + vitest, ≥100 iterations, tag `// Feature: multi-client-inbound-support, Property 28`.

  - [ ]* 14.5 Write property test: logging never breaks the request path
    - **Property 29: Logging never breaks the request path**
    - **Validates: Requirements 7.4**
    - Generator: throwing log sink; assert client response identical to logging-disabled response and request completes.
    - fast-check + vitest, ≥100 iterations, tag `// Feature: multi-client-inbound-support, Property 29`.

  - [ ]* 14.6 Write property test: secrets redacted before serialization
    - **Property 30: Secrets are redacted before serialization**
    - **Validates: Requirements 7.5**
    - Generator: entries with embedded Authorization/api key/bearer token secrets; assert each replaced with `[REDACTED]` and no occurrence of the original secret.
    - fast-check + vitest, ≥100 iterations, tag `// Feature: multi-client-inbound-support, Property 30`.

- [x] 15. Checkpoint - enumeration + logging
  - Ensure all tests pass, ask the user if questions arise.

- [x] 16. Build verification and compiled-bundle checks (AGENTS.md — non-negotiable)
  - [x] 16.1 Clear webpack cache and rebuild the CLI
    - Run the canonical rebuild (cache clear is mandatory before every rebuild):
      `rm -rf .next-cli-build && (cd cli && npm run build)`
    - Do not trust a rebuild unless the cache was cleared first.
    - _Requirements: 6.4_

  - [x] 16.2 Verify the Anthropic built-in-tool fix in the compiled bundle
    - Grep the compiled chunks (chunk filenames vary between builds):
      `grep -R "model.slice.*indexOf.*+1" cli/app/.next-cli-build/server/chunks`
      (or `grep -R 'indexOf("/")+1' cli/app/.next-cli-build/server/chunks`, or `bash scripts/verify-compiled-anthropic-fix.sh`).
    - If the grep does not find the fix, the running server is not using the intended source — clear cache and rebuild again.
    - _Requirements: 6.4_

- [x] 17. Run full suite + lint
  - [x] 17.1 Run unit/property suite and backend lint
    - `npm test` (vitest run --config tests/vitest.config.js) from repo root; `npm run lint:backend`.
    - Confirm all property tests (≥100 iterations each) and unit tests pass.
    - _Requirements: 1.1, 2.1, 3.1, 4.1, 5.1, 6.1, 7.1_

  - [ ]* 17.2 Smoke + integration checks
    - Build/start in production mode (`npm run dev` has a known `better-sqlite3` bundling issue); `GET /api/health` → `{"ok":true}`; AGENTS.md hello-world `/v1/models` with `Authorization: Bearer <key>`. In headless/non-TTY use `node cli/app/server.js`, not the `genesis` wrapper; confirm global install is a symlink to the fork before runtime debugging.
    - One small integration test for live Kiro `ListAvailableModels` discovery (external service; not 100 iterations).
    - _Requirements: 5.1, 5.2, 5.6_

- [x] 18. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional (tests) and can be skipped for a faster MVP; core implementation tasks are never optional.
- Each task references specific requirements/properties for traceability.
- Property tests use fast-check + vitest, ≥100 iterations each, tagged `// Feature: multi-client-inbound-support, Property {n}` — covering all 30 design properties.
- Work predominantly extends existing code; the only net-new surface is `cli-tools/kiro-settings/route.js`, `open-sse/config/wireType.js`, and the new error helpers in `open-sse/utils/error.js`.
- Build verification (cache-clear-before-rebuild + compiled-bundle grep) is mandatory per AGENTS.md after touching `open-sse/`/route code.
- Fail closed for correctness/security (resolution, auth, translation, stream-assembly); fail open for request logging.
- Task 1 resolves the two design open questions and blocks Tasks 11 (Kiro path/schema) and 8.2 (stream_assembly_failed naming).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1"] },
    { "id": 1, "tasks": ["2.1", "2.3"] },
    { "id": 2, "tasks": ["2.2", "2.4", "3.1", "6.1", "7.1", "8.1"] },
    { "id": 3, "tasks": ["3.2", "3.3", "3.4", "3.5", "3.6", "4.1", "6.2", "7.2", "8.2"] },
    { "id": 4, "tasks": ["4.2", "4.3", "4.4", "4.5", "7.3", "7.4", "7.5", "7.6", "8.3", "8.4", "10.1", "11.1", "13.1", "14.1"] },
    { "id": 5, "tasks": ["10.2", "11.2", "11.3", "13.2", "13.3", "13.4", "13.5", "13.6", "14.2", "14.3", "14.4", "14.5", "14.6"] },
    { "id": 6, "tasks": ["10.3", "10.4", "10.5", "10.6", "10.7", "10.8"] },
    { "id": 7, "tasks": ["16.1"] },
    { "id": 8, "tasks": ["16.2", "17.1"] },
    { "id": 9, "tasks": ["17.2"] }
  ]
}
```
