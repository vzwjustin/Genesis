# AGENTS.md

## HARD INSTRUCTIONS — ALWAYS, NON-NEGOTIABLE
On every task, before answering or acting (even "simple" tasks, no skip):
1. **5 Whys** — ask "why" 5x to reach root cause/intent, not surface symptom.
2. **What-ifs** — surface edge cases, failure modes, alternative interpretations.
3. **Self-reflect** — audit own reasoning for gaps, hidden assumptions, errors before committing. Revise if weak.

## Behavioral Guidelines — reduce common LLM coding mistakes
Bias toward caution over speed. For trivial tasks, use judgment. These apply on top of the repo rules below ("fail closed for correctness/security", TDD/testing requirements).
1. **Think before coding** — state assumptions explicitly; multiple interpretations → present them, don't pick silently; simpler approach exists → say so, push back; unclear → stop, name the confusion, ask.
2. **Simplicity first** — minimum code, nothing speculative. No unrequested features/abstractions/configurability. No error handling for impossible scenarios. 200 lines that could be 50 → rewrite. "Would a senior engineer call this overcomplicated?" yes → simplify.
3. **Surgical changes** — touch only what you must. Don't "improve" adjacent code/comments/formatting. Don't refactor what isn't broken. Match existing style. Unrelated dead code → mention it, don't delete. Remove only the imports/vars/functions YOUR changes orphaned. Every changed line traces directly to the request.
4. **Goal-driven execution** — define success criteria, loop until verified. "Add validation" → tests for invalid inputs then pass. "Fix the bug" → repro test then pass. "Refactor X" → tests green before and after. Multi-step → brief plan, each step with a verify check.

Working if: fewer unnecessary diff lines, fewer overcomplication rewrites, clarifying questions come *before* implementation.

---

# 9router Fork — Agent Instructions

This repository is a fork/customization of `9router`, used as a local AI CLI proxy/router.

The proxy sits between CLI/agent clients and upstream providers such as Anthropic, OpenAI, Codex, Claude Code-compatible flows, and other OpenAI-style clients.

Primary design rule:

> Fail closed for correctness and security. Fail open for optional side effects.

Secondary design rule:

> Passthrough means passthrough. Do not mutate raw provider-compatible requests unless a security, routing, or explicitly required compatibility rule says so.

This file contains hard operational notes and behavioral decisions. Agents working in this repo must follow them.

---

## Critical Build and Deploy Gotchas

These are not optional. Most confusing bugs in this fork come from editing the correct source but running stale compiled output or a globally installed standalone copy.

### 1. ALWAYS clear webpack cache before rebuilding the CLI

The Next.js webpack cache can retain old compiled code even after a rebuild. This
is the #1 source of "I fixed it but behavior didn't change" bugs in this fork.

**Non-negotiable: always clear the cache before every CLI rebuild.** Do not treat
this as optional or as a "only when editing open-sse/" step — always do it.

Canonical rebuild (use this exact form):

    rm -rf .next-cli-build && (cd cli && npm run build)

Minimal cache-only clear (if you must keep the rest of the build dir):

    rm -rf .next-cli-build/cache/webpack && (cd cli && npm run build)

Important:

- Do not trust a rebuild unless the cache was cleared first.
- Always clear — especially after editing files under `open-sse/`.
- If behavior does not match source, assume stale compiled output first.

---

### 2. Global install must be a symlink to the fork

Do not rely on `npm install -g` from the built tarball during active development.

A global install from tarball creates a standalone copy. After that, edits in the fork are invisible to the running server.

The global install should point directly to the fork. Run from the repo root so
the paths resolve correctly regardless of machine (Linux PC / macOS) or where the
fork is checked out:

    rm -rf "$(npm root -g)/9router"
    ln -s "$(pwd)/cli" "$(npm root -g)/9router"

`$(npm root -g)` resolves the global module dir per machine (e.g.
`/opt/homebrew/lib/node_modules` on macOS Homebrew, `/usr/lib/node_modules` or an
nvm path on Linux). `$(pwd)/cli` picks up the actual checkout location.

Before debugging runtime behavior, verify the global package is a symlink to the fork.

Expected path (macOS Homebrew shown; the prefix differs on Linux):

    /opt/homebrew/lib/node_modules/9router -> <your-fork>/cli

---

### 3. Run headless server directly

The `9router` CLI wrapper, `cli.js`, detects non-interactive TTY and may auto-exit with a tray-mode fallback.

For headless deployment, run the server directly:

    PORT=3456 HOSTNAME=0.0.0.0 node /opt/homebrew/lib/node_modules/9router/app/server.js

Do not use the CLI wrapper for headless server debugging unless specifically testing wrapper behavior.

---

### 4. Verify fixes in compiled output

After rebuilding, verify that important fixes actually made it into the compiled bundle.

Example verification for the Anthropic built-in tool model-prefix fix:

    bash scripts/verify-compiled-anthropic-fix.sh

Or manually (minified bundles omit spaces around `+`):

    grep -R 'indexOf("/")+1' cli/app/.next-cli-build/server/chunks

The generated chunk filename can change between builds. Do not rely only on a specific chunk such as `7540.js`.

**Lockfile:** root `package.json` has no `package-lock.json` in this fork; use `npm install` in `cli/` and `tests/` for reproducible CI. Pin versions when cutting releases.

---

## Known Critical Bug: Anthropic Built-In Tool `model` Prefix

### Symptom

Anthropic returns HTTP `400 invalid_request_error` with messages like:

    tools.62.model: cc/claude-opus-4-6

### Root cause

`prepareClaudeRequest` in:

    open-sse/translator/helpers/claudeHelper.js

was passing through built-in tool properties, including `model`, without stripping provider prefixes such as:

    cc/

Anthropic rejects prefixed model names inside built-in tool definitions.

### Fix location

Approximate source location:

    open-sse/translator/helpers/claudeHelper.js

Around lines `196-208`.

### Required logic

For client tools:

- `type` missing or `type === "function"`
- strip `model`
- strip `type`

For built-in tools:

- preserve properties
- but strip provider prefix from `model` if present

Required logic:

    if (!tool.type || tool.type === "function") {
      // Client tools — strip model and type
      const { model, type, ...clientRest } = rest;
      cleanedTool = { ...clientRest };
    } else {
      // Built-in tools — preserve all properties, but strip provider prefix from model
      cleanedTool = { ...rest };
      if (typeof cleanedTool.model === "string" && cleanedTool.model.includes("/")) {
        cleanedTool.model = cleanedTool.model.slice(cleanedTool.model.indexOf("/") + 1);
      }
    }

### Verification

After clearing cache and rebuilding, verify the compiled bundle contains the fix:

    grep -R "model.slice.*indexOf.*+1" cli/app/.next-cli-build/server/chunks

If the grep does not find the fix, the running server is not using the intended source.

---

## Project Mission

This fork implements a local AI CLI proxy/gateway that normalizes multiple upstream AI providers behind one predictable local contract.

It handles:

- provider routing
- request translation
- model and combo resolution
- passthrough routing
- streaming adaptation
- SSE-to-JSON assembly
- retry behavior
- connection pooling
- outbound proxy routing
- MITM bypass DNS behavior
- RTK/Caveman compression
- compression statistics
- request/response logging
- API key enforcement

The proxy must be reliable under messy real-world CLI/agent behavior.

---

## Core Reliability Rule

The main request path should continue unless continuing would violate:

- security
- authentication correctness
- request validity
- response validity
- DNS/MITM bypass integrity
- model/provider resolution correctness

Optional systems must not break the request path.

Optional systems include:

- compression statistics
- Caveman statistics
- request logs
- debug logs
- telemetry
- non-critical metadata recording

If optional systems fail, log if possible and continue. If logging the optional failure also fails, still continue.

---

## Passthrough / Passthru Mode

Passthrough is a first-class behavior in this fork.

Use both spellings in comments/searches because the codebase or docs may use either:

- `passthrough`
- `passthru`

### Purpose

Passthrough mode is for requests that are already provider-compatible and should be forwarded upstream with minimal mutation.

This is critical for clients that already know the target provider schema, including advanced Claude Code, Codex, OpenAI-compatible, Anthropic-compatible, or experimental client flows.

### Passthrough rule

> In passthrough mode, preserve the client's intended upstream request shape.

Do not run normal translation unless explicitly required.

Do not normalize fields just because the normal translated path would.

Do not silently remove advanced provider-specific fields.

Do not rewrite tool schemas unless a known provider compatibility rule explicitly requires it.

Do not apply compression unless passthrough compression is explicitly enabled.

### Allowed passthrough mutations

The proxy may still apply these because they are proxy responsibilities, not semantic request translation:

- authentication enforcement
- provider/model resolution
- connection selection
- outbound proxy routing
- MITM bypass DNS behavior
- request timeout handling
- retry/cooldown rules
- required upstream auth header injection
- removal of local-only proxy metadata
- request/response logging if enabled
- streaming adaptation only when required by the client contract
- known compatibility fixes that prevent upstream rejection, such as stripping provider prefixes from Anthropic built-in tool `model` fields

### Disallowed passthrough mutations

Do not do these in passthrough mode unless explicitly requested by config or a hard requirement:

- do not translate the body into another provider schema
- do not rename provider-native fields
- do not drop unknown provider-native fields
- do not compress message content by default
- do not alter tool definitions by default
- do not force non-streaming if the client requested streaming
- do not force streaming if the client requested non-streaming, except for always-streaming upstream providers where assembly is required
- do not convert a provider-native response into another provider schema unless the endpoint contract requires it

### Passthrough response behavior

If the client requested passthrough response behavior:

- preserve upstream response shape
- preserve upstream error shape where safe
- preserve streaming behavior if the client requested streaming
- preserve provider-specific response fields

If the endpoint contract requires OpenAI-compatible or Anthropic-compatible output, then the proxy may adapt the response, but this must be explicit and tested.

### Passthrough errors

If passthrough resolution fails:

- return an error
- do not silently fall back to translated mode
- do not guess the intended provider
- do not mutate the request into a different provider format

Rule:

> Passthrough must be predictable. Either forward the provider-compatible request safely or fail clearly.

---

## Security Rules

Security fails closed.

### API key behavior

When `requireApiKey=true`:

- all requests must present valid API keys
- bypass mechanisms are not allowed
- missing, invalid, expired, or malformed credentials return HTTP `401`

When `requireApiKey=false`:

- requests without API keys are accepted
- authentication bypass should be logged
- bypass applies only when no `Authorization` header is present

If an `Authorization: Bearer` header is present:

- validate it regardless of `requireApiKey`
- reject invalid or expired keys with HTTP `401`

Rule:

> Invalid credentials are never accepted. No-auth mode allows absence of credentials, not bad credentials.

---

## Correctness Rules

Correctness fails closed.

Return an error instead of guessing when:

- model or combo resolution ultimately fails
- passthrough provider resolution fails
- request translation cannot produce a valid body
- post-translation validation fails
- SSE stream assembly fails
- a non-streaming client would receive partial or malformed JSON
- MITM bypass DNS integrity cannot be guaranteed

Do not send malformed upstream requests.

Do not return malformed client responses.

---

## Model and Combo Resolution

A `Model_String` matching a registered combo name is not enough to count as successful resolution.

If combo resolution ultimately fails:

- return an error
- do not silently fall back
- do not treat the combo-name match as success

Rule:

> A combo match succeeds only when it resolves to a valid actionable provider/model target.

---

## Translation and Validation

If translation fails or cannot produce a valid upstream body:

- return HTTP `400`

If translation succeeds but later validation fails:

- return HTTP `400`

Use HTTP `400` for any request-shape failure that prevents successful request processing.

Preferred error types:

- `translation_invalid_body`
- `validation_failed`
- `unsupported_request`
- `missing_required_field`

Translation rules do not automatically apply to passthrough mode. Passthrough mode should avoid translation unless explicitly required by the selected endpoint or config.

---

## Retry and Connection Behavior

Retry limits are based on configured connections.

If a provider has zero configured connections:

- zero connections means zero retries
- do not attempt an initial request
- fail immediately with a provider misconfiguration error

When returning `Retry-After`:

- use the earliest positive reset time
- if computed reset time is `0` or negative while no connection is available, use a minimum delay
- do not return `Retry-After: 0` for a no-capacity state

Recommended minimum:

    Retry-After: 1

Rule:

> Never suggest an immediate retry when the provider is still unavailable.

---

## Headroom Health Probes

When probing the Headroom proxy health endpoint:

- enforce a minimum 30-second gap between probes
- do not probe more frequently just because a rate limit allows it

---

## Combo 4xx Behavior

Only apply 4xx-specific combo behavior when the model actually returns HTTP `4xx`.

Do not apply 4xx combo advancement behavior to:

- HTTP `200`
- HTTP `5xx`
- network errors
- proxy-internal errors

unless another explicit requirement says so.

---

## Streaming and SSE Assembly

Some providers always stream even when the client did not request streaming.

When the client did not request streaming and the provider returns SSE:

- collect the full SSE stream
- assemble it into one complete JSON response
- set response `Content-Type` to `application/json`
- return only complete valid JSON

If stream assembly fails partway through because of malformed SSE data:

- discard all assembled data
- return an error response
- do not return partial JSON
- do not return incomplete content as success

Rule:

> Non-streaming clients must receive complete valid JSON or a clear error.

### Passthrough streaming

In passthrough mode:

- if the client requested streaming, preserve streaming
- if the client requested non-streaming but the upstream always streams, assemble the SSE into valid JSON if the endpoint contract requires JSON
- if assembly fails, discard partial data and return an error
- never return partial JSON as success

---

## RTK Compression

RTK compression is an optimization, not a correctness boundary.

When content type detection fails:

- apply smart truncation as fallback

When content type detection succeeds, such as detecting a git diff:

- try the matching content-aware filter
- if the matching filter fails or cannot safely produce output, fall back to smart truncation

If RTK encounters an internal compression error:

- attempt to log the error
- continue with original unmodified content
- if logging also fails, still continue with original content

Rule:

> Compression must never make the request less reliable than sending the original content.

### Compression and passthrough

Default behavior:

- do not compress passthrough requests unless passthrough compression is explicitly enabled
- do not alter provider-native message arrays in passthrough mode unless configured
- if compression is explicitly enabled and fails, continue with original unmodified content

---

## Caveman Injection and Statistics

When Caveman injection or compression occurs:

- request processing must continue whether statistics recording succeeds or fails

If recording Caveman compression statistics fails:

- attempt to log the failure
- continue request processing
- if logging the failure also fails, still continue request processing

Rule:

> Caveman statistics must never interrupt the request path.

---

## Compression Statistics

Compression statistics should be recorded whenever compression is applied.

If writing compression statistics succeeds:

- continue request processing

If writing compression statistics fails:

- attempt to log the failure
- continue request processing
- do not stop the request for any statistics failure severity

Rule:

> Statistics failures are never severe enough to stop the user request.

---

## Outbound Proxy Routing

When a connection has outbound proxy enabled and a proxy URL configured:

- route all upstream requests for that connection through that proxy URL

If multiple proxy mechanisms are configured, use explicit precedence.

Recommended precedence:

1. Per-connection proxy configuration
2. Environment proxy configuration
3. Relay/default proxy behavior
4. Direct connection

Rule:

> No request should have ambiguous proxy routing.

Passthrough mode does not bypass outbound proxy routing. Routing is a transport concern and still applies.

---

## MITM Bypass and DNS Behavior

MITM bypass behavior is integrity-sensitive.

When a request targets a host in the MITM bypass list:

- resolve the real IP address using the configured external DNS resolver
- do not use the system resolver
- do not fall back to system DNS if the external resolver is unreachable

If external DNS fails for a bypass host:

- fail the request with a clear DNS/bypass error
- do not silently continue through system DNS

When an outbound proxy is configured and the target host is in the MITM bypass list:

- route the request through the configured outbound proxy
- allow the outbound proxy to perform DNS resolution
- do not perform direct local DNS resolution first

If no outbound proxy is configured:

- do not attempt proxy DNS resolution
- proxy DNS resolution requires an actual configured outbound proxy

Rule:

> Bypass hosts must avoid MITM/system resolver interference, even if that means failing closed.

Passthrough mode does not bypass MITM bypass DNS rules. DNS integrity is still enforced.

---

## Request and Response Logging

When `ENABLE_REQUEST_LOGS=true`, write request/response details to the request log directory.

Log all requests regardless of success or failure.

For failed requests:

- log request details
- log available response details if any
- log error details
- mark the log entry as failed

For partially completed requests:

- log partial results
- clearly mark the request as failed or incomplete
- do not make partial logs look successful

Do not skip failed requests entirely.

Rule:

> Failed and partial requests are often the most important logs.

### Passthrough logging

When logging passthrough requests:

- label them as passthrough
- preserve enough raw shape to debug provider compatibility
- redact secrets
- do not make passthrough logs look like translated requests

---

## Response Validity Rules

Never return:

- partial JSON as success
- malformed JSON with `application/json`
- incomplete SSE assembly as a normal response
- translated-but-invalid upstream body
- successful status for failed combo/model resolution
- successful status for failed passthrough provider resolution

If the proxy cannot guarantee response validity, return an error.

---

## Testing Requirements

Every behavior change should include tests.

Minimum test coverage should include:

### Build/runtime verification

- cache clearing documented for `open-sse/` edits
- compiled chunk contains expected critical fix
- global install path is a symlink during development
- headless server launches directly through `app/server.js`

### Passthrough

- passthrough request does not run normal translation
- passthrough preserves unknown provider-native fields
- passthrough preserves client-requested streaming
- passthrough does not compress by default
- passthrough still applies auth
- passthrough still applies outbound proxy routing
- passthrough still applies MITM bypass DNS rules
- passthrough provider resolution failure returns an error
- passthrough logs are clearly labeled as passthrough

### Translation

- invalid translator output returns HTTP `400`
- valid translation with failed validation returns HTTP `400`
- valid translation and validation proceeds upstream
- translation rules do not accidentally run during passthrough mode

### Retry

- zero configured connections causes no request attempt
- unavailable provider returns minimum `Retry-After` instead of `0`
- retry limit matches configured connection count

### Streaming

- always-streaming provider assembles full SSE into JSON for non-streaming client
- malformed SSE discards partial content
- malformed SSE returns an error
- successful assembly returns `Content-Type: application/json`

### Anthropic tool cleaning

- client tools strip `model` and `type`
- built-in tools preserve properties
- built-in tool `model` strips provider prefixes like `cc/`
- prefixed built-in tool models do not reach Anthropic
- passthrough mode still applies this fix only when required to prevent Anthropic rejection

### Compression

- detected git diff uses matching filter
- matching filter failure falls back to smart truncation
- compression internal error returns original content
- compression logging failure does not stop request
- passthrough requests are not compressed by default

### Statistics

- stats success does not stop request
- stats failure does not stop request
- stats logging failure does not stop request
- Caveman stats failure does not stop request

### Proxy routing

- per-connection proxy overrides environment proxy
- environment proxy overrides relay/default behavior
- direct connection is used only after higher-precedence options do not apply
- passthrough still uses selected connection proxy settings

### DNS bypass

- bypass host uses external DNS
- external DNS failure does not fall back to system DNS
- outbound proxy allows proxy-side DNS resolution
- proxy DNS resolution is not used when no outbound proxy exists
- passthrough does not bypass DNS integrity rules

### Logging

- successful request is logged
- failed request is logged
- partially completed failed request is logged as failed/incomplete
- passthrough request is logged as passthrough
- logging failure does not break the request path

---

## Debugging Checklist

When runtime behavior does not match source:

1. Confirm the edited file is in the fork.
2. Clear `.next-cli-build` or at least `.next-cli-build/cache/webpack`.
3. Rebuild with `cd cli && npm run build`.
4. Confirm `/opt/homebrew/lib/node_modules/9router` is a symlink to the fork.
5. Launch server directly with `node .../app/server.js`.
6. Grep the compiled chunks for the expected code.
7. Confirm whether the request path is translated mode or passthrough mode.
8. Only then debug application logic.

Default assumption:

> If source looks right but behavior is wrong, the running server is probably stale, not using the fork, or taking a passthrough path instead of a translated path.

---

## Cursor Cloud specific instructions

### First-time setup (once per VM)

1. Copy env: `cp .env.example .env`
2. Set a writable data dir in `.env` (default example uses `/var/lib/9router`): `DATA_DIR=/workspace/.data`
3. Default login password is `INITIAL_PASSWORD` from `.env` (example: `change-me`; falls back to `123456` if unset)

### Run the server (production mode recommended)

`npm run dev` can hit a webpack + `better-sqlite3` bundling error on API routes that load `instrumentation.js` (symptom: `/api/health` returns 500, “Can't resolve 'fs'”). **Use production mode for full E2E verification:**

```bash
npm run build
PORT=20128 HOSTNAME=0.0.0.0 NEXT_PUBLIC_BASE_URL=http://localhost:20128 npm run start
```

Run in tmux for long-lived sessions. Do not use the `9router` CLI wrapper in headless/non-TTY environments; use `node cli/app/server.js` after `cd cli && npm run build` when testing the packaged CLI.

### Tests and lint

- Unit/integration tests (no live server): `npm test` from repo root (`vitest run --config tests/vitest.config.js`) — 1300+ tests, mostly mocked. `cd tests && npm test` also works but skips the shared config.
- Lint backend: `npm run lint:backend` from repo root (eslint over `src/lib`, `cli`, `open-sse`). Full repo: `npx eslint .` — repo has pre-existing warnings/errors.
- Opt-in live E2E: `RUN_E2E=1` with server on port 20128 (see `tests/README.md`)

### Hello-world verification

1. `curl http://localhost:20128/api/health` → `{"ok":true}`
2. Login: `POST /api/auth/login` with `{"password":"<INITIAL_PASSWORD>"}`
3. Create key: `POST /api/keys` with `{"name":"demo"}` (session cookie from login)
4. `GET /v1/models` with `Authorization: Bearer <key>` → OpenAI-compatible model list

### CLI fork workflow (Linux cloud VM)

macOS global-install symlink notes in “Critical Build and Deploy Gotchas” do not apply here. After editing `open-sse/` or CLI sources: `rm -rf .next-cli-build` (or full `.next-cli-build`), then `cd cli && npm run build`, and verify fixes in `cli/app/.next-cli-build/server/chunks`.