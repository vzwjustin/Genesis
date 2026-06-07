# Requirements Document

## Introduction

This feature specifies the compression and routing proxy capabilities of 9Router — a local AI gateway that sits between developer clients (CLIs, IDEs, extensions) and upstream AI provider APIs. The proxy translates between formats (OpenAI, Claude, Gemini, Cursor, Kiro, etc.), compresses request payloads to reduce token usage and latency, and routes traffic across providers with fallback, retry, and per-account cooldown logic.

The two core subsystems are:

1. **Routing Proxy**: Accepts OpenAI-compatible and Claude-compatible requests from any client tool, resolves the target provider and model, translates the request and response format, handles account selection and fallback, and streams the response back to the client.
2. **Compression Pipeline**: Reduces token consumption by compressing tool-call results and large conversation history before dispatch — without mutating any content protected by the provider's KV prompt cache. Cache boundary preservation is a **hard correctness invariant**: violating it silently corrupts the provider's prompt cache, causing incorrect model behavior that is extremely difficult to diagnose.

---

## Glossary

- **Proxy**: The 9Router local server process that intermediates between AI clients and upstream providers.
- **Client**: Any AI-consuming tool that speaks OpenAI-compatible or Claude-compatible HTTP (Claude Code, Codex CLI, Cursor, Kiro IDE, Cline, Continue, custom SDKs, etc.).
- **Provider**: An upstream AI service (Anthropic, OpenAI, Gemini, Kiro, Cursor, GitHub Copilot, etc.).
- **Connection**: A configured credential record for a provider account (API key or OAuth token pair) stored in the local DB.
- **Combo**: A named ordered list of provider/model strings used for fallback sequencing.
- **Model_String**: A string in the form `provider/model`, a registered alias, or a combo name.
- **Source_Format**: The wire format of the incoming client request (e.g. `openai`, `claude`, `openai-responses`, `gemini`).
- **Target_Format**: The wire format required by the upstream provider (e.g. `openai`, `claude`, `gemini-cli`, `cursor`, `kiro`).
- **Translator**: The module that converts a request body from Source_Format to Target_Format, and the response back.
- **RTK**: The Rule-based Token-reduction Kit — compresses tool result content in-place using format-aware filters before dispatch.
- **Headroom**: An optional ML-based compression proxy that summarises older conversation turns to reduce context size.
- **Caveman**: An optional system-prompt injection that instructs the model to reply tersely.
- **Passthrough**: A mode where source and target formats are the same ecosystem; translation is skipped and only the model name and auth header are substituted.
- **Cache_Boundary**: The index of the last message carrying a `cache_control` marker; content at or before this index MUST NOT be modified under any circumstances. This is a **hard correctness invariant** — violating the cache boundary silently corrupts the provider's KV prompt cache, causing unpredictable model behavior that is extremely difficult to diagnose. All compression subsystems (RTK, Headroom, Caveman) MUST treat content at or before this index as immutable.
- **Executor**: A provider-specific module responsible for constructing and sending the upstream HTTP request and handling streaming/binary response protocols.
- **Account_Fallback**: The mechanism that marks a Connection as temporarily unavailable and retries with the next available Connection for the same provider.
- **Cooldown**: A time window during which a Connection is excluded from account selection after a rate-limit or transient error.

---

## Requirements

### Requirement 1: Format-Aware Request Translation

**User Story:** As a client developer, I want to point any OpenAI-compatible or Claude-compatible tool at 9Router and have it work transparently, so that I do not need to rewrite or reconfigure my client for each provider.

#### Acceptance Criteria

1. WHEN a request arrives at an endpoint, THE Proxy SHALL detect the Source_Format by checking, in order: request header presence, request body schema, then heuristics (header → body field → heuristic).
2. WHERE Passthrough conditions are met (Source_Format and Target_Format are the same concrete provider family grouping AND the client tool identity matches the provider ecosystem), THE Proxy SHALL apply Passthrough mode AND SHALL NOT invoke format translation.
3. WHERE Passthrough conditions are NOT met, THE Translator SHALL convert the request body from Source_Format to Target_Format before dispatch.
4. IF any failure prevents successful request processing (format detection failure, translation failure, model resolution failure, request schema violation, or any other pre-dispatch validation failure), THEN THE Proxy SHALL return HTTP 400 with a descriptive error.
5. THE Translator SHALL convert provider responses from Target_Format back to Source_Format.
6. WHEN a client sends built-in tool definitions that include a provider-prefixed `model` field, THE Proxy SHALL strip the provider prefix ONLY when the tool's `type` property is present AND not equal to `"function"`.

---

### Requirement 2: Model and Alias Resolution

**User Story:** As an operator, I want to configure short aliases and combo names for models, so that clients can use stable identifiers that route to the correct provider without knowing provider-specific model names.

#### Acceptance Criteria

1. WHEN a Model_String in the form `provider/model` is received, THE Proxy SHALL resolve the provider and model directly without alias lookup.
2. WHEN a Model_String does not contain `/`, THE Proxy SHALL look up the string in the model alias registry and resolve it to a `provider/model` pair.
3. WHEN a Model_String matches a registered Combo name, THE Proxy SHALL expand it into the ordered list of provider/model strings defined in the Combo.
4. IF Model_String resolution ultimately fails to produce a valid provider and model (after checking all resolution methods), THEN THE Proxy SHALL return HTTP 400 with a descriptive error message.
5. THE Proxy SHALL log the resolved routing path (original Model_String → resolved `provider/model`) for every request.

---

### Requirement 3: Provider Credential Selection

**User Story:** As an operator, I want 9Router to automatically select an available credential for the target provider, so that requests succeed even when individual accounts are rate-limited or temporarily unavailable.

#### Acceptance Criteria

1. WHEN a provider is resolved for a request, THE Proxy SHALL select an active Connection for that provider that is not currently in Cooldown.
2. WHEN multiple active Connections exist for a provider, THE Proxy SHALL select among them according to the configured priority and sticky round-robin limit.
3. IF no active Connection with valid credentials exists for a provider (including the case where all Connections exist but none have valid credentials due to failed token refresh), THEN THE Proxy SHALL return HTTP 404 with the message "No active credentials for provider: {provider}".
4. IF all Connections for a provider are in Cooldown, THEN THE Proxy SHALL wait until the earliest Cooldown reset time AND retry; THE Proxy SHALL enforce a minimum retry delay of 1 second regardless of calculated Cooldown reset times.
5. WHEN a pre-check detects that an OAuth access token is within 5 minutes of expiry, THE Proxy SHALL refresh the token before dispatching the request.
6. IF the token refresh fails during pre-check, THEN THE Proxy SHALL mark the Connection as unusable AND proceed to Account_Fallback for the next available Connection.

---

### Requirement 4: Account Fallback on Error

**User Story:** As an operator, I want 9Router to automatically switch to another credential when an account hits a rate limit or returns a transient error, so that requests continue to succeed without manual intervention.

#### Acceptance Criteria

1. WHEN the upstream provider returns HTTP 429, THE Proxy SHALL place the current Connection into Cooldown with exponential backoff (starting at 1s, doubling per consecutive failure) AND retry with the next available Connection.
2. WHEN the upstream provider returns HTTP 5xx, THE Proxy SHALL place the current Connection into Cooldown with a transient Cooldown duration of 30s.
3. WHEN the upstream provider returns HTTP 401 or 403 and token refresh fails, THE Proxy SHALL trigger immediate Account_Fallback rather than entering Cooldown.
4. WHEN the upstream provider returns HTTP 2xx, THE Proxy SHALL reset the Cooldown AND backoff level for that Connection.
5. IF all Connections for the provider have been exhausted AND at least one returned 5xx, THEN THE Proxy SHALL return HTTP 503 with the last upstream error message.
6. A Connection is considered "exhausted" for a request when it is in Cooldown OR has returned an error for this request.
7. THE Proxy SHALL retry at most N times per request, where N equals the number of configured Connections for the provider; IF a provider has zero configured Connections, THE Proxy SHALL perform zero retries.
8. IF a provider has zero configured Connections, THEN THE Proxy SHALL immediately return HTTP 404 with the message "No active credentials for provider: {provider}" without attempting dispatch or any retries.

---

### Requirement 5: Combo Fallback Sequencing

**User Story:** As an operator, I want to define ordered fallback sequences of models across providers, so that if one model or provider is unavailable the request automatically moves to the next option.

#### Acceptance Criteria

1. WHEN a request targets a Combo, THE Proxy SHALL advance through the Combo's ordered list in response to upstream errors and failures, retrying with the next model until success or exhaustion; THE Proxy SHALL NOT advance the Combo position for requests that do not target a Combo.
2. WHEN a model in the Combo returns HTTP 200, THE Proxy SHALL return the response to the Client AND SHALL NOT advance the Combo position.
3. WHEN a model in the Combo returns HTTP 4xx, THE Proxy SHALL return the response to the Client AND SHALL NOT advance the Combo position.
4. WHEN a model in the Combo returns HTTP 429, THE Proxy SHALL advance the Combo position to the next model AND treat the failed Connection according to Cooldown rules.
5. WHEN a model in the Combo returns HTTP 5xx, THE Proxy SHALL advance the Combo position to the next model AND place the failed Connection into transient Cooldown.
6. IF all models in the Combo have been attempted AND all returned 5xx, THEN THE Proxy SHALL return HTTP 503 with the last error message.

---

### Requirement 6: Streaming and Non-Streaming Response Handling

**User Story:** As a client developer, I want 9Router to faithfully relay streaming and non-streaming responses in the format my client expects, so that real-time token delivery and final JSON responses both work correctly.

#### Acceptance Criteria

1. WHEN a client requests streaming (`stream: true`) or uses a streaming-native format (Gemini, Antigravity), THE Proxy SHALL relay the upstream SSE stream to the client in the Source_Format.
2. WHEN a client requests a non-streaming response and the provider also returns non-streaming JSON, THE Proxy SHALL return the translated response as `application/json`.
3. WHEN a provider always streams (OpenAI, Codex) but the client has not requested streaming, THE Proxy SHALL collect and assemble the full SSE stream into a single JSON response, set the response `Content-Type` to `application/json`, and return the assembled response to the client.
4. WHEN the client `Accept` header contains `application/json` and does not contain `text/event-stream` and the request does not set `stream: true`, THE Proxy SHALL return a non-streaming JSON response.
5. WHEN the client disconnects before the upstream response completes, THE Proxy SHALL abort the upstream request and release all associated resources.
6. IF SSE stream assembly fails partway through due to malformed or incomplete data, THEN THE Proxy SHALL discard all partially assembled data AND return an error response to the client; partial JSON MUST NEVER be returned to non-streaming clients.

---

### Requirement 7: RTK Tool-Result Compression

**User Story:** As an operator, I want 9Router to compress verbose tool-call results in LLM message histories before dispatching, so that prompt token usage and cost are reduced for long agentic sessions.

#### Acceptance Criteria

1. WHEN RTK is enabled in settings, THE RTK SHALL apply content-aware filters to tool result content in the request body before translation and dispatch.
2. THE RTK SHALL support tool result shapes for all Source_Formats: OpenAI tool messages (`role: "tool"`), Claude `tool_result` content blocks, OpenAI Responses `function_call_output` items, and Kiro `toolResults` arrays.
3. WHEN a `cache_control` marker exists in the message array, THE RTK SHALL NOT modify any message at or before the Cache_Boundary index; content after the Cache_Boundary is eligible for compression. This is a **hard correctness invariant** — violation silently corrupts the provider's KV prompt cache. THE RTK SHALL verify cache boundary integrity before and after compression: if any message at or before the boundary has been modified, THE RTK SHALL abort compression and log a critical error.
4. WHEN NO `cache_control` marker exists in the message array, THE RTK SHALL consider ALL messages eligible for compression.
5. WHEN a tool result content blob is smaller than 500 bytes or larger than 10 MiB, THE RTK SHALL skip compression for that blob.
6. THE RTK SHALL attempt to auto-detect the content type of each blob (git diff, git status, grep output, build output, file tree, ls output, numbered file dump, log deduplication, smart truncation).
7. WHEN content type detection succeeds with a named type, THE RTK SHALL apply the matching filter.
8. WHEN content type detection fails to match a named type, THE RTK SHALL apply smart truncation as the fallback.
9. WHEN a named filter would produce output equal to or larger than the input, THE RTK SHALL attempt smart truncation as a secondary fallback; IF smart truncation also produces output equal to or larger than the input, THE RTK SHALL retain the original unmodified content.
10. WHERE content type detection succeeds with a named type, IF smart truncation would produce smaller output than the named filter, THEN THE RTK SHALL use smart truncation instead of the named filter.
11. IF RTK encounters an internal error during compression, THEN THE RTK SHALL log the error AND continue with the original unmodified content; IF logging the error itself fails, THEN THE RTK SHALL continue with the original unmodified content without further logging attempts.
12. THE Proxy SHALL record compression statistics (bytes before, bytes after, filter hits) per request to the compression stats store.

---

### Requirement 8: Headroom ML Compression

**User Story:** As an operator with very long conversations, I want 9Router to use ML-based summarisation to compress older conversation turns, so that I can stay within model context windows without manually truncating history.

#### Acceptance Criteria

1. WHERE Headroom is installed AND the Headroom proxy service is reachable, WHEN Headroom is enabled in settings, THE Proxy SHALL send the compressible tail of the conversation to the Headroom proxy for summarisation before dispatch.
2. THE Proxy SHALL NOT send content at or before the Cache_Boundary to the Headroom proxy; only content after the Cache_Boundary SHALL be subject to Headroom compression. This is a **hard correctness invariant** — cache boundary content is immutable and MUST NOT be included in any summarization payload.
3. WHEN content after the Cache_Boundary is empty OR consists entirely of system messages, THE Proxy SHALL skip Headroom compression regardless of potential byte savings.
4. WHEN the Headroom proxy returns a non-empty result with byte savings greater than 0, THE Proxy SHALL replace the corresponding messages with the compressed result.
5. WHERE the Headroom proxy health endpoint fails (timeout, non-2xx, or network error) AND the last known state was "reachable", THE Proxy SHALL mark the Headroom proxy as unreachable AND proceed with the original body.
6. THE Proxy SHALL probe the Headroom proxy health endpoint at most once every 30 seconds AND cache the reachability result.

---

### Requirement 9: Caveman Terse-Prompt Injection

**User Story:** As an operator, I want to reduce response verbosity by injecting a brevity system prompt, so that models reply concisely and token usage on completions is reduced.

#### Acceptance Criteria

1. WHERE Caveman is enabled in settings AND a Caveman level is configured, THE Proxy SHALL inject a terse-style system prompt into the translated request body before dispatch.
2. THE Proxy SHALL support 3 discrete Caveman levels that control the intensity of the brevity instruction.
3. THE Proxy SHALL inject the system prompt at the position appropriate for the Target_Format family (e.g., prepend to existing system messages for OpenAI-compatible, prepend to content array for Claude-compatible).
4. WHERE the request already contains a system message AND Caveman is configured to prepend, THE Proxy SHALL concatenate the Caveman prompt to the existing system message content.
5. THE Proxy SHALL record a compression statistics entry for each request where Caveman injection is actually applied; THE Proxy SHALL NOT record a statistics entry when Caveman is configured but no injection occurs.
6. IF recording a Caveman compression statistics entry fails, THEN THE Proxy SHALL log the failure AND allow the request to proceed without interruption; requests SHALL proceed in all cases where Caveman injection occurs, regardless of statistics outcome; IF logging the statistics failure itself fails, THEN THE Proxy SHALL proceed with the request without further logging attempts.

---

### Requirement 10: Per-Connection Outbound Proxy

**User Story:** As an operator in a network-restricted environment, I want to route upstream provider calls through a per-connection HTTP/SOCKS proxy, so that I can reach providers behind corporate firewalls or via relay infrastructure.

#### Acceptance Criteria

1. WHERE a Connection has outbound proxy enabled and a proxy URL configured, THE Proxy SHALL route all upstream requests for that Connection through the specified proxy URL; per-connection proxy configuration SHALL take precedence over environment variable proxy settings AND over Vercel relay configuration. THE Proxy SHALL apply outbound proxy precedence in the following explicit order: per-connection proxy (highest) > environment variables (`HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`) > Vercel relay (lowest).
2. WHERE environment variables `HTTP_PROXY`, `HTTPS_PROXY`, or `ALL_PROXY` are set (case-insensitive) AND no per-connection proxy is configured, THE Proxy SHALL use them as the outbound proxy for upstream requests.
3. WHEN the outbound proxy is unreachable (connection timeout, connection refused, or DNS resolution failure for the proxy host), THE Proxy SHALL fail fast if `strictProxy` is enabled OR fall back to a direct connection to the target host if `strictProxy` is not enabled.
4. WHERE `NO_PROXY` (or `no_proxy`) is set AND the target host matches a pattern in the list, THE Proxy SHALL bypass the outbound proxy for that host.
5. WHERE a Connection has a Vercel relay URL configured AND no per-connection proxy is configured, THE Proxy SHALL forward upstream requests by setting relay headers (`x-relay-target`, `x-relay-path`) instead of using a proxy dispatcher.

---

### Requirement 11: MITM DNS Bypass

**User Story:** As an operator using a local MITM proxy (e.g. Charles, mitmproxy) for debugging, I want 9Router to bypass DNS spoofing for a known set of sensitive provider hosts, so that traffic to those providers still reaches the real upstream endpoints.

#### Acceptance Criteria

1. WHEN a request targets a host in the MITM bypass list AND no outbound proxy is configured for the Connection, THE Proxy SHALL resolve the real IP address using an external DNS resolver rather than the system resolver.
2. WHERE an outbound proxy is configured for the Connection AND the target host is in the MITM bypass list, THE Proxy SHALL route the request through the configured outbound proxy AND allow the proxy to perform DNS resolution; external DNS bypass SHALL only be applied when no outbound proxy is configured for the Connection.
3. THE Proxy SHALL cache DNS resolution results per hostname with a configurable TTL.
4. IF external DNS resolution for a bypass host fails, THEN THE Proxy SHALL log a warning AND return an error for the upstream fetch; THE Proxy SHALL NEVER fall back to system DNS for bypass hosts — if external DNS fails, the request fails.

---

### Requirement 12: Request and Usage Logging

**User Story:** As an operator, I want every proxied request to be logged with its provider, model, status, and token usage, so that I can audit cost, debug failures, and monitor capacity.

#### Acceptance Criteria

1. THE Proxy SHALL record a usage entry for every completed request containing: provider, model, prompt tokens, completion tokens, connection ID, and timestamp.
2. THE Proxy SHALL track the count of in-flight requests per provider/model/connection AND decrement on completion or error.
3. THE Proxy SHALL append a status log line for every request with the format: `PENDING → COMPLETED` or `PENDING → FAILED {status}`.
4. WHERE `ENABLE_REQUEST_LOGS` is set to `true`, THE Proxy SHALL write full request and response details to the request log directory for ALL requests regardless of success or failure status; THE Proxy SHALL log details for every request without exception.
5. WHERE `ENABLE_REQUEST_LOGS` is set to `true`, THE Proxy SHALL write headers and body to separate files in the request log directory; WHEN a request fails after partial completion, THE Proxy SHALL write partial results captured up to the point of failure rather than omitting the log entry.
6. WHERE token usage metadata is absent from the upstream response, THE Proxy SHALL record zero token counts rather than omitting the usage entry.
7. THE Proxy SHALL close and flush log writers after each completed request to ensure durability.
8. THE Proxy SHALL handle log writer errors gracefully without disrupting request processing.
9. WHERE `ENABLE_REQUEST_LOGS` is set to `true` AND the request is a passthrough request, THE Proxy SHALL label the log entry as passthrough, preserve enough raw request/response shape to debug provider compatibility, redact secrets, AND SHALL NOT make passthrough logs appear as translated requests.
10. WHERE `ENABLE_REQUEST_LOGS` is set to `true` AND a request fails or partially completes, THE Proxy SHALL clearly mark the log entry as failed or incomplete; partial logs MUST NOT appear as successful requests.

---

### Requirement 13: API Key Authentication

**User Story:** As an operator, I want to require clients to present a valid local API key, so that the 9Router instance is not accessible to unauthorised local processes.

#### Acceptance Criteria

1. WHERE `requireApiKey` is enabled AND an incoming request has no `Authorization: Bearer` header, THE Proxy SHALL return HTTP 401.
2. WHERE `requireApiKey` is enabled AND the presented API key matches an active key in the local store, THE Proxy SHALL accept the request AND log the key ID used.
3. WHERE `requireApiKey` is enabled AND the presented API key does NOT match any active key in the local store, THE Proxy SHALL return HTTP 401.
4. WHERE `requireApiKey` is disabled, THE Proxy SHALL accept requests without an API key AND log that authentication was bypassed.
5. An API key is considered "active" if it exists in the local store AND has not been revoked AND has not expired.
6. THE Proxy SHALL log the following fields for every request: timestamp, request path, authenticated status (boolean), and key ID if authenticated.
7. IF an `Authorization: Bearer` header is present with an invalid or expired API key, THEN THE Proxy SHALL return HTTP 401 regardless of whether `requireApiKey` is enabled or disabled; this criterion takes strict precedence over criterion 4 — the no-auth bypass only applies when NO `Authorization` header is present; an explicit but invalid credential is ALWAYS rejected.
8. WHERE `requireApiKey` is enabled, THE Proxy SHALL NOT allow any bypass mechanism; all requests MUST present a valid active API key regardless of any other configuration.

---

### Requirement 14: Compression Statistics Tracking

**User Story:** As an operator, I want to see aggregated statistics on how much compression each subsystem (RTK, Headroom, Caveman) has achieved, so that I can evaluate the benefit of each feature.

#### Acceptance Criteria

1. THE Proxy SHALL persist compression statistics records for RTK, Headroom, and Caveman to the compression stats store after each request where compression was actually applied, regardless of whether the compression subsystem is enabled in settings.
2. WHERE the compression stats store is SQLite, THE Proxy SHALL store records with the following schema: `id` (integer primary key), `timestamp` (ISO8601 text), `subsystem` (text: 'rtk', 'headroom', 'caveman'), `bytes_before` (integer), `bytes_after` (integer), `filter_hits` (JSON text, optional), `level` (text, optional for caveman).
3. IF writing compression statistics fails, THEN THE Proxy SHALL log the failure AND continue request processing without interruption; THE Proxy SHALL always continue in both success and failure cases for stats writing.
4. IF logging the compression statistics failure itself fails, THEN THE Proxy SHALL continue processing without further logging attempts.

---

### Requirement 15: Compression and Passthrough Mode

**User Story:** As a client using passthrough mode, I want 9Router to preserve my provider-native request shape without compression unless I explicitly enable it, so that my client's intended request structure is maintained.

#### Acceptance Criteria

1. FOR passthrough mode requests, THE Proxy SHALL NOT apply compression (RTK, Headroom, or Caveman) unless passthrough compression is explicitly enabled in settings.
2. WHERE passthrough compression is enabled AND compression is actually applied, THE Proxy SHALL proceed with compression; WHERE passthrough compression is disabled, THE Proxy SHALL skip all compression subsystems and forward the original request body unmodified.
3. THE Proxy SHALL NOT alter provider-native message arrays in passthrough mode unless compression is explicitly enabled and configured.
4. WHERE compression is explicitly enabled for passthrough mode AND compression fails, THE Proxy SHALL continue with the original unmodified content.

---

### Requirement 16: Passthrough Mode Preservation

**User Story:** As a client developer using advanced provider-native features, I want 9Router to preserve my provider's native request structure in passthrough mode without silently removing or renaming fields, so that my client's full feature set remains available.

#### Acceptance Criteria

1. FOR passthrough mode requests, THE Proxy SHALL preserve all provider-native fields in the request body without renaming or dropping unknown fields.
2. FOR passthrough mode requests, THE Proxy SHALL preserve client-requested streaming behavior (do not force non-streaming if client requested streaming, and vice versa except where required by always-streaming providers where SSE assembly is needed).
3. FOR passthrough mode requests, THE Proxy SHALL preserve upstream response shape, upstream error shape where safe, and provider-specific response fields.
4. FOR passthrough mode requests, THE Proxy SHALL NOT translate the request body into another provider schema unless explicitly required by the endpoint contract or configuration.
5. FOR passthrough mode requests, THE Proxy SHALL still apply known compatibility fixes that prevent upstream rejection (such as stripping provider prefixes from Anthropic built-in tool `model` fields) because these are required to avoid provider-side 400 errors.
6. FOR passthrough mode requests, THE Proxy SHALL still remove local-only proxy metadata fields that are not recognized by the upstream provider.
7. FOR passthrough mode requests, THE Proxy SHALL NOT alter tool definitions unless a known provider compatibility rule explicitly requires it to prevent upstream rejection.

---

### Requirement 17: Core Reliability - Fail Closed, Fail Open

**User Story:** As an operator, I want 9Router to continue processing requests even when optional subsystems (statistics, logging, telemetry) fail, so that the proxy remains reliable under messy real-world conditions.

#### Acceptance Criteria

1. THE Proxy SHALL continue the main request path unless continuing would violate security, authentication correctness, request validity, response validity, DNS/MITM bypass integrity, or model/provider resolution correctness.
2. OPTIONAL subsystems MUST NOT break the request path. OPTIONAL subsystems include: compression statistics, Caveman statistics, request logs, debug logs, telemetry, and non-critical metadata recording.
3. IF an optional subsystem fails, THE Proxy SHALL log the failure IF POSSIBLE AND continue; IF logging the failure ALSO fails, THE Proxy SHALL continue without further logging attempts.
4. FOR passthrough mode, THE Proxy SHALL apply passthrough mutations ONLY when required by security, routing, or explicitly required compatibility rules; passthrough mode MUST NOT mutate provider-native request shapes unless one of these rules explicitly requires it.
5. IF passthrough resolution fails to determine a valid provider/model target, THEN THE Proxy SHALL return an error AND SHALL NOT silently fall back to translated mode.
6. IF passthrough resolution fails, THE Proxy SHALL NOT guess the intended provider or mutate the request into a different provider format; passthrough MUST be predictable — either forward the provider-compatible request safely or fail clearly.
7. FOR passthrough mode, THE Proxy SHALL still enforce outbound proxy routing, MITM bypass DNS rules, and authentication; these are transport-layer and security concerns that apply regardless of passthrough status.
8. FOR passthrough mode, translation rules SHALL NOT automatically apply; THE Proxy SHALL avoid translation unless explicitly required by the selected endpoint contract or configuration.

---

### Requirement 18: Correctness - Fail Closed, No Guessing

**User Story:** As an operator, I want 9Router to return an error instead of guessing when the system cannot determine the correct behavior, so that invalid requests never produce false success responses.

#### Acceptance Criteria

1. IF model or combo resolution ultimately fails, THEN THE Proxy SHALL return an error AND SHALL NOT silently fall back to an alternative resolution path.
2. IF passthrough provider resolution fails, THEN THE Proxy SHALL return an error AND SHALL NOT guess the intended provider.
3. IF request translation cannot produce a valid upstream body, THEN THE Proxy SHALL return HTTP 400.
4. IF post-translation validation fails, THEN THE Proxy SHALL return HTTP 400.
5. IF SSE stream assembly fails for a non-streaming client, THEN THE Proxy SHALL discard all partially assembled data AND return an error response; partial JSON MUST NEVER be returned as success.
6. IF MITM bypass DNS integrity cannot be guaranteed, THEN THE Proxy SHALL return an error AND SHALL NOT silently fall back to system DNS resolution for bypass hosts.
7. THE Proxy SHALL return HTTP 400 for any request-shape failure that prevents successful request processing.
8. PREFERRED error types: `translation_invalid_body`, `validation_failed`, `unsupported_request`, `missing_required_field`.
9. A combo match succeeds only when it resolves to a valid actionable provider/model target; a Model_String matching a registered combo name is not enough to count as successful resolution if combo resolution ultimately fails.
10. THE Proxy SHALL NEVER return: partial JSON as success, malformed JSON with `application/json` Content-Type, incomplete SSE assembly as a normal response, a translated-but-invalid upstream body, a successful HTTP status for failed combo/model resolution, or a successful HTTP status for failed passthrough provider resolution.
11. IF the Proxy cannot guarantee response validity, THEN THE Proxy SHALL return an error rather than a potentially invalid response.
