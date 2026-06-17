# Genesis Proxy — Bug Audit Report

8 opus finders + adversarial opus verification (default-refute).

**29 confirmed** / 53 found / 24 refuted across 8 subsystems.

Severity: {"high":6,"medium":11,"low":12}

---

## [1] HIGH — Redirect SSRF guard derives allowLoopback from the attacker-controlled redirect target, permitting redirect-to-loopback

- **File**: `open-sse/utils/proxyFetch.js:945-951`
- **Category**: SSRF | **Confidence**: high

**What's wrong**: In safeRedirectFetch, the per-hop SSRF check computes allowLoopback from the redirect TARGET host itself: `const allowLoopback = ["localhost","127.0.0.1","::1"].includes(nextHost.toLowerCase());` then calls `assertSafeResolvedHostname(nextHost, { allowLoopback })`. Because allowLoopback is true whenever the redirect target IS loopback, assertSafeResolvedHostname returns early (ssrfGuard.js line 43) and treats the loopback redirect as safe. A malicious/compromised upstream (or relay) can therefore 30x-redirect to http://localhost:<port>/ and pass the guard. The relay path (line 1146) re-issues via plain originalFetch with NO guarded dispatcher, so the connection actually lands on the router's own loopback (SSRF to internal/admin services). On the direct path the guarded dispatcher (getGuardedDispatcher) re-blocks 127.0.0.1 at connect, but only when the ORIGINAL host was non-loopback; a loopback-origin provider (ollama) redirecting to another localhost port reaches originalFetch with no guard (directIsLoopback closure stays true, line 1076), enabling a loopback port pivot. The intent (per the initial-request code at line 1063) is to allow loopback ONLY for explicitly-configured local providers, never for an arbitrary redirect target.

**Impact**: A malicious or on-path upstream/relay can force the server to issue requests to its own loopback services (admin endpoints, metadata-style local services, other localhost ports) by returning a 3xx Location of http://localhost/... — defeating the SSRF guard on the relay path and pivoting through localhost on the loopback-origin path.

**Evidence**:
```js
const nextHost = new URL(nextUrl).hostname;
    const allowLoopback = ["localhost", "127.0.0.1", "::1"].includes(nextHost.toLowerCase());
    try {
      await assertSafeResolvedHostname(nextHost, { allowLoopback });
    } catch (dnsError) {
      throw new Error(`[ProxyFetch] Redirect blocked by SSRF guard: ${dnsError.message}`);
    }
```

**Verifier**: Verified against actual code. The guard bypass is real: in safeRedirectFetch (proxyFetch.js:946-949) allowLoopback is derived from the redirect TARGET host (`["localhost","127.0.0.1","::1"].includes(nextHost.toLowerCase())`), and assertSafeResolvedHostname returns early at ssrfGuard.js:43 (`if (allowLoopback && LOOPBACK_HOSTNAMES.has(h)) return;`). So a 30x redirect to http://localhost:<port> passes the per-hop SSRF check.

The connection then actually lands on loopback on two reachable paths:
1) Loopback-origin provider pivot (e.g. ollama http://localhost:11434). Initial request sets directIsLoopback=true (line 1064-1065). The redirect is re-issued via the directFetch closure, which at line 1077 short-circuits to plain originalFetch with NO guarded dispatcher because directIsLoopback is true. A redirect to http://localhost:9999/... passes the bypassed guard and connects to that loopback port. shouldBypassMitmDns (line 263-268) only matches 7 enumerated production hosts (+Kiro), so localhost takes the normal path to line 1163 safeRedirectFetch(url, options, directFetch) — Path A is reachable.
2) Relay path (line 1147): safeRedirectFetch(vercelRelayUrl, ..., originalFetch) — fetchImpl is plain originalFetch with no guarded dispatcher; a relay redirect to loopback passes the guard and connects on the router host.

The connect-time guarded dispatcher (getGuardedDispatcher, line 1009-1027) which calls isBlockedHostname on the dialed IP (blocking 127.0.0.1 via isPrivateOrReservedIpv4 a===127, ssrfGuardCore.js:12) is ONLY attached in directFetch's non-loopback branch (line 1078-1086). It does not protect the directIsLoopback or relay paths.

I tried to refute via the dispatcher: it does defeat the auditor's loosely-stated "any provider redirects to localhost" scenario — when the original host is non-loopback, directIsLoopback=false, the dispatcher is attached, and 127.0.0.1 is blocked at connect (Path C). The auditor explicitly concedes this. So the bug is narrower than a blanket public→loopback SSRF, but it genuinely triggers on the loopback-origin-provider pivot and the relay path, both confirmed in code. The root defect — deriving allowLoopback from the attacker-controlled redirect target instead of from the originally-configured provider (intent at line 1063-1065) — is present and exploitable.

---

## [2] HIGH — Unbounded buffer growth in SSE transform when upstream sends no newline

- **File**: `open-sse/utils/stream.js:174-178`
- **Category**: memory | **Confidence**: high

**What's wrong**: In createSSEStream's transform(), every chunk is appended to `buffer` (buffer += text) and then split on "\n", with the last element retained as the new buffer (buffer = lines.pop()). If a malicious or broken upstream streams a large body containing no "\n" byte, split() produces a single element, lines.pop() puts the entire accumulated content back into `buffer`, and nothing is ever flushed or capped. Unlike sseToJsonHandler.js which guards every accumulation with appendCapped()/MAX_BLOCK_CHARS, the live streaming path (both translate and passthrough modes) has NO upper bound on `buffer`. The stall watchdog in pipeWithDisconnect only fires when NO bytes arrive for 30s — a steady stream of newline-free bytes keeps resetting it, so the watchdog never trips while memory climbs.

**Impact**: A compromised/MITM upstream (or a provider emitting a giant single-line payload) can drive proxy heap to OOM during an otherwise 'healthy' stream. Matches the threat-model item 'memory unbounded on large stream'.

**Evidence**:
```js
const text = decoder.decode(chunk, { stream: true });
      buffer += text;
      reqLogger?.appendProviderChunk?.(text);

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";   // entire payload retained if no \n ever arrives
```

**Verifier**: Confirmed against the actual code. In open-sse/utils/stream.js the TransformStream.transform (lines 173-178) does `buffer += text` then `const lines = buffer.split("\n"); buffer = lines.pop() || ""`. When upstream sends no "\n", split() returns a single-element array, pop() returns that whole element back into `buffer`, and `lines` is left empty so the `for (const line of lines)` loop (line 180) never executes — nothing is processed, enqueued, or freed. Grep confirms ZERO buffer-size guards in stream.js (no MAX_BLOCK_CHARS, appendCapped, length/byteLength check), for both PASSTHROUGH and TRANSLATE modes (the accumulation at 174-178 precedes the mode branch). The contrast the auditor draws is accurate: sseToJsonHandler.js:17,37-41 defines MAX_BLOCK_CHARS = 64MiB and appendCapped() that throws BlockSizeExceededError; the live streaming path has no equivalent. The watchdog defense fails as claimed: pipeWithDisconnect's upstreamTap.transform calls armStall() on every chunk (streamHandler.js:217), which clears and re-arms the 30s timer (STREAM_STALL_TIMEOUT_MS = 30*1000, runtimeConfig.js:35). A steady stream of newline-free bytes keeps resetting the timer, so the stall watchdog (which only fires on 30s of byte-silence — comments at 158-164 confirm it tracks raw upstream byte activity) never trips while `buffer` grows. I could not find any caller-side content-length cap or upstream size guard that prevents the accumulation. The trigger is concrete and reachable: a provider/upstream that streams a large body containing no newline. Severity stays high rather than critical because it requires a malicious or malfunctioning upstream (not ordinary client input) and growth is bounded by connection lifetime and Node's max string/heap size, but it is a genuine unbounded-buffer memory-exhaustion path with no cap and no watchdog backstop.

---

## [3] HIGH — responsesTransformer collides reasoning, message, and tool-call items onto output_index 0 → dropped tool calls

- **File**: `open-sse/transformer/responsesTransformer.js:99-262 (esp. 104,114,174,185,194,213,222,229,248,254)`
- **Category**: schema/Responses-API output_index collision | **Confidence**: high

**What's wrong**: This TransformStream uses the chat-completions choice index `idx` (always 0 for single-choice streams) as the Responses-API `output_index` for the reasoning item (startReasoning: state.reasoningIndex = idx), the message item (emitTextDelta/closeMessage use output_index: idx / parseInt(idx)), AND every tool call (tool_calls path uses output_index: tcIdx where tcIdx = tc.index ?? 0). Responses-API output_index must be the monotonic slot in output[], distinct per item. The sibling translator open-sse/translator/response/openai-responses.js fixes exactly this with allocOutputIndex() and an explicit comment that 'strict Responses clients (Codex/Cursor) reject duplicate output_index → dropped tool call'; this transformer was never updated.

**Impact**: When a turn contains reasoning + text + a tool call (or two parallel tool calls), they all emit output_index 0. Strict Responses clients (Codex/Cursor) reject the duplicate output_index, so the tool call and/or message item is dropped — the proxied response loses the tool call entirely. The downstream stream-to-JSON converter also overwrites items sharing an index (it only special-cases differing item.id at the same slot, but here it can clobber a reasoning item with a message item at index 0).

**Evidence**:
```js
const startReasoning = (controller, idx) => { ... state.reasoningIndex = idx; emit(... output_index: idx ...) }  // idx===0
const emitTextDelta = (controller, idx, content) => { ... emit(... output_index: idx ...) }  // idx===0
for (const tc of delta.tool_calls) { const tcIdx = tc.index ?? 0; ... emit('response.output_item.added', { output_index: tcIdx, ... }) }  // tcIdx===0
```

**Verifier**: Confirmed by reading the code. In responsesTransformer.js, output_index is taken from the chat-completions choice index `idx = choice.index ?? 0` (line 318) for the reasoning item (startReasoning sets state.reasoningIndex = idx and emits output_index: idx at lines 99,103,114,128,142,149,157), the message item (emitTextDelta/closeMessage emit output_index: idx / parseInt(idx) at lines 174,185,194,213,222,229), and tool calls use tcIdx = tc.index ?? 0 (line 404) emitting output_index: tcIdx at lines 415,434,248,254. For a normal single-choice stream idx is always 0 and the first tool call's tc.index is 0, so reasoning, message, and the tool-call output items are ALL stamped output_index: 0. No guard reassigns these — closeMessage(controller, idx) at line 401 keeps the same idx; nothing allocates a monotonic slot. The sibling translator open-sse/translator/response/openai-responses.js implements exactly the fix: allocOutputIndex(state) returns a distinct monotonic index per item (state.reasoningIndex via allocOutputIndex line 147, state.msgOutputIndex[idx] line 219, state.funcOutputIndex[tcIdx] line 304), with an explicit comment (lines 133-137) that reusing idx/tcIdx collides them and 'strict Responses clients (Codex/Cursor) reject duplicate output_index → dropped tool call.' This confirms the design contract: output_index must be the monotonic output[] slot, distinct per item — and this transformer violates it. The defect (colliding output_index across distinct items) is concretely present and triggers on the standard single-choice reasoning+tool-call or text+tool-call path. The only part not directly executable here is the downstream strict-client rejection that turns the collision into a *dropped* tool call; that behavior is asserted by the codebase's own comment rather than reproduced, but the code-level collision the claim describes is real.

---

## [4] HIGH — Raw API keys persisted in plaintext inside usageDaily JSON blob (and usageHistory.apiKey column)

- **File**: `src/lib/db/repos/usageRepo.js:72-74, 293-299, 317`
- **Category**: leak | **Confidence**: high

**What's wrong**: aggregateEntryToDay() embeds the real API key string into the day rollup via addToCounter(day.byApiKey, akModelKey, { ...vals, meta: { ..., apiKey: entry.apiKey || null } }). That day object is then written verbatim to usageDaily.data with db.run(INSERT ... usageDaily ... excluded.data). The full secret key is therefore stored at rest in the usageDaily blob (which is loaded wholesale in getUsageStats/getChartData with parseJson and never redacted before storage). The usageHistory INSERT also stores entry.apiKey directly in the apiKey column. Although read paths null out apiKey on return (apiKey: null) and getUsageStats remaps to a safe display key via safeApiKeyInfo, the on-disk SQLite file contains the plaintext API keys indefinitely.

**Impact**: Anyone with read access to the data.sqlite file (backups, the periodic backup dir, support bundles, a leaked DB) recovers live caller API keys in cleartext. The display-time redaction gives a false sense the keys are not stored.

**Evidence**:
```js
addToCounter(day.byApiKey, akModelKey, { ...vals, meta: { rawModel: entry.model, provider: entry.provider, apiKey: entry.apiKey || null } });  ...  db.run(`INSERT INTO usageDaily(dateKey, data) VALUES(?, ?) ON CONFLICT(dateKey) DO UPDATE SET data = excluded.data`, [dateKey, stringifyJson(day)]);
```

**Verifier**: Confirmed by reading src/lib/db/repos/usageRepo.js. Two real at-rest writes persist the raw API key in plaintext: (1) line 74 embeds `apiKey: entry.apiKey || null` into the day rollup via addToCounter, which at line 42 does `Object.assign(target[key], values.meta)`, storing the real key string into day.byApiKey[akModelKey].apiKey; that entire `day` object is then serialized verbatim at line 317 into usageDaily.data (`stringifyJson(day)`). (2) lines 293-296 INSERT `entry.apiKey || null` directly into the usageHistory.apiKey column. Both run inside saveRequestUsage's transaction, the production write path for every proxied request, with no hashing, encryption, or redaction before storage. The redaction logic the description cites (getUsageHistory line 381 `apiKey: null`, ensureRingInitialized line 109, and safeApiKeyInfo remapping at lines 561/564/606/672/675) only sanitizes values on READ/return — it does not affect what is written to disk, and in fact confirms the authors treat the key as sensitive. So the on-disk SQLite file holds the plaintext keys indefinitely. Trigger is unconditional for any request whose entry.apiKey is a non-null string. Severity adjusted to high (not critical): the leaked values are this router's own API keys in a local SQLite file (local-disk-access blast radius), not upstream provider credentials exfiltrated over the network.

---

## [5] HIGH — Root CA private key written world-readable (no file mode / no umask hardening)

- **File**: `src/mitm/cert/rootCA.js:89-90`
- **Category**: key-exposure | **Confidence**: high

**What's wrong**: generateRootCA() writes the CA private key with fs.writeFileSync(ROOT_CA_KEY_PATH, privateKeyPem) and NO mode option. The file is created with the default 0o666 masked by process umask (commonly 0o644 → world-readable, group-readable). The containing dir is created with fs.mkdirSync(MITM_DIR, { recursive: true }) (rootCA.js:40) — also no restrictive mode. MITM_DIR is ~/.genesis/mitm (paths.js:30), a path readable by every local user on a shared/multi-user host or any process running as another uid. There is no chmod(0o600) anywhere on ROOT_CA_KEY_PATH.

**Impact**: Any local user or low-priv process can read rootCA.key. Because this CA is installed into the system + browser/NSS trust stores (cert/install.js), the attacker can sign a leaf for ANY domain (e.g. *.google.com, bank, github) and transparently MITM all of the victim's TLS, not just IDE traffic. Full break of the machine's trust anchor.

**Evidence**:
```js
const privateKeyPem = forge.pki.privateKeyToPem(keys.privateKey);
...
fs.writeFileSync(ROOT_CA_KEY_PATH, privateKeyPem);   // no { mode: 0o600 }
fs.writeFileSync(ROOT_CA_CERT_PATH, certPem);
```

**Verifier**: Confirmed by reading src/mitm/cert/rootCA.js. Line 89 writes the CA private key with `fs.writeFileSync(ROOT_CA_KEY_PATH, privateKeyPem)` and NO mode option — created with default 0o666 masked by umask (commonly → 0o644, world/group-readable). MITM_DIR is created at line 40 via `fs.mkdirSync(MITM_DIR, { recursive: true })` with no restrictive mode. paths.js confirms MITM_DIR resolves to ~/.genesis/mitm on Unix (os.homedir() + .genesis + mitm). generateRootCA is reachable — called from src/mitm/cert/generate.js:11. There is no chmod/umask hardening anywhere on ROOT_CA_KEY_PATH; a repo-wide grep for chmod/0o600/mode found NONE in rootCA.js. The codebase demonstrably knows the correct pattern — it applies `mode: 0o600` to mitmEnvFile (manager.js:694), MACHINE_ID_FILE, CLI_SECRET_FILE, apiKeySecret, and dashboardSession — so the CA key is an inconsistent omission, not an unknown technique. Impact: the CA private key lets anyone who reads it forge certs for any domain and decrypt that user's MITM-intercepted TLS. The exact trigger fires on first run / cert regeneration on any host where umask permits group/other read (shared hosts, CI, multi-uid containers, home dirs created 0o755). One mitigating nuance: on single-user desktops where the home dir is 0o700, directory-traversal perms can block access despite the file mode — but the code does not enforce that (mkdirSync doesn't set 0o700 on MITM_DIR), so it cannot be relied upon. Bug genuinely exists and triggers.

---

## [6] HIGH — Upstream TLS certificate validation globally disabled (rejectUnauthorized:false on every forward)

- **File**: `src/mitm/server.js:172, 205, 299`
- **Category**: tls-validation | **Confidence**: high

**What's wrong**: Every outbound connection the proxy makes to the REAL upstream sets rejectUnauthorized:false: the ALPN probe (negotiateAlpn, line 172), the HTTP/2 passthrough createConnection (passthroughHttp2, line 205), and the HTTP/1.1 fallback (passthroughHttps, line 299). The proxy terminates the IDE's TLS (decrypting auth tokens / source code) and re-originates a connection to an IP it resolved itself — but never verifies the upstream server's certificate or hostname. checkServerIdentity is never set. No CA pinning, no SPKI pinning.

**Impact**: An attacker who can spoof DNS (see resolveTargetIP) or BGP/ARP-redirect the egress path receives the fully-decrypted IDE traffic — OAuth tokens, API keys, prompts, repo contents — and the proxy will not detect it because it accepts ANY certificate (including self-signed) from the upstream. The MITM that exists to protect the user becomes a downgrade: real-endpoint TLS is no longer enforced for the user's most sensitive data.

**Evidence**:
```js
// negotiateAlpn
const socket = tls.connect({ host: ip, port: 443, servername: host,
  ALPNProtocols: ["h2", "http/1.1"], rejectUnauthorized: false, }, ...)
// passthroughHttp2
createConnection: () => tls.connect({ host: targetIP, port: 443, servername: targetHost,
  ALPNProtocols: ["h2"], rejectUnauthorized: false, }),
// passthroughHttps
const forwardReq = https.request({ hostname: targetIP, ... servername: targetHost,
  rejectUnauthorized: false });
```

**Verifier**: Confirmed by reading src/mitm/server.js in full. All three literal claims are accurate: rejectUnauthorized:false is set on the ALPN probe (line 172, tls.connect to resolved IP with servername:host), the HTTP/2 passthrough createConnection (line 205, tls.connect inside http2.connect), and the HTTP/1.1 fallback https.request (line 299). checkServerIdentity is never set at any of the three sites, and there is no CA/SPKI pinning anywhere in the file. These are NOT dead code: passthrough() is the proxy's core forward path, invoked from the request handler at lines 357/361/363/368/377/382 for every non-intercepted, internal-source, and fallback request. passthrough()→negotiateAlpn (172)→passthroughHttp2 (205) or passthroughHttps (299). resolveTargetIP (line 83) resolves the upstream via DNS 8.8.8.8 and connects to the raw IP with servername:targetHost, so the proxy never verifies the upstream cert or hostname. The only adjacent guard, isBlockedHostname (line 96), is an SSRF check for private IPs and does nothing for cert validation. No NODE_TLS_REJECT_UNAUTHORIZED or global agent re-enables it. The proxy terminates the IDE's TLS (decrypting auth tokens/source code) and re-originates without validating the upstream — an active on-path attacker between proxy and upstream could MITM the upstream leg undetected. Downgrading severity to high (not critical): this is opt-in local tooling that installs its own root CA and terminates TLS by design; the trigger requires a network-adjacent active attacker, and exposure is bounded to the upstream-leg confidentiality.

---

## [7] MEDIUM — Relay redirect path re-issues with unguarded originalFetch (no connect-time SSRF/rebind guard)

- **File**: `open-sse/utils/proxyFetch.js:1136-1147`
- **Category**: SSRF/rebind | **Confidence**: high

**What's wrong**: The vercel/relay branch calls `safeRedirectFetch(vercelRelayUrl, { ...options, headers: relayHeaders }, originalFetch)`. Unlike the direct branch (which passes directFetch wrapping getGuardedDispatcher to re-validate the actual connect IP and close the DNS-rebind TOCTOU window), the relay branch hands raw originalFetch as fetchImpl. assertSafeResolvedHostname validates the relay hostname's DNS once (line 1145), but undici then re-resolves independently at connect with no connect-time recheck, and any redirect followed by safeRedirectFetch on this branch is likewise connected via unguarded originalFetch. Combined with the allowLoopback-from-target defect above, a relay-returned redirect to loopback or a rebound private IP is connected without a connect-time block.

**Impact**: DNS-rebind TOCTOU on the relay egress path and, together with the allowLoopback defect, redirect-to-loopback reaching the router's own internal services. The credential-stripping on cross-origin redirect only fires when origin changes, so same-host rebinds keep forwarding x-relay-auth/Authorization.

**Evidence**:
```js
await assertSafeResolvedHostname(new URL(vercelRelayUrl).hostname, { allowLoopback: false });
    return safeRedirectFetch(vercelRelayUrl, { ...options, headers: relayHeaders }, originalFetch);
```

**Verifier**: Confirmed by reading proxyFetch.js and ssrfGuard.js. The vercel/relay branch at line 1147 calls `safeRedirectFetch(vercelRelayUrl, { ...options, headers: relayHeaders }, originalFetch)` — passing raw `originalFetch` as fetchImpl. This is the ONLY egress branch that omits `directFetch` (lines 1076-1087), the wrapper that attaches `getGuardedDispatcher()`. Every sibling branch passes the guarded path: no_proxy (1134), proxy (1153/1159 fallback), and final direct (1163). The guarded dispatcher (lines 1001-1035) is the codebase's explicit connect-time DNS-rebind fix: its custom `lookup` re-asserts `isBlockedHostname` on the ACTUAL connect IP, closing the TOCTOU window that the comment at lines 992-999 describes. The relay branch bypasses it entirely.

The redirect concern is also confirmed: `safeRedirectFetch` (929-987) re-validates each hop with `assertSafeResolvedHostname` (line 949) but issues the connect via the same passed `fetchImpl` (line 930) — i.e. unguarded `originalFetch` on this branch. assertSafeResolvedHostname (ssrfGuard.js 38-76) only checks a snapshot resolution; the actual undici connect re-resolves with no recheck. So the connect-time rebind window the project engineered against is open on the relay branch for both the relay URL and relay-returned redirects. The loopback amplifier is real too: line 947 computes `allowLoopback` from the redirect target's literal hostname, and ssrfGuard line 43 returns early for loopback names — so a relay-returned 302 to http://127.0.0.1/... passes the guard and is connected via unguarded originalFetch.

Where the claim overstates the trigger: `vercelRelayUrl` is operator-configured (proxyOptions.vercelRelayUrl, line 1093), not attacker-derived, and is validated allowLoopback:false at line 1146. So an external attacker cannot steer this branch to metadata/loopback via the relay URL itself — exploitation requires either DNS-rebind control over the operator's trusted relay hostname, or the trusted relay (or an upstream it forwards) returning a malicious 3xx. That is a real but narrower precondition than generic attacker-controlled SSRF. The structural defense-in-depth gap is genuine and verifiable; the practical trigger depends on a hostile-or-rebinding relay endpoint, consistent with medium severity.

---

## [8] MEDIUM — Loopback-origin direct requests skip the connect-time guarded dispatcher, reopening rebind/loopback pivot on redirect

- **File**: `open-sse/utils/proxyFetch.js:1075-1086`
- **Category**: SSRF/rebind | **Confidence**: high

**What's wrong**: directFetch short-circuits to unguarded originalFetch whenever directIsLoopback is true. directIsLoopback is a closure value computed ONCE from the original target host (line 1059-1064). When safeRedirectFetch follows a redirect from a loopback-origin provider to a different host, it re-invokes this same directFetch; directIsLoopback remains true, so the redirected request (to a possibly different localhost port, or — across the DNS cache window — a rebound address) is issued via originalFetch with no connect-time isBlockedHostname recheck. The per-hop assertSafeResolvedHostname runs, but it caches DNS for 60s (ssrfGuardCore/ssrfGuard) and undici re-resolves at connect, so the rebind window the guarded dispatcher was built to close is reopened for loopback-origin chains.

**Impact**: A malicious local provider endpoint (e.g. a user-configured ollama/searxng base URL pointed at attacker-controlled DNS) can redirect to scan/reach other loopback ports or exploit a rebind to a private address that the guarded dispatcher would otherwise block at connect.

**Evidence**:
```js
const directFetch = async (u, o) => {
    if (directIsLoopback) return originalFetch(u, o);
    let dispatcher;
    try {
      dispatcher = await getGuardedDispatcher();
    } ...
    return originalFetch(u, { ...o, dispatcher });
  };
```

**Verifier**: Confirmed in code. `directIsLoopback` is computed ONCE from the original target host (proxyFetch.js:1060-1065) and captured in the `directFetch` closure. `directFetch` short-circuits to the unguarded global fetch whenever that flag is true (`if (directIsLoopback) return originalFetch(u, o);`, line 1077), and `originalFetch = globalThis.fetch` (line 11) — undici re-resolves the hostname at connect with NO connect-time dispatcher.

`safeRedirectFetch` (line 925) reuses the SAME `fetchImpl` (i.e. the same `directFetch` with its frozen `directIsLoopback`) for every redirect hop in its loop (line 930). So when a loopback-origin direct request (default path, line 1163 `safeRedirectFetch(url, options, directFetch)`, used for ollama/searxng) follows a 3xx redirect to a different, non-loopback host, hop 2 is still issued via `originalFetch` unguarded even though `directIsLoopback` should logically be false for that host.

The per-hop guard at line 947-949 does run `assertSafeResolvedHostname(nextHost, {allowLoopback})`, but ssrfGuard.js:50-68 caches the resolution for 60s (DNS_RESOLVE_CACHE_TTL_MS) and the guarded dispatcher's own comment (proxyFetch.js:992-999) states precisely why that check is insufficient: undici re-resolves independently at connect, creating a rebind TOCTOU window that ONLY the connect-time `lookup`/`isBlockedHostname` re-check (line 1011-1023) closes. By short-circuiting past `getGuardedDispatcher()` for loopback-origin chains, that connect-time recheck is skipped on the redirected hop, reopening the rebind window the dispatcher exists to close. `isBlockedHostname` (ssrfGuardCore.js:101-112) does block metadata/private ranges, confirming the dispatcher's recheck is a real, non-redundant defense.

Honest scoping: the literal/cached redirect target IS checked per hop, so a redirect pointing statically at a private IP is blocked; the genuine gap is the rebind sub-case where a public hostname passes the cached guard then resolves to a private IP at undici connect. The loopback→other-loopback-port sub-case is NOT a real new exposure (loopback is allowed by design on both the short-circuit and the guarded dispatcher). Trigger requires a loopback provider emitting an attacker-influenced 3xx to a public host plus rebind timing — a chained precondition, not one-shot SSRF — which is why medium (defense-in-depth gap against DNS rebind) is the correct severity rather than high.

---

## [9] MEDIUM — `invalid_request` misclassified as an unrecoverable token error, permanently disabling connections on a transient/malformed-request failure

- **File**: `open-sse/services/tokenRefresh.js:91-103, 107-116`
- **Category**: logic | **Confidence**: high

**What's wrong**: `parseOAuthRefreshErrorBody` (line 91-97) and `isUnrecoverableRefreshError` (line 107-115) both treat OAuth error code `invalid_request` as an unrecoverable, re-auth-required state alongside genuine token-invalidation codes (`invalid_grant`, `refresh_token_reused`, `token_expired`, `invalid_token`). Per RFC 6749 §5.2, `invalid_request` means the request was malformed (missing/duplicated parameter, etc.) — it is NOT a signal that the refresh token is dead. Downstream, an unrecoverable result causes the connection to be hard-disabled: src/sse/services/tokenRefresh.js:234-245 sets `testStatus:'error'` with lastError, and chatCore.js:659-667 returns 401 telling the user to re-authenticate. A transient provider hiccup or a client-side body-encoding bug that yields `invalid_request` therefore bricks an otherwise-valid connection instead of being retried. Note xai treats the same code as a recoverable {error:'invalid_grant'} signal (line 31), so behavior is inconsistent across providers.

**Impact**: A single malformed-request or transient `invalid_request` response permanently marks the connection unusable (testStatus:'error'), excluding it from credential selection until the user manually re-authenticates — a valid refresh token is discarded. Availability/usability loss, not an exploitable breach.

**Evidence**:
```js
if (
  errorCode === "refresh_token_reused" ||
  errorCode === "invalid_grant" ||
  errorCode === "token_expired" ||
  errorCode === "invalid_token" ||
  errorCode === "invalid_request"   // line 96 — RFC6749 transient/malformed, not token death
) { ... return { error: "unrecoverable_refresh_error", code: errorCode }; }
```

**Verifier**: Confirmed in code. In /Users/justinadams/Downloads/9router-fork/open-sse/services/tokenRefresh.js, parseOAuthRefreshErrorBody (lines 91-103) lists errorCode === "invalid_request" alongside invalid_grant/token_expired/invalid_token and returns {error:"unrecoverable_refresh_error", code}. isUnrecoverableRefreshError (lines 107-116) independently treats error === "invalid_request" as unrecoverable. The parser (line 88) reads both parsed.error.code and the top-level string form parsed.error, so a real RFC 6749 §5.2 body {"error":"invalid_request"} matches the string branch and reaches the unrecoverable return.

Trigger is reachable: parseOAuthRefreshErrorBody is invoked on every !response.ok refresh failure in refreshAccessToken (line 159) and refreshClaudeOAuthToken (line 213), with no provider guard or pre-filter that excludes invalid_request. The refreshWithRetry(3) wrapper does not rescue it — an unrecoverable result halts retries.

Downstream consequences cited are accurate: open-sse/handlers/chatCore.js:659-667 returns HTTP 401 "token refresh rejected. Re-authenticate this connection"; src/sse/services/tokenRefresh.js:234-245 sets testStatus:"error" + lastError and marks the connection permanently unusable (excluded from credential selection). So a transient/malformed invalid_request hard-disables an otherwise-valid connection. RFC 6749 §5.2 indeed defines invalid_request as a malformed-request error, not refresh-token death — the categorization is semantically wrong.

Corroboration that this codebase itself treats invalid_request as a malformed-request signal (not token death): src/lib/oauth/providers.js:659 emits {error:"invalid_request", error_description:"Missing nonce/verifier"}.

One correction to the claim: xai (line 31) maps invalid_request -> {error:"invalid_grant"}, and invalid_grant is ALSO unrecoverable per line 114, so xai is not actually "recoverable" — but the cross-provider code-path divergence the claim flags is still real.

Severity caveat: the refresh POST is server-constructed with fixed params (lines 149-154), so a client-side malformed invalid_request is unlikely in steady state; the realistic trigger is a transient/provider-quirk invalid_request response. Lower-probability than invalid_grant but genuinely reachable. Medium severity is correct.

---

## [10] MEDIUM — Tool-call SSE assembled to JSON gets finish_reason "stop" instead of "tool_calls"

- **File**: `open-sse/handlers/chatCore/sseToJsonHandler.js:409, 446-461`
- **Category**: logic | **Confidence**: high

**What's wrong**: parseSSEToOpenAIResponse initializes finishReason = "stop" and only overwrites it when a chunk carries choice.finish_reason (line 422). A provider can legitimately accumulate tool_call deltas and terminate the stream with a bare `data: [DONE]` sentinel and never set finish_reason on any choice. In that case sawTerminal becomes true (via [DONE]), the function passes the completion gate, and emits choices[0].finish_reason = "stop" even though message.tool_calls is populated (line 452-454). handleForcedSSEToJson's standard Chat-Completions path returns this `parsed` object directly to the client (line 687, returned at line 748) WITHOUT the tool-calls finish_reason correction that nonStreamingHandler.js:463-469 applies on its own path.

**Impact**: Clients that gate tool execution on finish_reason === "tool_calls" (most OpenAI-compatible agent loops) will treat the response as a normal stop and silently drop the tool call — the assistant's requested tool invocation never runs.

**Evidence**:
```js
let finishReason = "stop";
...
if (choice?.finish_reason) { finishReason = choice.finish_reason; sawTerminal = true; }
...
if (toolCallMap.size > 0) {
  message.tool_calls = [...].map(([, tc]) => tc);
}
...
choices: [{ index: 0, message, finish_reason: finishReason }]  // "stop" even with tool_calls
```

**Verifier**: Confirmed by reading the actual code. parseSSEToOpenAIResponse (sseToJsonHandler.js) initializes `finishReason = "stop"` (line 409) and only overwrites it when a chunk carries `choice.finish_reason` (line 422). Critically, the `[DONE]` sentinel sets `sawTerminal = true` WITHOUT touching finishReason (line 392). So a stream that accumulates tool_call deltas (lines 426-437) and terminates with only `data: [DONE]` passes the completion gate at line 446, populates `message.tool_calls` (lines 452-454), and emits `choices[0].finish_reason = "stop"` (line 461) despite tool_calls being present.

The differential is real and verified: parseSSEToOpenAIResponse has two callers. (1) nonStreamingHandler.js:363 — followed by an explicit tool_calls correction at lines 463-469 (`if (hasToolCalls && choice.finish_reason !== "tool_calls") choice.finish_reason = "tool_calls"`). (2) sseToJsonHandler.js:687 inside handleForcedSSEToJson's standard Chat-Completions branch — which returns `parsed` directly at line 748 with NO such correction. The two paths are genuinely distinct, not one delegating to the other.

The trigger is reachable in real execution: handleForcedSSEToJson is invoked at chatCore.js:808 when `!clientRequestedStreaming && providerRequiresStreaming`. providerRequiresStreaming is true for real providers openai/codex/commandcode (line 146), and clientRequestedStreaming is false for a plain non-streaming client request (line 145). The non-passthrough standard path (lines 682-748) applies in that case. No upstream guard rewrites finish_reason on this branch.

The only condition limiting it to medium (not high): it requires a provider that emits tool_call deltas but never sets finish_reason on any choice, terminating with a bare [DONE]. OpenAI's canonical stream emits `finish_reason: "tool_calls"` on a chunk (caught at line 422), so the bug only triggers with OpenAI-compatible providers that omit it — a legitimate but non-universal provider behavior. That conditional trigger justifies medium severity exactly as claimed.

---

## [11] MEDIUM — Passthrough flush re-emits a trailing partial SSE frame as if it were complete

- **File**: `open-sse/utils/stream.js:317-329`
- **Category**: stream | **Confidence**: high

**What's wrong**: In PASSTHROUGH flush, whatever remains in `buffer` (the last line that had no terminating \n) is force-emitted to the client: processPassthroughDataLine(buffer.trim()) is called, then the raw buffer is normalized and enqueued, and the code appends "\n\n" to make it look like a well-formed event (lines 324-326). If the upstream connection was cut mid-frame, `buffer` holds a TRUNCATED `data: {partial json` fragment. processPassthroughDataLine swallows the JSON.parse failure (catch {} at line 167), so sawTerminal stays false (clean:false is recorded correctly), BUT the truncated fragment is still written to the client byte-stream with a fabricated \n\n terminator. The client receives a malformed/partial JSON SSE frame presented as a complete event rather than the stream simply ending.

**Impact**: On mid-frame upstream disconnect in passthrough mode, the client is handed a truncated JSON SSE event dressed up as a complete frame, which can desync a strict SSE/JSON client parser. Threat-model items 'partial/truncated JSON returned to client' and 'buffer not flushed cleanly on close'.

**Evidence**:
```js
if (buffer.trim()) {
  processPassthroughDataLine(buffer.trim());
  let output = buffer;
  ...
  if (!output.endsWith("\n\n")) {
    output += output.endsWith("\n") ? "\n" : "\n\n";   // fabricated terminator on a partial frame
  }
  controller.enqueue(sharedEncoder.encode(output));
}
```

**Verifier**: Verified against open-sse/utils/stream.js. All claimed mechanics are present and reachable:

1. Buffer carry-over (line 178): `buffer = lines.pop() || ""` retains the last line that had no terminating \n. On an upstream connection cut mid-frame, this buffer holds a truncated `data: {partial json` fragment.

2. Force-emit in PASSTHROUGH flush (lines 318-329): `if (buffer.trim())` is the ONLY gate. There is no validation that the fragment is a complete or parseable SSE frame. The raw `buffer` is normalized (lines 321-323) and unconditionally `controller.enqueue`d (line 328).

3. Fabricated terminator (lines 324-326): if `output` doesn't end with "\n\n", the code appends "\n" or "\n\n", making the truncated fragment appear on the wire as a well-formed, complete SSE event.

4. Swallowed parse failure (processPassthroughDataLine, lines 123-167): `try { JSON.parse(payload) ... } catch {}`. A truncated JSON fragment throws, so markTerminalFromParsed never runs and `sawTerminal` stays false. clean:false is therefore recorded correctly at line 355 — usage accounting stays honest — but this does NOT prevent the enqueue at line 328. The two concerns are independent: sawTerminal gates usage logging and [DONE] emission, not the buffer flush.

Trigger reality: The TransformStream flush runs when the readable side ends, including an abrupt end from a cut upstream fetch body. The enqueue executes inside the flush try-block before any error path, and there is no abort-signal/sawTerminal guard before the emission. So when upstream is severed mid-frame, the client genuinely receives the truncated `data: {partial json` with a fabricated `\n\n`, presented as a complete event rather than the stream simply ending.

The code cannot distinguish a complete-but-unterminated final line (where this behavior is intentional) from a truncated mid-frame fragment — both take the identical path and both get the fabricated terminator. The bug exists as described.

---

## [12] MEDIUM — Usage persistence is fully best-effort: every DB failure is silently swallowed, dropping tokens/cost on error

- **File**: `src/lib/db/repos/usageRepo.js:330-332`
- **Category**: leak | **Confidence**: high

**What's wrong**: saveRequestUsage wraps the entire history+daily+lifetime transaction in try { ... } catch (e) { console.error('Failed to save usage stats:', e); }. Every caller additionally swallows the promise: usageTracking.js:355 saveRequestUsage(...).catch(() => {}) and requestDetail.js:118 Promise.resolve(saveRequestUsage(...)).catch(() => {}). A transient SQLite error (BUSY beyond the 5s busy_timeout, disk full, WAL checkpoint failure, sql.js debounced persist throwing) therefore discards that request's usage entirely with no retry, no queue, and no surfaced error. Combined with the no-op appendRequestLog (usageRepo.js:786) — which is the only thing called on the zero-usage branch — failed accounting is invisible.

**Impact**: Under DB contention or I/O failure, real billable usage is lost permanently and silently, under-reporting tokens and cost. There is no mechanism to detect or reconcile the gap.

**Evidence**:
```js
} catch (e) {
    console.error("Failed to save usage stats:", e);
  }   // <- entire transaction's failure is swallowed; callers also .catch(()=>{})
```

**Verifier**: Confirmed by reading the actual code. usageRepo.js:270-333 wraps the entire history-insert + daily-upsert + lifetime-counter db.transaction(...) in a single try/catch that ends at lines 330-332: `} catch (e) { console.error("Failed to save usage stats:", e); }`. better-sqlite3's synchronous db.transaction/db.run throw on SQLITE_BUSY, disk full, or persist failure; that throw is caught here, logged, and discarded. PRAGMA busy_timeout = 5000 (schema.js:11) confirms the "BUSY beyond 5s" trigger is the real timeout boundary. No retry, no queue, no dead-letter exists — getAdapter (driver.js:76-84) only memoizes the adapter and has no per-write recovery, and a repo-wide grep for retry/queue in the DB layer found none.

Both callers additionally swallow the promise, exactly as claimed (the auditor cited src/ paths but the real files are under open-sse/, with the cited line numbers correct): open-sse/utils/usageTracking.js:355 `saveRequestUsage({...}).catch(() => { });` and open-sse/handlers/chatCore/requestDetail.js:109-118 `Promise.resolve(saveRequestUsage({...})).catch(() => {});` inside a try/catch whose comment says "Usage persistence is optional; request handling must continue." So any error escaping the inner catch is silently dropped too.

The compounding claim also holds: appendRequestLog is an exported no-op (usageRepo.js:786 `export async function appendRequestLog() {}`) called with `.catch(() => { })` on every status branch (stream.js:344/420, chatCore.js:502/510/621/752/785/803), so the only durable accounting write is saveRequestUsage. When it fails, that request's tokens/cost/lifetime counter are lost with nothing surfaced beyond a console.error line.

Refutation attempt failed: there is no upstream guard, no transactional retry wrapper, no fallback persistence path, and no surfaced error channel. The exact trigger (transient SQLite write failure during saveRequestUsage) genuinely drops that request's usage. Only inaccuracy in the claim is the caller file paths (open-sse/, not src/), which does not affect whether the bug triggers.

---

## [13] MEDIUM — sql.js writes are persisted to disk asynchronously (debounced 100ms) — a crash inside the window loses committed usage, undermining the 'sync, no race' durability claim

- **File**: `src/lib/db/adapters/sqljsAdapter.js:31-46, 68, 103-118`
- **Category**: stream | **Confidence**: high

**What's wrong**: saveRequestUsage's comment asserts 'better-sqlite3 is sync -> no JS yield mid-transaction -> no race in same process'. That holds for better-sqlite3/node:sqlite/bun, but the sql.js fallback (selected when no native driver is available, driver.js:63) is an in-memory DB whose only durability is persist() writing db.export() to a file. run()/transaction() call scheduleSave(), which debounces the actual fs.writeFileSync by SAVE_DEBOUNCE_MS=100ms (and skips entirely while txDepth>0). A transaction therefore 'commits' in memory and returns success to saveRequestUsage, but the bytes are not on disk for up to 100ms. A process exit / crash / OOM inside that window loses the just-recorded usage even though the transaction reported success. flushPendingSave exists but is never called on the saveRequestUsage path; only beforeExit/SIGINT/SIGTERM flush, which do not fire on hard crashes.

**Impact**: On any deployment that falls back to the sql.js driver, recently recorded tokens/cost can vanish on restart/crash, silently under-counting. The durability guarantee implied by the in-code comment does not apply to this adapter.

**Evidence**:
```js
saveTimer = setTimeout(() => { ... if (dirty) { persist(); } ... }, SAVE_DEBOUNCE_MS);  // run() returns before this fires; transaction()->scheduleSave() also debounced
```

**Verifier**: Verified directly in code. The sql.js adapter is a real, reachable fallback: driver.js:63 selects createSqlJsAdapter when bun:sqlite, better-sqlite3, and node:sqlite all fail. sql.js is a pure in-memory WASM DB whose ONLY durability is persist() (sqljsAdapter.js:25-29) calling db.export() + fs.writeFileSync — there is no WAL/journal.

The deferral is confirmed: run() (line 61-73) and transaction() (line 103-118) both call scheduleSave() (line 31-46), which sets dirty=true and arms a setTimeout for SAVE_DEBOUNCE_MS=100ms before persist() runs. While txDepth>0, scheduleSave is a no-op (line 32); transaction() decrements txDepth to 0 BEFORE calling scheduleSave at line 111, so the timer does arm after the transaction body. run() returns its {changes, lastInsertRowid} synchronously at line 69 — before the timer fires. So the write is in memory and reported successful, but bytes hit disk up to 100ms later.

saveRequestUsage (usageRepo.js:270-291) carries exactly the quoted comment ('better-sqlite3 is sync → no JS yield mid-transaction → no race in same process', line 289) and wraps its 3 writes in db.transaction(() => { db.run(INSERT...); ... }). It returns immediately after the in-memory transaction; it never forces a flush. The comment's durability framing is correct for the native sync drivers but false for the sql.js fallback.

flushPendingSave (line 53-59) exists and is exported (line 132) but grep across src/ shows ZERO callers — only its definition and the export. The only synchronous-flush paths are close() (line 120-124) and the beforeExit/SIGINT/SIGTERM handlers (line 128-130). Those do not fire on SIGKILL, OOM, segfault, power loss, or process.abort() — so a hard crash inside the 100ms window loses a transaction that already reported success. Refutation attempts (path unreachable, hidden flush on save path, journal durability) all fail against the code.

Severity is fairly medium, not higher: the window is bounded (100ms), the loss is limited to usage/accounting rows (not auth or routing state), and sql.js is the last-resort driver only hit when all three native drivers are unavailable, so most deployments never use this path.

---

## [14] MEDIUM — Hardcoded 8.8.8.8 resolution with no DNSSEC / spoof detection feeds unvalidated upstream connection

- **File**: `src/mitm/server.js:83-101`
- **Category**: dns-spoof | **Confidence**: high

**What's wrong**: resolveTargetIP() creates a dns.Resolver, hardcodes servers to 8.8.8.8, and connects to addresses[0] over plaintext UDP:53 with no DNSSEC validation, no response-source checking, and no comparison against a known-good IP set. The only guard is isBlockedHostname(ip) (SSRF private-range filter, line 96) — which does NOT detect a spoofed PUBLIC IP. The first resolved IP is cached for 5 minutes (line 99), so a single successful spoof poisons the destination for the cache window. Because the subsequent tls.connect uses rejectUnauthorized:false, a spoofed public IP that answers TLS is connected to and trusted blindly.

**Impact**: Off-path attacker who can race/spoof a UDP DNS reply (or a malicious resolver on path to 8.8.8.8) redirects the proxy's upstream connection to an attacker-controlled host. Combined with rejectUnauthorized:false, the attacker silently receives all decrypted IDE traffic (tokens, code). The 5-min cache means one win sustains the redirect.

**Evidence**:
```js
const resolver = new dns.Resolver();
resolver.setServers(["8.8.8.8"]);
const resolve4 = promisify(resolver.resolve4.bind(resolver));
const addresses = await resolve4(hostname);
...
const ip = addresses[0];
if (isBlockedHostname(String(ip))) { throw ... }   // only blocks private IPs, not spoofed public IPs
cachedTargetIPs[hostname] = { ip, ts: Date.now() };
```

**Verifier**: Every concrete code assertion in the claim is verified in src/mitm/server.js. resolveTargetIP() (lines 83-101) builds `new dns.Resolver()`, calls `resolver.setServers(["8.8.8.8"])` (line 87), resolves via plaintext UDP:53 with `await resolve4(hostname)` (line 89), takes `addresses[0]` (line 95), and the ONLY validation is `isBlockedHostname(String(ip))` (line 96) — an SSRF private-range filter that by design rejects only private/internal IPs, not spoofed public ones. The result is cached for 5 minutes (line 99, CACHE_TTL_MS = 5*60*1000). There is no DNSSEC, no response-source/transaction-ID verification beyond Node's resolver defaults, and no comparison against a known-good IP set.

Crucially, I confirmed the resolved IP actually feeds the TLS connection and that cert validation is disabled, so a spoofed public IP is trusted blindly: negotiateAlpn() line 168-172 does `tls.connect({ host: ip, port: 443, servername: host, ... rejectUnauthorized: false })`, and passthroughHttp2() line 187 + 203-206 does `tls.connect({ host: targetIP, ... rejectUnauthorized: false })`. With rejectUnauthorized:false, the upstream certificate is never validated, so an attacker who wins the DNS answer to a public IP they control can complete the TLS handshake and receive the forwarded IDE traffic (which carries auth tokens — see headersForForwarding/bodyForForwarding in passthrough()).

Refutation attempts that FAILED: (1) I checked whether the resolved IP is unused/overridden downstream — it is not; both code paths connect to exactly the IP resolveTargetIP returns. (2) I checked whether isBlockedHostname or any other guard catches spoofing — it only blocks private ranges, so a spoofed PUBLIC IP passes. (3) I checked whether rejectUnauthorized was actually true somewhere — it is explicitly false in both tls.connect sites, removing the cert-pinning backstop that would otherwise neutralize a DNS spoof. So the cert check does NOT save this.

The claim is therefore technically real and triggers in real execution. Severity correction: the practical impact is bounded by a demanding threat model. This is a local MITM proxy intercepting the user's OWN outbound IDE traffic; exploiting it requires an active on-path/DNS-spoofing attacker positioned between the host and 8.8.8.8 (off-path UDP spoofing against a public resolver with source-port + txid randomization is hard but not impossible; on-path/rogue-DHCP/rogue-resolver is the realistic vector). That is the same network position that already lets an attacker tamper with much else. The compounding factor that keeps it above "low" is rejectUnauthorized:false: a correct TLS cert check would defeat the spoof, and its removal means a single spoofed answer is trusted and cached for 5 minutes, leaking forwarded auth tokens. Net: a real defense-in-depth gap, but contingent on a privileged network position rather than remotely triggerable by an arbitrary attacker — medium, not high.

---

## [15] MEDIUM — SNICallback mints a CA-signed leaf for ANY requested servername (no allowlist / host pinning)

- **File**: `src/mitm/server.js:50-65`
- **Category**: cert-minting | **Confidence**: high

**What's wrong**: sniCallback takes the attacker-controllable TLS SNI `servername` and unconditionally calls getCertForDomain(servername) → generateLeafCert, producing a CA-signed cert for whatever name was presented, then caches it. There is NO check that servername is one of TARGET_HOSTS / the intercepted tool hosts. The MITM server listens on 0.0.0.0:443 (server.listen(LOCAL_PORT) with LOCAL_PORT=443, no bind address → all interfaces). Any client that can reach port 443 — including other hosts on the LAN if the firewall allows — can drive the proxy to sign and serve leaf certs for arbitrary domains and to proxy traffic for them.

**Impact**: The proxy acts as an open signing oracle for the trusted CA: it will present a valid (CA-chained) cert for any domain a client asks for via SNI, then forward that traffic upstream with TLS validation disabled. Turns the local trust anchor into a generic interception service for any reachable client, well beyond the four intended IDE hosts.

**Evidence**:
```js
function sniCallback(servername, cb) {
  if (certCache.has(servername)) return cb(null, certCache.get(servername));
  const certData = getCertForDomain(servername);   // no TARGET_HOSTS check
  ...
  cacheSet(certCache, servername, ctx);
  cb(null, ctx);
}
// server.listen(LOCAL_PORT) with LOCAL_PORT = 443 — no host arg → binds 0.0.0.0
```

**Verifier**: Both factual claims are confirmed in the actual code. (1) src/mitm/server.js:50-65 sniCallback(servername, cb) takes the attacker-controllable TLS SNI servername and unconditionally calls getCertForDomain(servername) at line 53 with NO allowlist/TARGET_HOSTS check; getCertForDomain (cert/generate.js:18-30) calls loadRootCA()+generateLeafCert(domain, rootCA), producing a CA-signed leaf for any presented name, then caches it via cacheSet(certCache, servername, ctx) at line 59. The TLS handshake invokes this callback for every connection regardless of the later host-routing logic, so the cert minting is unconditional and triggers in real execution. (2) Bind address: LOCAL_PORT=443 (line 15), server.listen(LOCAL_PORT, cb) at line 434 passes no host arg, so Node binds all interfaces (0.0.0.0/::) — confirmed. I checked for guards: getToolForHost (config.js:102-108) and the request handler (lines 360-389) only gate which traffic gets intercepted vs passthrough — they do NOT gate SNI cert minting, which happens earlier at the TLS layer. resolveTargetIP added an SSRF guard (lines 94-98) but that only limits upstream forwarding targets, not cert minting. So no guard prevents the claimed trigger. Caveat lowering severity from high to medium: the minted certs are only trusted by clients that have installed this MITM root CA (an arbitrary external/LAN client won't trust them), and real exposure depends on firewall posture rather than a guaranteed cross-host exploit. But the bug as stated — no allowlist on SNI minting + 0.0.0.0 bind — genuinely exists and triggers.

---

## [16] MEDIUM — Leaf certs include an over-broad wildcard SAN (*.<domain>) beyond the requested host

- **File**: `src/mitm/cert/rootCA.js:153-159`
- **Category**: cert-scope | **Confidence**: high

**What's wrong**: generateLeafCert sets subjectAltName to BOTH the exact `domain` AND `*.${domain}`. When servername is e.g. `googleapis.com`, the minted cert is valid for `*.googleapis.com` — every subdomain. Cursor/Kiro hosts are typically already subdomains, so the wildcard one level up can over-cover sibling services. Because servername is attacker-controllable (see SNI finding) and the leaf is cached + CA-trusted, a single mint produces a cert covering an entire wildcard space.

**Impact**: Each interception produces a cert broader than the single host actually being proxied, expanding the blast radius if a leaf key + cert is ever captured (leaf private keys are returned in PEM from generateLeafCert and held in process memory / cert cache). A captured leaf for *.<domain> impersonates every subdomain, not just the one host.

**Evidence**:
```js
{ name: "subjectAltName", altNames: [
    { type: 2, value: domain },        // DNS
    { type: 2, value: `*.${domain}` }  // Wildcard
] }
```

**Verifier**: Confirmed by reading the live code. In /Users/justinadams/Downloads/9router-fork/src/mitm/cert/rootCA.js:153-159, generateLeafCert unconditionally sets subjectAltName to BOTH {type:2,value:domain} and {type:2,value:`*.${domain}`}. There is no guard, allowlist, or validation on the wildcard branch.

Trigger chain is real and reachable: server.js:48 sniCallback(servername) -> generate.js:18 getCertForDomain(servername) -> rootCA.js:116 generateLeafCert(domain, rootCA). The `servername` argument is the client-supplied TLS SNI value and flows through untouched — getCertForDomain does no filtering, and there is no comparison against TARGET_HOSTS anywhere in the path. So for servername="googleapis.com" the minted leaf carries SAN `*.googleapis.com`, covering every direct subdomain. The leaf is signed by the trusted Root CA (cert.sign(rootCA.key) at line 163; CA has basicConstraints cA:true) and the resulting secure context is cached per-servername (server.js certCache). So a single mint produces a CA-trusted cert covering an entire one-level wildcard space.

Caveats that bound severity rather than refute the bug: (1) the wildcard is exactly one level (`*.${domain}`), not arbitrary-depth — it does not cover deeper labels; (2) this is a local MITM proxy whose Root CA the user installs on their own machine, so the trust boundary is the user's host, and exploitation requires sending a chosen SNI to the local listener. The over-broad SAN is nonetheless a genuine defect: the cert is valid for far more names than the single requested host, with no per-host scoping. Medium severity is appropriate.

---

## [17] MEDIUM — Provider API key/token injected into URL query string (and unencoded) for authQuery providers

- **File**: `src/lib/models/fetchConnectionModels.js:695-696`
- **Category**: secret-leak | **Confidence**: high

**What's wrong**: For providers configured with authQuery (e.g. gemini: authQuery="key"), buildProviderModelsRequest appends the raw secret to the URL: url += `?${config.authQuery}=${token}`. The token is the Gemini API key. Putting a secret in the URL means it appears in any request/proxy/access logs and in the error-logging paths below. It is also not URL-encoded, so a token containing reserved characters would corrupt the query string.

**Impact**: API key exposure via URL logging (proxy logs, error console.log of the failed request context), plus potential malformed request if the key contains URL-reserved characters.

**Evidence**:
```js
} else if (config.authQuery) {
  url += `?${config.authQuery}=${token}`;
}
```

**Verifier**: The bug is real and reachable. PROVIDER_MODELS_CONFIG.gemini (line 209-215) sets `authQuery: "key"` with no authHeader. For a gemini connection, fetchModelsForConnection falls through the OpenAI/Anthropic-compatible branches to line 863 `config = PROVIDER_MODELS_CONFIG["gemini"]`, has no customResolver, and calls fetchProviderModelsWithConfig -> buildProviderModelsRequest. There, usesAnthropicAuth is false (provider is "gemini"), so the `else if (config.authQuery)` branch at line 695-696 executes: `url += `?${config.authQuery}=${token}``. The token comes from resolveAuthToken, where `config.authQuery === "key"` forces prefersApiKey=true (line 628), returning `connection.apiKey` raw (line 631) — the Gemini API key. No guard prevents reaching this branch, and there is NO encodeURIComponent on the token, so the raw secret is interpolated into the query string. The resulting url is passed to proxyAwareFetch (line 750), so the secret travels in the request URL — exposed to any intermediary proxy/access logs. The non-URL-encoding claim is also correct (reserved chars in the key would corrupt the query). One minor inaccuracy in the auditor's description: the error path at line 764 logs only `errorText`, NOT the URL, so the secret does not leak into that specific console.log. But the load-bearing claim — raw, unencoded API key placed in the URL query string — is fully confirmed. Medium severity is appropriate: it's a model-list fetch (Gemini's own documented auth style uses ?key=), the URL goes to HTTPS so it's encrypted in transit, but it can still surface in proxy/server access logs.

---

## [18] LOW — testProxyUrl passes user-supplied proxy URL to ProxyAgent without scheme/SSRF validation

- **File**: `src/lib/network/proxyTest.js:29-51`
- **Category**: validation | **Confidence**: high

**What's wrong**: testProxyUrl validates only the testUrl (via assertSafeFetchUrl) but feeds the user-supplied proxyUrl straight into `new ProxyAgent({ uri: normalizedProxyUrl })` with no scheme check, unlike connectionProxy.js validateProxyUrl which restricts to http:/https:. normalizeString only trims. The undici ProxyAgent constructor is the only thing rejecting non-http(s) schemes, so validation depends entirely on the library; there is no application-level allowlist or SSRF check on the proxy endpoint the server is asked to dial.

**Impact**: An authenticated user can ask the server to open a connection to an arbitrary host:port chosen as the 'proxy' (e.g. internal services on the ProxyAgent CONNECT/HTTP path) with only ProxyAgent's own scheme parsing as the gate, and error messages leak connection details (getErrorMessage surfaces cause.code/message).

**Evidence**:
```js
const normalizedProxyUrl = normalizeString(proxyUrl);
  ...
  try {
      dispatcher = new ProxyAgent({ uri: normalizedProxyUrl });
  } catch (err) { ... }
```

**Verifier**: Confirmed against the actual code. In src/lib/network/proxyTest.js:29-51, testProxyUrl runs only normalizeString(proxyUrl) (trim, lines 24-30) then `new ProxyAgent({ uri: normalizedProxyUrl })` inside a try/catch (lines 50-58). There is no scheme check and no destination/SSRF allowlist on proxyUrl. By contrast, src/lib/network/connectionProxy.js:11-26 validateProxyUrl restricts to SUPPORTED_PROXY_SCHEMES = {http:, https:}. So the cited inconsistency is real.

I tried to refute via the library safety net the auditor assumed, but it is weaker than claimed: the installed undici ProxyAgent constructor (node_modules/undici/lib/dispatcher/proxy-agent.js:95-262) only does `new URL(opts.uri)` in #getUrl and explicitly handles socks5:/socks: (lines 138, 161) plus http:/https:. It does not reject arbitrary schemes at construction, so the try/catch in proxyTest only catches URL-parse failures, not unsupported schemes. The undici layer does NOT enforce http(s)-only, so the missing application check genuinely lets socks5:/socks: (and other parseable schemes) through on this path while the connectionProxy path rejects them. This difference executes.

Two caveats that cap severity (consistent with the claimed 'low'): (1) all three callers — src/app/api/settings/proxy-test/route.js, src/app/api/proxy-pools/[id]/test/route.js, src/app/api/providers/[id]/test/testUtils.js — are gated behind requireSpawnRouteAuth, so this is an authenticated operator action, not anonymous. (2) The 'SSRF allowlist' framing is overstated: a proxy URL is by design a destination the server dials, and even the validated connectionProxy path permits internal hosts like http://127.0.0.1 (it checks scheme only, not destination), so no internal-IP guard exists on either path and its absence is consistent with the feature's purpose. The concrete, triggering defect is the scheme-validation inconsistency, which I could not refute; the broader SSRF characterization is weaker but the validation category and low severity are fair.

---

## [19] LOW — MITM bypass DNS path connects to externally-resolved IP without applying the upstream timeout to socket connect (HTTP/1.1)

- **File**: `open-sse/utils/proxyFetch.js:441-477`
- **Category**: timeout | **Confidence**: high

**What's wrong**: createBypassRequest establishes a raw net.Socket().connect(port, realIP) and relies solely on options.signal (the merged TTFB AbortController) for cancellation; there is no socket.setTimeout and no connect deadline independent of the caller signal. If UPSTREAM_TIMEOUT_MS is set to 0 (explicitly documented as disabling the timeout, line 894-897) or no signal is supplied, a stalled connect/handshake to the resolved bypass IP has no upper bound and hangs the request indefinitely. The HTTP/2 bypass path has its own 60s hangTimeout (line 664/682), but the HTTP/1.1 bypass path does not.

**Impact**: A bypass host whose externally-resolved IP black-holes the connection can hang the request with no independent timeout when the upstream timeout is disabled or absent, tying up the server-side request.

**Evidence**:
```js
socket.connect(port, realIP, () => {
      const reqOptions = { socket, ... };
      req = transport.request(reqOptions, (res) => { ... });
      req.on("error", fail);
      ...
    });
    socket.on("error", fail);
```

**Verifier**: Confirmed by reading proxyFetch.js:430-652. createBypassRequest (HTTP/1.1 bypass) calls socket.connect(port, realIP, ...) at line 478 with NO socket.setTimeout and NO independent connect deadline anywhere in the function. The only cancellation path is options.signal via onAbort/fail (lines 462-476). Trigger verification: proxyAwareFetch (1049) wraps options through withUpstreamTimeout, which by default (ms=120000) injects a merged TTFB AbortController signal into fetchOptions, then _proxyAwareFetch passes that as `options` to createBypassRequest at line 1127 — so in DEFAULT config the connect IS bounded at 120s and the bug does NOT trigger. However, withUpstreamTimeout lines 895-899 take an early return on ms<=0: when UPSTREAM_TIMEOUT_MS=0 it returns the original options with NO injected timeout signal (and emits the warning "stalled upstreams may hang indefinitely", asserted by tests/unit/wave4-auth-proxy-fixes.test.js:155-157). If the original caller also supplied no signal, createBypassRequest gets options.signal===undefined, the line 470 guard is skipped, and a stalled TCP/TLS connect to the resolved bypass IP hangs with no upper bound. The asymmetry the claim cites is also real: createHttp2BypassRequest (665, 683-687) has an independent HTTP2_BYPASS_TIMEOUT_MS=60000 setTimeout(hangTimeout) that fires regardless of options.signal, so the h2 path stays bounded at 60s even when UPSTREAM_TIMEOUT_MS=0; the HTTP/1.1 path has no equivalent. I could not refute the bug. Caveat lowering practical impact: the only trigger is an operator explicitly setting UPSTREAM_TIMEOUT_MS=0, which the code documents and warns about as intentional opt-out behavior — it is not a default-config hang. The claim's secondary phrasing "or no signal is supplied" is only true in conjunction with ms<=0, not on its own.

---

## [20] LOW — Refresh-token dedup cache retains plaintext refresh tokens in-memory indefinitely with no size bound or time sweep (stale-key leak)

- **File**: `open-sse/services/tokenRefresh.js:43-81`
- **Category**: leak | **Confidence**: high

**What's wrong**: `refreshDedupCache` (line 44) is a module-level Map whose keys embed the full plaintext refresh token (`${provider}:${oldToken}`, line 52). Entries are only evicted when that EXACT key is accessed again after its TTL (line 59-63) or on null/throw (line 71,75). Because refresh tokens rotate, a successful refresh stores an entry under the OLD token key that, once the new token is in use, is never read again — so its `expiresAt` is never checked and it is never deleted. There is no periodic sweep and no max-size cap (unlike loginLimiter.js which bounds its Map at MAX_ATTEMPTS_ENTRIES). Over a long-running process with many rotations, plaintext refresh tokens accumulate in heap memory beyond their useful life.

**Impact**: Unbounded growth of a Map holding plaintext, now-superseded refresh tokens in memory — increases secret exposure window in heap/core dumps and is a slow memory leak on long-lived servers. Not directly exploitable but widens the blast radius of any memory-disclosure bug.

**Evidence**:
```js
const refreshDedupCache = new Map();  // line 44, no max size
...
if (result != null) {
  refreshDedupCache.set(key, { result, expiresAt: Date.now() + REFRESH_RESULT_TTL_MS });  // line 69 — old-token key never revisited after rotation
} ... // eviction only on next access of the same (old) key
```

**Verifier**: Confirmed by reading open-sse/services/tokenRefresh.js. `refreshDedupCache` (line 44) is a module-level Map with no size cap and no time sweep — grep for setInterval/setTimeout/sweep/prune in the file returns zero matches, and the only callers of the clear function (__clearRefreshDedupCacheForTests) are test files (tests/unit/*.test.js), never production. Keys embed the full plaintext token: `const key = \`${provider}:${oldToken}\`` (line 52). Eviction is purely lazy: line 63 `refreshDedupCache.delete(key)` runs only inside the `if (hit)` block after a re-`get(key)` (line 53) finds an expired entry (line 59 `hit.expiresAt > Date.now()`); the other deletes (lines 71, 75) only fire on a null result or a thrown error. On a successful refresh the entry is stored at line 69 with a 10s TTL but is never re-read for rotating-token providers: the refresh functions return `tokens.refresh_token || refreshToken` (e.g. lines 24, 179, 221, 301, 373) and Codex is explicitly documented as "rotating (one-time-use) refresh tokens" (line 329). After rotation the next call keys on `${provider}:${newToken}`, so the OLD-token key is never accessed again — its TTL branch never executes and it is never deleted, leaving a plaintext refresh token in heap permanently. The cited contrast is accurate: src/lib/auth/loginLimiter.js bounds its Map at MAX_ATTEMPTS_ENTRIES = 10_000 (line 14) with active eviction (lines 48-58), a precedent tokenRefresh.js does not follow. The leak is genuine but slow: TTL is short (10s), entries are small, accumulation needs many rotations in a long-lived process, and non-rotating providers reuse a stable key that does get re-read/evicted. Low severity is correct.

---

## [21] LOW — openai-to-gemini request mis-detects Claude/Anthropic tools as OpenAI when input_schema absent, can skip tools

- **File**: `open-sse/translator/request/openai-to-gemini.js:226-246`
- **Category**: schema mismatch (anthropic<->gemini) | **Confidence**: high

**What's wrong**: Tool conversion branches on `if (t.name && t.input_schema)` for Anthropic shape, else `if (t.type === 'function' && t.function)` for OpenAI. A tool that is neither — e.g. an Anthropic built-in tool ({type:'web_search_20250305', name:'web_search'} with no input_schema and no .function), or an OpenAI function tool missing the nested .function object, or a bare {name, parameters} tool — matches NEITHER branch and is silently dropped from functionDeclarations.

**Impact**: Built-in/edge-shaped tools declared by the client never reach Gemini. The model loses the tool, so it cannot call it; requests that depend on that tool break with no error.

**Evidence**:
```js
if (t.name && t.input_schema) { ... } else if (t.type === "function" && t.function) { ... }  // no else: anything else is dropped
```

**Verifier**: Confirmed by reading and executing the real code. In open-sse/translator/request/openai-to-gemini.js:226-246 the tool loop has exactly two branches — `if (t.name && t.input_schema)` (228) and `else if (t.type === "function" && t.function)` (237) — with no else/fallback and no warning. I ran openaiToGeminiRequest() against the three claimed shapes: an Anthropic built-in {type:"web_search_20250305", name:"web_search"}, a partial OpenAI {type:"function"} with no nested .function, and a bare {name, parameters}. All three produced functionDeclarations.length=0 (DROPPED), while a valid {name, input_schema} and a valid {type:"function", function} were KEPT. So the silent-drop mechanism is real and triggers in direct execution.

Reachability: the dispatch in open-sse/translator/index.js:116-137 routes non-OpenAI sources through source→OpenAI then OpenAI→target. For a Claude client targeting Gemini, claude-to-openai.js:74-75 explicitly PRESERVES Anthropic built-in tools unchanged (`if (tool.type && tool.type !== "function") return {...tool}`). That preserved built-in then reaches openai-to-gemini.js:226 and is dropped. There is no tool-shape validation in the dispatch path; filterToOpenAIFormat runs only when targetFormat===OPENAI (index.js:141), never for the Gemini target. So the Anthropic built-in case is a genuine end-to-end trigger.

Two nuances lower the practical impact below the auditor's "medium": (1) a correctly-shaped Claude function tool {name, input_schema} is KEPT by the 228 branch (the comment at index.js:140 about hybrid OpenAI-messages+Claude-tools requests is satisfied), and a correctly-shaped OpenAI tool is KEPT — only built-ins and malformed tools drop; (2) Gemini's functionDeclarations schema fundamentally cannot represent an Anthropic server-side built-in, so dropping it is largely unavoidable — the real defect is doing so silently with no warning and no mapping to Gemini's native googleSearch/urlContext. The malformed {type:"function"}-without-.function and {name,parameters} cases are non-standard inputs unlikely from a conformant client; notably the function-CALL path at lines 164-168 has an explicit guard+comment for partial shapes, while the declaration loop has none, confirming the gap is unintended rather than designed. Real bug, narrow realistic blast radius, hence low.

---

## [22] LOW — openai-to-claude request: reasoning_effort 'none' string maps via budget 0 but 'none' also collides with falsy budget check elsewhere is fine; real bug is unknown effort silently dropped

- **File**: `open-sse/translator/request/openai-to-claude.js:209-223`
- **Category**: lossy field mapping | **Confidence**: high

**What's wrong**: effortToBudget maps none/low/medium/high/xhigh. An unrecognized reasoning_effort value (e.g. 'minimal', or a numeric string) yields budget === undefined, so neither the disabled nor enabled branch runs and thinking is silently never set. Combined with the guard `!result.thinking`, the client's intent to control reasoning is dropped without warning.

**Impact**: Unknown/forward-compatible reasoning_effort values are silently ignored; the request proceeds with no thinking config, so reasoning is off when the caller asked for it. No corruption, but a dropped control field.

**Evidence**:
```js
const budget = effortToBudget[body.reasoning_effort.toLowerCase()]; if (budget === 0) { result.thinking = { type: "disabled" }; } else if (budget) { result.thinking = { type: "enabled", budget_tokens: budget }; }  // undefined budget → nothing
```

**Verifier**: Verified at open-sse/translator/request/openai-to-claude.js:209-223. The code reads: `const budget = effortToBudget[body.reasoning_effort.toLowerCase()]; if (budget === 0) {...disabled} else if (budget) {...enabled}`. effortToBudget only has keys none/low/medium/high/xhigh. For any other non-empty value (e.g. OpenAI's documented "minimal", or a numeric string), the lookup yields undefined: `undefined === 0` is false and `else if (undefined)` is falsy, so neither branch runs and result.thinking is never set. The `!result.thinking` guard at line 209 confirms intent is dropped silently with no warning/error.\n\nI checked for upstream guards that would prevent the trigger. The only normalization is in open-sse/handlers/chatCore.js:116-143: it special-cases ONLY `reasoning_effort === "none"` (line 117) and injects provider-mode defaults when the client hasn't set the field (line 139). It performs NO validation or rejection of arbitrary client-supplied reasoning_effort values, so an unknown value passes through untouched to the translator. There is no try/catch, default case, or fallback in the translator block. The identical lossy pattern is intentionally duplicated in openai-to-gemini.js:275-292, indicating an "ignore unknown effort" design rather than an accidental omission.\n\nThe auditor's secondary framing (a 'none'/falsy-budget collision) is correctly self-refuted: `budget === 0` is checked before the falsy `else if (budget)`, so 'none' maps to disabled correctly. But the primary claim — unknown reasoning_effort silently dropped — genuinely exists and triggers in real execution. Impact is limited to silently falling back to the provider's default thinking behavior (no crash, no data corruption), matching the 'low' severity.

---

## [23] LOW — Codex default reasoning effort is 'low' but code comments and suffix logic claim default 'medium'

- **File**: `open-sse/executors/codex.js:452-468, 467`
- **Category**: model mismapping | **Confidence**: high

**What's wrong**: The comment at line 452-453 states 'gpt-5.3-codex → medium (default)'. The actual default when no reasoning, no reasoning_effort param, and no model suffix is `'low'`: `const effort = body.reasoning_effort || modelEffort || 'low';`. A bare codex model name therefore requests low reasoning effort, contradicting the documented medium default. This is a silent behavioral mismatch: callers relying on the documented medium default get low-effort reasoning.

**Impact**: Codex requests without an explicit effort run at 'low' reasoning instead of the documented 'medium', degrading output quality for default-config callers.

**Evidence**:
```js
// e.g., gpt-5.3-codex-high → high, gpt-5.3-codex → medium (default)
...
const effort = body.reasoning_effort || modelEffort || 'low';
```

**Verifier**: Confirmed by direct reading of open-sse/executors/codex.js. Line 453 comment says "gpt-5.3-codex → medium (default)" and line 465 comment says "default (medium)", but the actual fallback on line 467 is `const effort = body.reasoning_effort || modelEffort || 'low';`. The suffix-parsing loop (lines 454-463) only sets `modelEffort` when the model name ends in `-none/-low/-medium/-high/-xhigh`; a bare `gpt-5.3-codex` leaves `modelEffort = null`. The `if (!body.reasoning)` guard at line 466 means the fallback only fires when no reasoning object exists — which is the normal case for a plain request. With no `reasoning_effort` param and no suffix, `effort` resolves to `'low'`, then `body.reasoning = { effort: 'low', summary: 'auto' }`. I checked for upstream injection of reasoning/reasoning_effort: the only other writers are reasoningContentInjector.js (DeepSeek-only alias, guarded by `provider !== "deepseek"`) and per-provider translators (gemini/claude/kiro/github), none of which run on the Codex executor path to force a Codex default. So nothing prevents the trigger; a bare codex model genuinely requests low effort while the comments document medium. The bug is a real, reachable comment-vs-code mismatch with a silent effort downgrade. Severity low: it does not break routing or cause errors, only requests lower reasoning effort than documented.

---

## [24] LOW — Antigravity Retry-After parse only honors waits <=10s; longer documented quota resets silently fall through to fallback/exhaustion

- **File**: `open-sse/executors/antigravity.js:257-287, 19`
- **Category**: retry | **Confidence**: high

**What's wrong**: parseRetryFromErrorMessage / parseRetryHeaders can return multi-hour reset windows (e.g. '2h7m23s' → ~7643000 ms), but the retry branch only waits when `retryMs <= MAX_RETRY_AFTER_MS` (10000 ms). For any retryMs > 10s the code logs 'Retry-After too long' and tries the next fallback URL; if no fallback remains it throws. The 429 auto-retry branch only fires when `!retryMs || retryMs === 0`. So when the server returns a precise long Retry-After, the code neither waits nor performs exponential backoff — it abandons the request. This is intended for latency but means an accurately-reported short-but->10s reset (e.g. 12s) is treated identically to a 2-hour reset: immediate failure rather than a brief wait.

**Impact**: Requests hitting a rate limit with an honest Retry-After between 10s and the quota window fail immediately instead of waiting, reducing success rate under throttling.

**Evidence**:
```js
const MAX_RETRY_AFTER_MS = 10000; ... if (retryMs && retryMs <= MAX_RETRY_AFTER_MS && retryAfterAttemptsByUrl[urlIndex] < MAX_RETRY_AFTER_RETRIES) { ... } ... if (response.status === HTTP_STATUS.RATE_LIMITED && (!retryMs || retryMs === 0) && ...) { /* exponential backoff only when retryMs is falsy */ }
```

**Verifier**: The code at /Users/justinadams/Downloads/9router-fork/open-sse/executors/antigravity.js confirms every element of the claim exactly.

1. `MAX_RETRY_AFTER_MS = 10000` (line 19).
2. `parseRetryFromErrorMessage` (lines 193-205) sums hours×3600×1000 + minutes×60×1000 + seconds×1000, so a body like 'reset after 2h7m23s' returns 7,643,000 ms. `parseRetryHeaders` (lines 160-189) can likewise return multi-hour diffs from `retry-after`/`x-ratelimit-reset`.
3. The honoring/wait branch only fires when `retryMs && retryMs <= MAX_RETRY_AFTER_MS` (line 257) — so any retryMs > 10000 is skipped.
4. The exponential-backoff branch is gated on `(!retryMs || retryMs === 0)` (line 269), so a truthy nonzero retryMs (e.g. 12000) skips it too.
5. With retryMs between 10001 and arbitrarily large, both branches are bypassed; control reaches line 280 which logs `Retry-After too long`, sets lastStatus, and either tries the next fallback (line 283) or, if none remain, exits the loop and throws at line 309 (`All N URLs failed`).

Trigger verified by tracing values: retryMs = 12000 → line 257 false (12000 > 10000) → line 269 false (truthy, nonzero) → falls to line 280 → abandons. Identical outcome for retryMs = 7,643,000. So an accurately-reported short-but->10s reset (12s) is treated identically to a 2-hour reset: no wait, no backoff, immediate fallback/failure. The path is plainly reachable on any 429/503 carrying such a header or body; no guard, caller, or validation prevents it.

Nuance: the constant name `MAX_RETRY_AFTER_MS`, the 'too long' log string, and the fallback design show the 10s ceiling is deliberate latency-bounding (intended). The genuine defect is narrower than 'long quota resets fall through' framed as a surprise — it is that there is NO exponential-backoff path for retryMs in the 10s–30s range, so honest sub-30s resets fail immediately rather than waiting briefly. That specific correctness gap is real and triggers. Severity low is appropriate: it degrades retry behavior under rate limiting but does not corrupt data or crash; it surfaces as premature request abandonment (or fallback consumption) when a server reports a precise short reset just above 10s.

---

## [25] LOW — trackPendingRequest START/END is not paired per-request, so concurrent or mismatched releases corrupt the in-flight gauge

- **File**: `open-sse/services/usage.js:168-213`
- **Category**: race | **Confidence**: high

**What's wrong**: Pending counts are keyed only by modelKey (provider+model) and connectionId, not by a unique request id. Two concurrent requests for the same connection+model share pendingRequests.byModel[modelKey] and pendingRequests.byAccount[connectionId][modelKey]. The 60s safety timer (timerKey = connectionId|modelKey) is also shared and is overwritten by each new START (clearTimeout then reset), so the timer for an earlier in-flight request is cancelled when a later one starts. If the earlier request never sends its explicit END (handler path that forgets to release), its count is only reclaimed by the *latest* request's timer — and an END for one request decrements the shared counter that may belong to a still-in-flight sibling. Math.max(0, ...) prevents going negative but means a spurious END can mask a genuine in-flight request, so getActiveRequests()/getPendingRequestTotal() report wrong active counts.

**Impact**: The live 'active requests' dashboard and health/monitoring probe (getPendingRequestTotal) can under- or over-report in-flight requests under concurrency, and a leaked START can persist up to 60s tied to an unrelated request's timer. Accounting of completed usage is unaffected.

**Evidence**:
```js
const timerKey = `${connectionId}|${modelKey}`; ... clearTimeout(pendingTimers[timerKey]); pendingTimers[timerKey] = setTimeout(...)  // shared key across concurrent same-model requests; later START cancels earlier request's reclaim timer
```

**Verifier**: The bug is real. NOTE the auditor cited the wrong file — the code is in src/lib/db/repos/usageRepo.js, NOT open-sse/services/usage.js (which contains GitHub/Gemini usage parsing and none of the claimed symbols). But the line range (168-213), symbol names, and exact cited evidence all match usageRepo.js precisely, so this is a citation error, not a false bug.

Confirmed in usageRepo.js:168-223:
- modelKey = `${model} (${provider})` (line 169); timerKey = `${connectionId}|${modelKey}` (line 170). No per-request id is part of either key.
- Counters are keyed only by modelKey (byModel) and connectionId+modelKey (byAccount), lines 172-179. Two concurrent requests for the same connection+model share the same counter slot.
- START (lines 188-190): `clearTimeout(pendingTimers[timerKey]); pendingTimers[timerKey] = setTimeout(...)`. Exactly the claimed evidence. There is only ever ONE timer per timerKey, so a later START's clearTimeout destroys an earlier in-flight request's reclaim timer; the surviving timer decrements by only 1 (line 193/197).
- END (lines 210-213) decrements the shared counter and clearTimeouts the shared timer, so an END for one request reclaims a slot/cancels a safety timer that may belong to a still-in-flight sibling.
- Math.max(0,...) (lines 173,179,193,197) only prevents negatives; it does not pair releases to starts, so a spurious early END under-counts genuine in-flight requests.

Callers confirm no per-request id: open-sse/handlers/chatCore.js:499/501/509 invoke trackPendingRequest(model, provider, connectionId, started[, error]). The per-request `pendingReleased` flag (chatCore.js:495-500) only prevents double-release WITHIN one handler closure; it does nothing to isolate the shared cross-request counters/timer. This is an HTTP proxy handler with no per-connection serialization, so concurrent same-connection+same-model requests are realistic.

Impact is confined to getActiveRequests()/the in-flight gauge (lines 225-241 read the shared counters directly) — a diagnostic/display metric, not billing or request correctness — which matches the low severity. Trigger requires the narrow window of concurrent same connection+model requests with an interleaved or forgotten release.

---

## [26] LOW — compareVersions silently mis-handles prerelease/short semver, NaN-compares fall through to 'equal'

- **File**: `cli/cli.js:144-152`
- **Category**: logic | **Confidence**: medium

**What's wrong**: compareVersions splits on '.' and map(Number) over exactly 3 indices. A prerelease latest version from the npm registry such as '1.2.3-beta.1' yields parts ['1','2',NaN]; NaN>NaN and NaN<NaN are both false, so the loop returns 0 (equal) and a genuinely newer prerelease is never offered as an update. A 2-part version ('1.3') compares partsA[2]=undefined→NaN vs 0, also falling through. The npm 'latest' tag is attacker-influenceable only by the publisher, but the registry response is external input parsed at line 485-486 and fed straight into compareVersions.

**Impact**: Update check produces wrong result (missed or incorrect 'update available') for any non-strict-3-part version string returned by the registry. No crash, but the version-gating logic is unreliable.

**Evidence**:
```js
const partsA = a.split(".").map(Number);
for (let i = 0; i < 3; i++) {
  if (partsA[i] > partsB[i]) return 1;
  if (partsA[i] < partsB[i]) return -1;
}
return 0;   // '1.2.3-beta.1' -> [1,2,NaN] -> returns 0
```

**Verifier**: The function at cli/cli.js:144-152 does have a genuine prerelease-handling flaw, but the claim's headline example and severity framing are wrong.

REFUTED parts of the claim:
- The claimed example "'1.2.3-beta.1' -> [1,2,NaN] -> returns 0" is factually incorrect. Executing the exact code: compareVersions('1.2.3-beta.1','0.4.8') returns 1, not 0. The loop hits index 0 first (1 > 0) and returns 1 BEFORE ever reaching the NaN at index 2. Verified by running the actual function body.
- The "attacker-influenceable / external input parsed at 485-486" framing overstates risk. The npm `latest` dist-tag (line 480: registry.npmjs.org/<pkg>/latest) does NOT serve prerelease versions under normal npm semantics — `npm publish` of a prerelease never moves `latest`; only an explicit `npm dist-tag add` by the package OWNER does. The live registry confirms latest=clean stable (queried genesis/latest → 1.0.0). So the only actor who could trigger this is the publisher deliberately mis-tagging their own release channel — not an external/attacker vector.

CONFIRMED (narrower) defect: when versions differ only in the PATCH field and the latest patch is a prerelease, e.g. '0.4.9-beta.1' vs current '0.4.8', parts are [0,4,NaN] vs [0,4,8]; NaN>NaN and NaN<NaN are both false, the loop returns 0 (equal), and the genuinely-newer prerelease is never offered (line 486 requires > 0). Verified: compareVersions('0.4.9-beta.1','0.4.8') returns 0. Short versions ('1.3') also compare partsB[2]=undefined→NaN loosely. So the prerelease/short-semver mishandling is real.

Net: a real but benign edge-case bug — worst outcome is a silently-suppressed update prompt (no crash, no downgrade, no security impact), and it only fires if the publisher non-standardly points `latest` at a prerelease that differs only in patch. The bug exists; the claim's specific trigger example is wrong and its input-source/severity framing is inflated.

---

## [27] LOW — Combo PROVIDER_MODELS in CLI is a hand-maintained copy that has drifted from the source of truth

- **File**: `cli/src/cli/menus/providers.js:21-119`
- **Category**: cache-staleness | **Confidence**: high

**What's wrong**: PROVIDER_MODELS in providers.js is commented 'static config (synced from open-sse/config/providerModels.js)' but is a divergent manual duplicate. It is already stale relative to open-sse/config/providerModels.js: e.g. cc here lists claude-opus-4-5/4-5-sonnet/haiku only, while the source adds claude-opus-4-8/4-7/4-6 and sonnet-4-6; cx, gc, gh, kr all differ; many providers present in the source (qd, cu, deepseek, etc.) are absent here. buildProviderHeader() renders this stale list to the user as the provider's models.

**Impact**: Users see an out-of-date model list in the provider header; the two catalogs must be edited in lockstep and currently are not (SSOT violation). Display-only, but actively misleading.

**Evidence**:
```js
// Provider models - static config (synced from open-sse/config/providerModels.js)
const PROVIDER_MODELS = { cc: [ { id: "claude-opus-4-5-20251101" }, ... ] };  // source has 4-8/4-7/4-6 too
```

**Verifier**: Confirmed by direct file comparison. CLI cli/src/cli/menus/providers.js:22-119 hardcodes PROVIDER_MODELS with a comment claiming it is "synced from open-sse/config/providerModels.js", but it is a separate literal object, not an import — nothing enforces the sync. The lists have measurably drifted: CLI cc (lines 23-27) lists only claude-opus-4-5-20251101 / claude-sonnet-4-5-20250929 / claude-haiku-4-5-20251001, while the source (providerModels.js:52-60) prepends claude-opus-4-8, claude-opus-4-7, claude-opus-4-6, claude-sonnet-4-6. cx, gc, qw, if, gh also differ (e.g. source cx uses gpt-5.5/5.4/5.3-codex-* plus image models and a withCodexReviewModels transform the CLI lacks entirely). The stale data reaches the user via a live path: showProviderDetail (called at :185 oauth and :200 apikey from active menus) passes headerContent: buildProviderHeader(providerId) (:288), which reads PROVIDER_MODELS[alias] (:258) and renders a "Models: ..." line (:265). No guard reconciles the two copies; the `|| []` fallback only handles missing keys, not stale ones. Tried to refute via reachability and guards — both fail; the bug genuinely triggers. Caveat justifying low severity: buildProviderHeader only renders a cosmetic truncated preview (first 5 ids + "+N more") as a header banner; actual served models come from api.getProviders() at runtime (:290), so routing is unaffected — only the displayed hint is stale/incomplete.

---

## [28] LOW — editSingleCombo / handleEditCombo / handleDeleteCombo / showComboDetail are unreachable (not exported, no internal caller)

- **File**: `cli/src/cli/menus/combos.js:158, 322-343, 349, 425`
- **Category**: dead-code | **Confidence**: high

**What's wrong**: module.exports exposes only { showCombosMenu }. The reachable edit/delete flow goes showCombosMenu -> showComboActions -> handleEditSingleCombo/handleDeleteSingleCombo. handleEditCombo (and the editSingleCombo it calls), handleDeleteCombo, showComboDetail, and formatComboLabel-as-used-by-them have no reachable caller. Notably editSingleCombo (line 349) contains a different, never-exercised model-editing loop than handleEditSingleCombo, so the two implementations have silently diverged. This is proven unreachable (single export, no internal references), not merely unused-by-design.

**Impact**: Maintenance hazard: two divergent combo-edit code paths, one dead. The live path (handleEditSingleCombo) uses confirm('Add another model?') and has no 'min 2 models' enforcement that the dead editSingleCombo had, so the intended 2-model minimum is not enforced on edit.

**Evidence**:
```js
module.exports = { showCombosMenu };
// handleEditCombo -> editSingleCombo never called; showComboActions uses handleEditSingleCombo instead
```

**Verifier**: Confirmed by reading the full file and grepping all source (excluding .next build artifacts). module.exports = { showCombosMenu } (combos.js:477) is the sole export. The only external importer is cli/src/cli/terminalUI.js:5, which destructures showCombosMenu only. handleEditCombo (322), handleDeleteCombo (425), and showComboDetail (158) have zero callers anywhere and are never exported. editSingleCombo (349) is called only at line 343 inside handleEditCombo, which is itself unreachable, so it is transitively dead. formatComboLabel (199) is referenced only at lines 334 and 437 inside those two unreachable functions. The live edit/delete flow is showCombosMenu -> onSelect -> showComboActions (24) -> handleEditSingleCombo (56) / handleDeleteSingleCombo (102), which are different implementations from the dead editSingleCombo. The two edit loops have genuinely diverged: handleEditSingleCombo uses a confirm('Add another model?') loop while editSingleCombo uses 'done'/'cancel' string sentinels. These are plain local function declarations with no dynamic dispatch, reflection, or string-based lookup, so no indirect caller can reach them. The dead-code claim is structurally proven. Note this is unreachable code, not a runtime bug that triggers — severity correctly stays low.

---

## [29] LOW — Combo create enforces min-2 models but edit (live path) does not

- **File**: `cli/src/cli/menus/providers.js:56-96`
- **Category**: logic | **Confidence**: high

**What's wrong**: handleEditSingleCombo (the reachable edit path from showComboActions) lets the user add zero or one model and submits whatever they accumulated: finalModels = models.length > 0 ? models : combo.models, with no '< 2' check. handleCreateCombo in combos.js explicitly enforces 'at least 2 models' (line 283-288). So a combo that is supposed to be a 2+ model fallback chain can be edited down to a single model, defeating the combo/fallback semantics. (The dead editSingleCombo had the min-2 guard; it was lost in the live rewrite.)

**Impact**: A fallback combo can be silently reduced to one model via edit, breaking the documented minimum and the combo's purpose, with no error shown.

**Evidence**:
```js
const finalModels = models.length > 0 ? models : combo.models;
const result = await api.updateCombo(combo.id, { name, models: finalModels });   // no length>=2 check
```

**Verifier**: The bug is real, though the claim cites the wrong file — the code is in cli/src/cli/menus/combos.js, NOT providers.js (providers.js:56-96 is the PROVIDER_MODELS config). All cited line numbers, function names, and the exact snippet match combos.js.

Reachability confirmed: showCombosMenu (combos.js:119) -> onSelect -> showComboActions (24) -> "Edit Combo" -> handleEditSingleCombo (56). This is the live edit path. The older editSingleCombo (349) — which DOES have the `newModels.length < 2` guard at 384-385 — is dead: its only caller handleEditCombo (322->343) is itself never invoked from any menu (grep shows no external callers).

Trigger: In handleEditSingleCombo (66-88), the user adds models one at a time. If they add exactly one model and answer "no" to confirm('Add another model?') at line 78, the loop exits with models=[oneModel]. Then `const finalModels = models.length > 0 ? models : combo.models` (86) yields the single-model array, and `api.updateCombo(combo.id, { name, models: finalModels })` (88) submits it. There is no `< 2` check anywhere in this function.

By contrast, handleCreateCombo enforces min-2 at lines 283-288 ('Please select at least 2 models'). So create blocks single-model combos but edit does not — exactly the asymmetry claimed.

No backstop exists at any layer: the backend PUT handler src/app/api/combos/[id]/route.js (40-89) validates only name format/uniqueness (VALID_NAME_REGEX, getComboByName) and never checks body.models length. updateCombo in localDb is called directly with the body. A repo-wide grep for 'at least 2'/'length < 2'/'length >= 2'/'MIN_MODELS' on combos found nothing server-side. So a 2+ model fallback chain can genuinely be edited down to a single model.

The (note: the user must add >=1 model to override; cancelling out on the first selection leaves models empty and safely keeps combo.models. The trigger requires adding exactly one.)

---
