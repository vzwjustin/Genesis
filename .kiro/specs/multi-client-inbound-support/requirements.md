# Requirements Document

## Introduction

This feature enables the 9router-fork (Genesis) CLI proxy to accept inbound requests from multiple AI client tools — specifically **Kiro IDE** and **OpenCode** — and route those requests through any of the proxy's configured upstream providers (Anthropic/Claude Code, OpenAI/Codex, Gemini CLI, GitHub Copilot, Kiro, Cursor, iFlow, Qwen, etc.).

Today, OpenCode is partially configured to point at the proxy but requests fail with "Not Found" (unresolvable model IDs) and "Unauthorized" (API key rejection). Kiro IDE has no inbound-client handling. The goal is a flexible, correct multi-client inbound layer where any supported provider connection can be used from any supported AI coding tool.

The proxy already handles outbound routing to providers. This feature extends the inbound contract to reliably accept, authenticate, and resolve requests from Kiro IDE and OpenCode clients, map model IDs to provider-qualified names, and surface accurate configuration instructions for each client.

---

## Glossary

- **Proxy**: The 9router-fork (Genesis) local proxy server running at a configured port (default `20128`).
- **Inbound_Client**: An AI coding tool (Kiro IDE, OpenCode) that sends chat/completion requests to the Proxy.
- **Provider**: A configured upstream AI service (e.g. `cc` for Claude Code/Anthropic, `kr` for Kiro AWS CodeWhisperer, `cx` for Codex, `gc` for Gemini CLI, `gh` for GitHub Copilot, `cu` for Cursor, `if` for iFlow, `openai`, `anthropic`, etc.).
- **Provider_Model_String**: A model reference in `provider_alias/model_id` format (e.g. `kr/claude-sonnet-4.6`, `cc/claude-opus-4-8`, `cx/gpt-5.4`).
- **OpenAI_Wire**: The OpenAI-compatible REST API (`POST /v1/chat/completions`). Used for non-Claude providers.
- **Anthropic_Wire**: The Anthropic-compatible REST API (`POST /v1/messages`). Used for Claude-format providers (`cc`, `kr`, `kimi`, `glm`, etc.).
- **API_Key**: A proxy-local bearer token (e.g. `sk_genesis`) used to authenticate inbound client requests when `REQUIRE_API_KEY=true`.
- **Model_Registry**: The proxy's internal mapping of `Provider_Model_String` to provider executor and connection.
- **Config_Writer**: The proxy subsystem (API routes at `/api/cli-tools/`) that reads and writes client tool configuration files.
- **OpenCode**: The OpenCode CLI/app AI coding tool that reads `~/.config/opencode/opencode.json` to discover providers.
- **Kiro_IDE**: The Kiro IDE application that reads its own configuration to discover AI providers.
- **Wire_Type**: Whether a given Provider_Model_String requires the OpenAI_Wire or Anthropic_Wire inbound endpoint.

---

## Requirements

### Requirement 1: Model ID Resolution for Inbound Clients

**User Story:** As an OpenCode or Kiro IDE user, I want to specify a model like `kr/claude-sonnet-4.6` or `cc/claude-opus-4-8` in my client tool's config, so that the proxy routes my request to the correct upstream provider connection without returning "Not Found."

#### Acceptance Criteria

1. WHEN an inbound request arrives at the Proxy with a `model` field matching a registered `Provider_Model_String`, THE Proxy SHALL resolve it to the corresponding provider connection and forward the request upstream.
2. WHEN an inbound request arrives with a `model` field that does not match any registered `Provider_Model_String` or known alias, THE Proxy SHALL return HTTP `404` with a structured error body containing the unresolved model string and a list of available model IDs from the Model_Registry.
3. WHEN an inbound request arrives with a `model` field that matches a `Provider_Model_String` whose provider has zero configured connections, THE Proxy SHALL return HTTP `503` with a structured error body identifying the provider alias and stating it has no active connections.
4. THE Model_Registry SHALL support `Provider_Model_String` values in the format `{alias}/{model_id}` for all provider aliases defined in `PROVIDER_MODELS` (e.g. `kr/`, `cc/`, `cx/`, `gc/`, `gh/`, `if/`, `cu/`, `kmc/`, `openai/`, `anthropic/`, `gemini/`). Lookup SHALL be case-sensitive and exact-match on the full string.
5. WHEN model resolution succeeds and the resolved provider requires Anthropic_Wire format, THE Proxy SHALL route the request through the Anthropic translation path regardless of which inbound endpoint the client used.
6. WHEN model resolution succeeds and the resolved provider requires OpenAI_Wire format, THE Proxy SHALL route the request through the OpenAI translation path regardless of which inbound endpoint the client used.
7. IF the upstream provider returns a non-2xx response after a successfully resolved and forwarded request, THE Proxy SHALL return the upstream error status and body to the client without treating it as a model resolution failure.

---

### Requirement 2: Inbound Authentication for Multi-Client Access

**User Story:** As a proxy operator, I want clients like OpenCode and Kiro IDE to authenticate with the proxy using a valid API key, so that only authorized tools can access upstream providers.

#### Acceptance Criteria

1. WHEN `REQUIRE_API_KEY=true` and an inbound request carries an `Authorization: Bearer {token}` header where `{token}` matches a stored, non-revoked API_Key, THE Proxy SHALL accept the request and proceed to model resolution.
2. WHEN `REQUIRE_API_KEY=true` and an inbound request carries no `Authorization` header, THE Proxy SHALL return HTTP `401` with error type `unauthorized`.
3. WHEN an inbound request carries an `Authorization` header that is malformed (not in `Bearer {token}` format), missing the token, or where the token does not match any stored non-revoked API_Key, THE Proxy SHALL return HTTP `401` with error type `unauthorized` regardless of the `REQUIRE_API_KEY` setting.
4. WHEN `REQUIRE_API_KEY=false` and an inbound request carries no `Authorization` header, THE Proxy SHALL accept the request and log that authentication was bypassed.
5. WHEN `REQUIRE_API_KEY=false` and an inbound request carries an `Authorization: Bearer {token}` header where `{token}` matches a stored non-revoked API_Key, THE Proxy SHALL accept the request and proceed to model resolution.
6. WHEN `REQUIRE_API_KEY=false` and an inbound request carries an `Authorization: Bearer {token}` header where `{token}` does not match any stored non-revoked API_Key or the header is malformed, THE Proxy SHALL return HTTP `401` with error type `unauthorized`.
7. WHEN any inbound request path (`/v1/chat/completions`, `/v1/messages`, `/v1/models`) is called, THE Proxy SHALL apply the same authentication logic with no path receiving different authentication behavior than any other path.

---

### Requirement 3: OpenCode Configuration Generation

**User Story:** As an OpenCode user, I want the proxy dashboard to generate a correct `~/.config/opencode/opencode.json` configuration for any combination of providers and models I select, so that OpenCode can immediately use those models through the proxy without manual editing.

#### Acceptance Criteria

1. WHEN the Config_Writer receives a POST request with a `baseUrl` (a valid HTTP or HTTPS URL with no trailing slash), a non-empty `models` array of `Provider_Model_String` values, and a non-empty `apiKey`, THE Config_Writer SHALL write an `opencode.json` containing a top-level `providers` object and a `model` field that OpenCode can load without modification.
2. WHEN the `models` array contains only OpenAI_Wire models (non-`cc/`- and non-`claude`-prefixed), THE Config_Writer SHALL write a single `genesis` provider block using `@ai-sdk/openai-compatible` with `baseURL` set to `{baseUrl}/v1`.
3. WHEN the `models` array contains only Anthropic_Wire models (`cc/`- or `claude`-prefixed), THE Config_Writer SHALL write a single `genesis` provider block using `@ai-sdk/anthropic` with `baseURL` set to `{baseUrl}` without a `/v1` suffix.
4. WHEN the `models` array contains a mix of OpenAI_Wire and Anthropic_Wire models, THE Config_Writer SHALL write both a `genesis` provider block for OpenAI_Wire models and a `genesis-cc` provider block for Anthropic_Wire models, each with the correct `baseURL` and the same `apiKey`.
5. WHEN the Config_Writer writes an `opencode.json` with a mixed model set, THE written config SHALL set the top-level `model` field to a value prefixed by the provider key (`genesis/` or `genesis-cc/`) that matches the Wire_Type of the first model in the `models` array.
6. IF a GET request is made to the Config_Writer and the `opencode.json` file does not exist at the expected path, THEN THE Config_Writer SHALL return `{ "diagnostics": { "fileExists": false, "misconfigured": false } }` without error. IF the file exists and its `genesis` provider block uses `@ai-sdk/openai-compatible` for Anthropic_Wire models or has a `baseURL` ending in `/v1` for Anthropic_Wire models, THEN THE Config_Writer SHALL return `{ "diagnostics": { "misconfigured": true, "expectedNpm": "@ai-sdk/anthropic", "expectedBaseURL": "{baseUrl}" } }`.
7. WHEN a PATCH request with `repairClaudeWire: true` is received and the `opencode.json` file does not exist, THE Config_Writer SHALL return HTTP `404`. WHEN the file exists, THE Config_Writer SHALL rewrite the `opencode.json` to split or correct provider blocks so all Wire_Types are correctly assigned, without removing any existing model entries.
8. IF a POST request is received with a missing or non-HTTP/HTTPS `baseUrl`, an empty `models` array, or an absent `apiKey`, THEN THE Config_Writer SHALL return HTTP `400` with a structured error body identifying the invalid fields and SHALL NOT write any file.

---

### Requirement 4: Kiro IDE Configuration Generation

**User Story:** As a Kiro IDE user, I want the proxy dashboard to generate correct configuration for Kiro IDE so that Kiro IDE routes its AI requests through the proxy to any provider I have connected.

#### Acceptance Criteria

1. WHEN the Config_Writer receives a POST request to generate Kiro IDE configuration with a valid `baseUrl`, a non-empty `apiKey`, and a non-empty list of `Provider_Model_String` values, THE Config_Writer SHALL produce a valid Kiro IDE provider configuration block that Kiro IDE can load without modification.
2. WHEN Kiro IDE configuration is generated for Claude-compatible models (prefixes `cc/`, `kr/`, `kimi/`, `glm/`, `minimax/`), THE Config_Writer SHALL set the provider type to Anthropic-compatible and the `baseURL` to `{baseUrl}` without a `/v1` suffix.
3. WHEN Kiro IDE configuration is generated for OpenAI-compatible models (prefixes `cx/`, `gc/`, `gh/`, `openai/`, `deepseek/`), THE Config_Writer SHALL set the provider type to OpenAI-compatible and the `baseURL` to `{baseUrl}/v1`.
4. WHEN the `models` list contains both Claude-compatible and OpenAI-compatible prefixes, THE Config_Writer SHALL produce separate provider blocks for each wire type, each with the correct `baseURL` and the same `apiKey`.
5. IF the Kiro IDE configuration endpoint is called with a `baseUrl` that is not a valid HTTP or HTTPS URL, or with an empty `models` list, or with a missing `apiKey`, THEN THE Config_Writer SHALL return HTTP `400` with a structured error body identifying the invalid fields and SHALL NOT write any file.
6. WHEN a GET request is made to the Kiro IDE configuration endpoint and the Kiro IDE config file does not exist, THE Config_Writer SHALL return `{ "exists": false }`. WHEN the file exists and contains a genesis provider block, THE response SHALL include `{ "exists": true, "wireType": "anthropic" | "openai" | "mixed" }`.

---

### Requirement 5: Provider Model Enumeration for Client Configuration

**User Story:** As a user configuring OpenCode or Kiro IDE to use the proxy, I want to see all available models from all active provider connections, so that I can select which models to expose in my client tool.

#### Acceptance Criteria

1. WHEN a GET request is made to `/v1/models`, THE Proxy SHALL return an OpenAI-compatible model list response containing models from all provider connections that have at least one configured connection entry, regardless of token validity.
2. WHEN a provider connection has an active token and supports dynamic model discovery (e.g. Kiro via `ListAvailableModels`), THE Proxy SHALL include the dynamically fetched models in the `/v1/models` response. For Claude-family providers (`cc/`, `kr/`, `kimi/`, `glm/`, `minimax/`) the response SHALL also include `-thinking` and `-agentic` variants of each discovered model.
3. WHEN dynamic model discovery for a provider fails, THE Proxy SHALL fall back to the static model catalog for that provider and include the provider name and failure reason in a top-level `warnings` array in the response body, without omitting the provider's models entirely.
4. THE model objects returned by `/v1/models` SHALL include an `id` field containing the full `Provider_Model_String` (e.g. `kr/claude-sonnet-4.6`) so that clients can copy the value directly into their tool configuration.
5. IF a provider connection entry exists but has no active access token, THEN THE Proxy SHALL include that provider's static model list in the `/v1/models` response with a `requires_auth: true` field on each model object from that provider.
6. WHEN the `/v1/models` endpoint is called with a valid `Authorization: Bearer` header and `REQUIRE_API_KEY=true`, THE Proxy SHALL return the full model list.
7. IF `REQUIRE_API_KEY=true` and the `/v1/models` endpoint is called without a valid key or without an `Authorization` header, THEN THE Proxy SHALL return HTTP `401`.

---

### Requirement 6: Wire-Format Translation for Inbound Requests

**User Story:** As an OpenCode user, I want to send requests over the OpenAI-compatible wire using a `cc/` or `kr/` model string, so that the proxy transparently translates the request to Anthropic format and routes it correctly without requiring a separate endpoint.

#### Acceptance Criteria

1. WHEN an inbound `POST /v1/chat/completions` request specifies a `Provider_Model_String` that resolves to an Anthropic_Wire provider, THE Proxy SHALL translate the OpenAI-format request body to Anthropic Messages API format before forwarding upstream. Fields not representable in the target format SHALL be dropped silently.
2. WHEN an inbound `POST /v1/messages` request specifies a `Provider_Model_String` that resolves to an OpenAI_Wire provider, THE Proxy SHALL translate the Anthropic-format request body to OpenAI Chat Completions format before forwarding upstream.
3. IF translation between wire formats produces a body that fails schema validation for the target provider format, THEN THE Proxy SHALL return HTTP `400` with error type `translation_invalid_body` and a description of the validation failure. THE Proxy SHALL NOT forward the invalid body upstream.
4. WHEN an inbound request is received over a wire whose format matches the target provider format, THE Proxy SHALL forward the request body with only the mutations explicitly required by a security, routing, or provider-compatibility rule (e.g. stripping provider prefixes from Anthropic built-in tool `model` fields). No other fields SHALL be added, removed, or renamed.
5. WHEN an inbound streaming request (`stream: true`) is routed to an upstream provider that returns SSE, THE Proxy SHALL stream the SSE response back to the client in the inbound wire's streaming format. IF re-serialization of an SSE event to the inbound wire format fails, THE Proxy SHALL terminate the stream and return an error event.
6. WHEN an inbound non-streaming request is routed to an upstream provider that always streams (returns SSE regardless of the `stream` field), THE Proxy SHALL assemble the full SSE stream into a single complete JSON response in the inbound wire format. IF stream assembly fails or produces incomplete output, THE Proxy SHALL discard all partial data and return HTTP `502` with error type `stream_assembly_failed`.

---

### Requirement 7: Inbound Request Logging for Multi-Client Debugging

**User Story:** As a proxy operator debugging OpenCode or Kiro IDE connectivity issues, I want inbound requests from those clients to be logged with enough detail to diagnose model resolution failures, auth failures, and wire-format mismatches.

#### Acceptance Criteria

1. WHEN `ENABLE_REQUEST_LOGS=true` and an inbound request completes (successfully or with error), THE Proxy SHALL write a structured log entry containing: inbound wire type (`openai` or `anthropic`), the raw `model` field from the request, the resolved `Provider_Model_String` if resolution succeeded (or `null` if it failed), and the HTTP status code of the response.
2. WHEN `ENABLE_REQUEST_LOGS=true` and an inbound request fails model resolution, THE Proxy SHALL include in the log entry the unresolved model string and the full set of registered `Provider_Model_String` values available at the time of failure.
3. WHEN `ENABLE_REQUEST_LOGS=true` and an inbound request fails authentication, THE Proxy SHALL include in the log entry the failure reason (`missing_header`, `invalid_key`, or `malformed_header`) without including the key value or the raw `Authorization` header value.
4. IF writing a log entry fails for any reason, THEN THE Proxy SHALL not return an error to the client and SHALL continue request processing as if logging had succeeded.
5. WHEN any log entry is written, THE Proxy SHALL replace the value of any `Authorization` header, any upstream API key field, and any bearer token string with the literal string `[REDACTED]` before the entry is serialized to the log destination.
