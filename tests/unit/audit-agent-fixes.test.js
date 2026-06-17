import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createCircuitBreaker } from "../../open-sse/utils/circuitBreaker.js";
import { GithubExecutor } from "../../open-sse/executors/github.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { injectCaveman } from "../../open-sse/rtk/caveman.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import {
  cacheClaudeHeaders,
  getCachedClaudeHeaders,
  __clearClaudeHeaderCacheForTests,
} from "../../open-sse/utils/claudeHeaderCache.js";

const root = join(import.meta.dirname, "..", "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// #1 — Circuit breaker probe must never wedge the breaker permanently.
describe("audit#1 circuit breaker probe release + self-heal", () => {
  it("releases the probe slot when a request reports neither success nor failure", async () => {
    const cb = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 1, probeTimeoutMs: 60000 });
    cb.recordFailure("p"); // closed → open
    await sleep(5); // cooldown elapsed
    expect(cb.canRequest("p").allowed).toBe(true); // half-open probe taken
    expect(cb.canRequest("p").allowed).toBe(false); // concurrent waiter rejected
    cb.recordProbeRelease("p"); // request aborted → release probe
    expect(cb.canRequest("p").allowed).toBe(true); // a fresh probe is allowed
  });

  it("self-heals a stale in-flight probe past probeTimeoutMs", async () => {
    const cb = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 1, probeTimeoutMs: 10 });
    cb.recordFailure("p");
    await sleep(5);
    expect(cb.canRequest("p").allowed).toBe(true); // probe taken, never released
    expect(cb.canRequest("p").allowed).toBe(false);
    await sleep(15); // probe goes stale
    expect(cb.canRequest("p").allowed).toBe(true); // breaker self-heals
  });

  it("chatCore releases the circuit probe on client abort", () => {
    const src = read("open-sse/handlers/chatCore.js");
    expect(src).toContain("releaseCircuitProbe");
    expect(src).toMatch(/clientAbort[\s\S]*releaseCircuitProbe\(provider\)/);
  });
});

// #2 — github.js must not mutate the caller's body (double-injection on retry).
describe("audit#2 github sanitize does not mutate caller body", () => {
  it("leaves the input body byte-identical and is idempotent across retries", () => {
    const ex = new GithubExecutor();
    const body = {
      model: "claude-3-5-sonnet",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "U" },
      ],
    };
    const snapshot = JSON.stringify(body);
    const r1 = ex.sanitizeMessagesForChatCompletions(body);
    const r2 = ex.sanitizeMessagesForChatCompletions(body); // simulate refresh-retry reuse
    expect(JSON.stringify(body)).toBe(snapshot); // caller body untouched
    const user1 = r1.messages.find((m) => m.role === "user").content;
    const user2 = r2.messages.find((m) => m.role === "user").content;
    expect(user1).toBe(user2); // no double injection
    expect((user1.match(/Respond with ONLY raw JSON/g) || []).length).toBe(1);
  });
});

// #3 — claudeHeaderCache rejects injected values + bounds cache.
describe("audit#3 claudeHeaderCache value validation", () => {
  it("does not cache header values containing CR/LF (header injection)", () => {
    __clearClaudeHeaderCacheForTests();
    cacheClaudeHeaders(
      { "user-agent": "claude-cli/1.0", "anthropic-beta": "evil\r\nx-inject: 1" },
      "conn-1",
    );
    const got = getCachedClaudeHeaders("conn-1");
    expect(got["user-agent"]).toBe("claude-cli/1.0");
    expect(got["anthropic-beta"]).toBeUndefined();
  });
});

// #4 — proxy threading for MITM-bypass refresh hosts.
describe("audit#4 proxyOptions threaded to bypass-host refreshes", () => {
  it("fetchKiroProfileArn accepts and forwards proxyOptions", () => {
    const src = read("src/lib/oauth/providers.js");
    expect(src).toMatch(/fetchKiroProfileArn\(accessToken,\s*proxyOptions/);
    expect(src).toMatch(/ListAvailableProfiles[\s\S]*\},\s*proxyOptions\)/);
  });
  it("Copilot proactive refresh + combined refresh pass proxyOptions", () => {
    const src = read("src/sse/services/tokenRefresh.js");
    expect(src).toMatch(/refreshCopilotToken\(creds\.accessToken,\s*buildProxyOptionsFromCredentials\(creds\)\)/);
    expect(src).toMatch(/refreshGitHubToken\(credentials\.refreshToken,\s*proxyOptions\)/);
  });
});

// #5 — caveman must not corrupt Responses input[].
describe("audit#5 caveman injects into Responses instructions", () => {
  it("uses top-level instructions and leaves input[] untouched", () => {
    const body = { input: [{ role: "system", content: [{ type: "input_text", text: "S" }] }] };
    const ok = injectCaveman(body, FORMATS.OPENAI_RESPONSES, "full", "openai");
    expect(ok).toBe(true);
    expect(typeof body.instructions).toBe("string");
    expect(body.instructions.length).toBeGreaterThan(0);
    // input content unchanged — no foreign {type:"text"} part pushed
    expect(body.input[0].content).toHaveLength(1);
    expect(body.input[0].content[0].type).toBe("input_text");
  });
});

// #6 — MITM hosts-file matching is per-line token, not whole-file substring.
describe("audit#6 dnsConfig per-line host match", () => {
  it("uses an exact-token line matcher instead of String.includes(host)", () => {
    const src = read("src/mitm/dns/dnsConfig.js");
    expect(src).toContain("hostsLineMatchesHost");
    expect(src).toContain("hostsContentHasHost");
    expect(src).not.toMatch(/hosts(Content)?\.includes\(host\)/);
    expect(src).not.toMatch(/l\.includes\(h\)/);
  });
});

// #7 — MITM verifies process identity before SIGKILL.
describe("audit#7 MITM verify process before kill", () => {
  it("gates saved-PID kills behind isLikelyMitmProcess", () => {
    const src = read("src/mitm/manager.js");
    expect(src).toContain("function isLikelyMitmProcess");
    expect(src).toMatch(/isProcessAlive\(savedPid\)\s*&&\s*isLikelyMitmProcess\(savedPid\)/);
    expect(src).toMatch(/fromLiveProc\s*\|\|\s*isLikelyMitmProcess\(pidToKill\)/);
  });
});

// #8 — stats aggregate in SQL instead of materializing whole tables.
describe("audit#8 stats SQL aggregation", () => {
  it("usageHistory overlay uses GROUP BY MAX(timestamp)", () => {
    const src = read("src/lib/db/repos/usageRepo.js");
    expect(src).toMatch(/MAX\(timestamp\) AS ts[\s\S]*GROUP BY provider, model, connectionId, apiKey, endpoint/);
  });
  it("compression provider stats GROUP BY provider, subsystem", () => {
    const src = read("src/lib/compressionStats.js");
    expect(src).toMatch(/GROUP BY provider, subsystem/);
    expect(src).not.toMatch(/ORDER BY id ASC/);
  });
});

// #9 — xAI invalid_request is not unrecoverable.
describe("audit#9 xAI transient error classification", () => {
  it("only invalid_grant maps to unrecoverable", () => {
    const src = read("open-sse/services/tokenRefresh.js");
    expect(src).not.toMatch(/msg\.includes\("invalid_grant"\)\s*\|\|\s*msg\.includes\("invalid_request"\)/);
  });
});

// #10 — default.js json_schema fallback does not mutate caller body.
describe("audit#10 default.js applyJsonSchemaFallback no mutation", () => {
  it("does not push into the caller's system content array", () => {
    const ex = new DefaultExecutor("openai-compatible-x");
    const body = {
      response_format: { type: "json_schema", json_schema: { schema: { type: "object" } } },
      messages: [{ role: "system", content: [{ type: "text", text: "S" }] }],
    };
    const origArr = body.messages[0].content;
    const out = ex.applyJsonSchemaFallback(body);
    expect(origArr).toHaveLength(1); // caller array untouched
    expect(out.messages[0].content).toHaveLength(2); // new array carries the schema prompt
    expect(out.response_format).toEqual({ type: "json_object" });
  });
});

// #11/#12 — validate route SSRF guard + gemini proxy arg.
describe("audit#11/#12 provider validate route", () => {
  it("azure endpoint runs through validateProviderBaseUrl", () => {
    const src = read("src/app/api/providers/validate/route.js");
    expect(src).toMatch(/endpoint = validateProviderBaseUrl\(\(providerSpecificData\?\.azureEndpoint/);
  });
  it("gemini validate passes proxyOptions as the 3rd arg", () => {
    const src = read("src/app/api/providers/validate/route.js");
    expect(src).toMatch(/generativelanguage\.googleapis\.com[\s\S]*key=\$\{apiKey\}`,\s*undefined,\s*proxyOptions\)/);
  });
});

// #13 — MITM enforces HTTP/2 for h2-required hosts.
describe("audit#13 MITM h2-required enforcement", () => {
  it("forces the http2 path for isHttp2Required hosts without HTTP/1.1 fallback", () => {
    const src = read("src/mitm/server.js");
    expect(src).toMatch(/isHttp2Required\(targetHost\)/);
    const block = src.slice(src.indexOf("if (isHttp2Required(targetHost))"));
    expect(block.indexOf("passthroughHttp2")).toBeLessThan(block.indexOf("negotiateAlpn"));
  });
});
