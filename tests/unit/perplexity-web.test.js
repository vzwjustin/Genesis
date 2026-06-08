/**
 * Unit tests for perplexity-web executor
 *
 * Covers:
 *  - Message parsing (system/user/assistant/developer, multi-part content)
 *  - Query building for first turn vs follow-up (session continuity)
 *  - Tools injection into instructions
 *  - Request body shape (dual query_str top-level + params.query_str is required by upstream)
 *  - Auth header construction (apiKey → Cookie, accessToken → Bearer)
 *  - Model mapping (normal + thinking)
 *  - Error handling (401, 429)
 */

import { describe, it, expect } from "vitest";
import {
  parseOpenAIMessages,
  buildQuery,
  buildPplxRequestBody,
  formatToolsHint,
  PerplexityWebExecutor,
} from "../../open-sse/executors/perplexity-web.js";

describe("parseOpenAIMessages", () => {
  it("extracts system + history + current msg", () => {
    const parsed = parseOpenAIMessages([
      { role: "system", content: "Be helpful" },
      { role: "user", content: "Q1" },
      { role: "assistant", content: "A1" },
      { role: "user", content: "Q2" },
    ]);
    expect(parsed.systemMsg.trim()).toBe("Be helpful");
    expect(parsed.history).toEqual([
      { role: "user", content: "Q1" },
      { role: "assistant", content: "A1" },
    ]);
    expect(parsed.currentMsg).toBe("Q2");
  });

  it("treats developer role as system", () => {
    const parsed = parseOpenAIMessages([
      { role: "developer", content: "Be concise" },
      { role: "user", content: "hi" },
    ]);
    expect(parsed.systemMsg.trim()).toBe("Be concise");
    expect(parsed.currentMsg).toBe("hi");
  });

  it("handles multi-part content (array of text blocks)", () => {
    const parsed = parseOpenAIMessages([
      { role: "user", content: [{ type: "text", text: "part1" }, { type: "text", text: "part2" }] },
    ]);
    expect(parsed.currentMsg).toBe("part1 part2");
  });

  it("skips empty content messages", () => {
    const parsed = parseOpenAIMessages([
      { role: "user", content: "   " },
      { role: "user", content: "real" },
    ]);
    expect(parsed.currentMsg).toBe("real");
  });
});

describe("buildQuery", () => {
  it("first turn: returns JSON with instructions + query", () => {
    const parsed = { systemMsg: "Be helpful\n", history: [], currentMsg: "Hello" };
    const q = buildQuery(parsed, null);
    const obj = JSON.parse(q);
    expect(obj.query).toBe("Hello");
    expect(obj.instructions).toContain("Be helpful");
    expect(obj.instructions.some((s) => s.includes("web search"))).toBe(true);
  });

  it("follow-up (with backendUuid): returns plain currentMsg, no JSON", () => {
    const parsed = {
      systemMsg: "Be helpful",
      history: [{ role: "user", content: "Q1" }, { role: "assistant", content: "A1" }],
      currentMsg: "Follow up",
    };
    const q = buildQuery(parsed, "uuid-abc-123");
    expect(q).toBe("Follow up");
  });

  it("includes history when present on first turn", () => {
    const parsed = {
      systemMsg: "",
      history: [{ role: "user", content: "earlier" }],
      currentMsg: "now",
    };
    const obj = JSON.parse(buildQuery(parsed, null));
    expect(obj.history).toEqual([{ role: "user", content: "earlier" }]);
    expect(obj.query).toBe("now");
  });

  it("injects tools into instructions on first turn", () => {
    const parsed = { systemMsg: "", history: [], currentMsg: "hi" };
    const tools = [
      { function: { name: "Shell", description: "Run bash" } },
      { function: { name: "Read", description: "Read file" } },
    ];
    const obj = JSON.parse(buildQuery(parsed, null, tools));
    const hint = obj.instructions.find((s) => s.includes("Available tools"));
    expect(hint).toBeDefined();
    expect(hint).toContain("- Shell: Run bash");
    expect(hint).toContain("- Read: Read file");
  });

  it("ignores tools on follow-up turn (uses session)", () => {
    const parsed = { systemMsg: "", history: [{ role: "user", content: "x" }], currentMsg: "y" };
    const tools = [{ function: { name: "Shell", description: "d" } }];
    const q = buildQuery(parsed, "uuid", tools);
    expect(q).toBe("y");
  });

  it("truncates query if JSON exceeds 96000 chars", () => {
    const big = "x".repeat(100000);
    const parsed = { systemMsg: big, history: [], currentMsg: "hi" };
    const q = buildQuery(parsed, null);
    expect(q.length).toBeLessThanOrEqual(96000);
  });
});

describe("formatToolsHint", () => {
  it("returns empty string for no tools", () => {
    expect(formatToolsHint()).toBe("");
    expect(formatToolsHint([])).toBe("");
  });

  it("handles OpenAI tool schema (function wrapper)", () => {
    const out = formatToolsHint([{ function: { name: "Foo", description: "does foo" } }]);
    expect(out).toContain("- Foo: does foo");
  });

  it("handles flat tool schema", () => {
    const out = formatToolsHint([{ name: "Bar", description: "does bar" }]);
    expect(out).toContain("- Bar: does bar");
  });

  it("truncates long descriptions to first line, max 200 chars", () => {
    const longDesc = "line1\nline2\nline3";
    const out = formatToolsHint([{ function: { name: "X", description: longDesc } }]);
    expect(out).toContain("- X: line1");
    expect(out).not.toContain("line2");
  });
});

describe("buildPplxRequestBody", () => {
  it("sets query_str at both top-level AND params (required by upstream API)", () => {
    const body = buildPplxRequestBody("hello world", "concise", "pplx_pro", null);
    expect(body.query_str).toBe("hello world");
    expect(body.params.query_str).toBe("hello world");
  });

  it("includes required params", () => {
    const body = buildPplxRequestBody("q", "copilot", "claude46sonnet", "uuid-xyz");
    expect(body.params.search_focus).toBe("internet");
    expect(body.params.mode).toBe("copilot");
    expect(body.params.model_preference).toBe("claude46sonnet");
    expect(body.params.sources).toEqual(["web"]);
    expect(body.params.use_schematized_api).toBe(true);
    expect(body.params.is_incognito).toBe(true);
    expect(body.params.last_backend_uuid).toBe("uuid-xyz");
    expect(body.params.version).toBe("2.18");
  });
});

describe("PerplexityWebExecutor — model and auth wiring", () => {
  it("MODEL_MAP defines pplx-auto as concise / pplx_pro", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(root, "../../open-sse/executors/perplexity-web.js"), "utf8");
    expect(src).toContain('"pplx-auto": ["concise", "pplx_pro"]');
    const body = buildPplxRequestBody("hi", "concise", "pplx_pro", null);
    expect(body.params.mode).toBe("concise");
    expect(body.params.model_preference).toBe("pplx_pro");
  });

  it("THINKING_MAP defines pplx-opus thinking preference", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(root, "../../open-sse/executors/perplexity-web.js"), "utf8");
    expect(src).toContain('"pplx-opus": "claude46opusthinking"');
    const body = buildPplxRequestBody("hi", "copilot", "claude46opusthinking", null);
    expect(body.params.mode).toBe("copilot");
    expect(body.params.model_preference).toBe("claude46opusthinking");
  });

  it("injects body.tools into query instructions via buildQuery", () => {
    const parsed = parseOpenAIMessages([{ role: "user", content: "what tools do you have?" }]);
    const q = buildQuery(parsed, null, [{ function: { name: "Shell", description: "Execute commands" } }]);
    const queryObj = JSON.parse(q);
    const toolsHint = queryObj.instructions.find((s) => s.includes("Available tools"));
    expect(toolsHint).toContain("- Shell: Execute commands");
  });

  it("auth header logic uses Cookie for apiKey and Bearer for accessToken (source)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(root, "../../open-sse/executors/perplexity-web.js"), "utf8");
    expect(src).toContain('__Secure-next-auth.session-token=${credentials.apiKey}');
    expect(src).toContain('Bearer ${credentials.accessToken}');
    expect(src).toContain("proxyAwareFetch");
  });

  it("returns 400 on missing messages without upstream call", async () => {
    const exec = new PerplexityWebExecutor();
    const { response } = await exec.execute({
      model: "pplx-auto",
      body: {},
      stream: false,
      credentials: { apiKey: "c" },
    });
    expect(response.status).toBe(400);
  });

  it("surfaces friendly 401 and 429 messages (source)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(root, "../../open-sse/executors/perplexity-web.js"), "utf8");
    expect(src).toMatch(/auth failed|expired/i);
    expect(src).toMatch(/rate limited/i);
  });
});
