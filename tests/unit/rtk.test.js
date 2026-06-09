import { describe, it, expect, beforeEach } from "vitest";
import { compressMessages, formatRtkLog, findLastCacheBoundary } from "../../open-sse/rtk/index.js";
import { gitDiff } from "../../open-sse/rtk/filters/gitDiff.js";
import { gitStatus } from "../../open-sse/rtk/filters/gitStatus.js";
import { grep } from "../../open-sse/rtk/filters/grep.js";
import { find } from "../../open-sse/rtk/filters/find.js";
import { dedupLog } from "../../open-sse/rtk/filters/dedupLog.js";
import { ls } from "../../open-sse/rtk/filters/ls.js";
import { tree } from "../../open-sse/rtk/filters/tree.js";
import { smartTruncate } from "../../open-sse/rtk/filters/smartTruncate.js";
import { readNumbered } from "../../open-sse/rtk/filters/readNumbered.js";
import { searchList } from "../../open-sse/rtk/filters/searchList.js";
import { autoDetectFilter } from "../../open-sse/rtk/autodetect.js";
import { safeApply } from "../../open-sse/rtk/applyFilter.js";

function makeLongDiff() {
  const lines = ["diff --git a/foo.js b/foo.js", "index abc..def 100644", "--- a/foo.js", "+++ b/foo.js", "@@ -1,3 +1,200 @@"];
  for (let i = 0; i < 200; i++) lines.push(`+added line ${i} ${"x".repeat(20)}`);
  return lines.join("\n");
}

function makeGitStatus() {
  return [
    "On branch main",
    "Your branch is up to date with 'origin/main'.",
    "",
    "Changes not staged for commit:",
    "  (use \"git add <file>...\" to update what will be committed)",
    "\tmodified:   src/a.js",
    "\tmodified:   src/b.js",
    "\tnew file:   src/c.js",
    "\tdeleted:    src/old.js",
    "",
    "Untracked files:",
    "\tnotes.txt",
    "",
    "no changes added to commit"
  ].join("\n");
}

function makeGrepOutput() {
  const lines = [];
  for (let i = 1; i <= 40; i++) lines.push(`src/foo.js:${i}:const x${i} = "some value here with padding text padding text"`);
  for (let i = 1; i <= 10; i++) lines.push(`src/bar.js:${i}:const y${i} = "another value here with padding padding padding"`);
  return lines.join("\n");
}

function makeWindowsGrepOutput() {
  return [
    "C:\\Users\\foo\\bar.js:10:const x = 1",
    "C:\\Users\\foo\\baz.js:20:const y = 2",
    "C:\\Users\\foo\\qux.js:30:const z = 3",
  ].join("\n");
}

function makeFindOutput() {
  const lines = [];
  for (let i = 0; i < 30; i++) lines.push(`./src/a/${i}.js`);
  for (let i = 0; i < 20; i++) lines.push(`./src/b/${i}.js`);
  for (let i = 0; i < 5; i++) lines.push(`./top${i}.md`);
  return lines.join("\n");
}

function makeUniqueLines(count) {
  return Array.from({ length: count }, (_, i) => `unique line ${i} ${"x".repeat(20)}`).join("\n");
}

function makeDuplicateHeavyLog() {
  const lines = [];
  for (let i = 0; i < 30; i++) lines.push("repeated log line with padding text padding text padding");
  lines.push("one unique line at the end");
  return lines.join("\n");
}

describe("RTK flag", () => {
  it("compressMessages respects enabled flag", () => {
    const body = { messages: [{ role: "tool", tool_call_id: "x", content: "x".repeat(600) }] };
    expect(compressMessages(body, false)).toBeNull();
    expect(compressMessages(structuredClone(body), true)).not.toBeNull();
  });
});

describe("findLastCacheBoundary", () => {
  it("finds cache_control on message", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "user", content: "hello", cache_control: { type: "ephemeral" } },
      { role: "user", content: "later" },
    ];
    expect(findLastCacheBoundary(messages)).toBe(1);
  });

  it("finds cache_control on content block", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "user", content: [{ type: "text", text: "cached", cache_control: { type: "ephemeral" } }] },
      { role: "user", content: [{ type: "text", text: "later" }] },
    ];
    expect(findLastCacheBoundary(messages)).toBe(1);
  });

  it("returns -1 when no cache boundary", () => {
    const messages = [{ role: "user", content: "hi" }];
    expect(findLastCacheBoundary(messages)).toBe(-1);
  });
});

describe("compressMessages cache boundary", () => {
  it("skips tool results at or before cache boundary", () => {
    const big = makeLongDiff();
    const body = {
      messages: [
        { role: "tool", tool_call_id: "c1", content: big, cache_control: { type: "ephemeral" } },
        { role: "user", content: "next" },
      ]
    };
    const stats = compressMessages(body, true);
    expect(body.messages[0].content.length).toBe(big.length);
    expect(stats.hits.length).toBe(0);
  });

  it("skips tool results before cache boundary message", () => {
    const bigBefore = makeLongDiff();
    const bigAfter = makeGrepOutput();
    const body = {
      messages: [
        { role: "tool", tool_call_id: "c1", content: bigBefore },
        { role: "user", content: [{ type: "text", text: "cached", cache_control: { type: "ephemeral" } }] },
        { role: "tool", tool_call_id: "c2", content: bigAfter },
      ]
    };
    const stats = compressMessages(body, true);
    expect(body.messages[0].content.length).toBe(bigBefore.length);
    expect(body.messages[2].content.length).toBeLessThan(bigAfter.length);
    expect(stats.hits.length).toBeGreaterThan(0);
  });

  it("still compresses tool results AFTER cache boundary", () => {
    const big = makeLongDiff();
    const body = {
      messages: [
        { role: "user", content: [{ type: "text", text: "cached", cache_control: { type: "ephemeral" } }] },
        { role: "tool", tool_call_id: "c1", content: big },
      ]
    };
    const stats = compressMessages(body, true);
    expect(stats.hits.length).toBeGreaterThan(0);
    expect(body.messages[1].content.length).toBeLessThan(big.length);
  });
});

describe("RTK filters", () => {
  it("gitDiff truncates hunks beyond 100 lines and preserves file header", () => {
    const input = makeLongDiff();
    const out = gitDiff(input, 500);
    expect(out).toContain("foo.js");
    expect(out).toContain("lines truncated");
    expect(out.length).toBeLessThan(input.length);
  });

  it("gitStatus groups by kind and produces compact output (Rust format)", () => {
    const input = makeGitStatus();
    const out = gitStatus(input);
    expect(out).toContain("* main");
    expect(out).toMatch(/~ Modified: \d+ files/);
    expect(out).toContain("src/a.js");
    expect(out.length).toBeLessThan(input.length);
  });

  it("grep groups matches by file and caps per-file lines (Rust format)", () => {
    const input = makeGrepOutput();
    const out = grep(input);
    expect(out).toContain("50 matches in 2F:");
    expect(out).toContain("[file] src/foo.js (40):");
    expect(out).toContain("[file] src/bar.js (10):");
    expect(out).toMatch(/\+\d+/); // overflow marker
    expect(out.length).toBeLessThan(input.length);
  });

  it("grep() correctly groups Windows paths", () => {
    const input = makeWindowsGrepOutput();
    const out = grep(input);
    expect(out).toContain("3 matches in 3F:");
    expect(out).toContain("[file] C:\\Users\\foo\\bar.js (1):");
    expect(out).toContain("  10: const x = 1");
    expect(out).toContain("[file] C:\\Users\\foo\\baz.js (1):");
    expect(out).toContain("  20: const y = 2");
  });

  it("find groups paths by parent dir, shows basenames (Rust format)", () => {
    const input = makeFindOutput();
    const out = find(input);
    expect(out).toContain("55 files in 3 dirs:");
    expect(out).toContain("./src/a/ (30):");
    expect(out).toContain("./src/b/ (20):");
    expect(out).toContain("./ (5):");
    expect(out.length).toBeLessThan(input.length);
  });

  it("dedupLog collapses consecutive duplicates", () => {
    const input = Array(20).fill("repeated log line A").join("\n") + "\nunique\n" + Array(10).fill("another dup").join("\n");
    const out = dedupLog(input);
    expect(out).toContain("repeated log line A");
    expect(out).toContain("duplicate lines");
    expect(out.length).toBeLessThan(input.length);
  });
});

describe("autoDetectFilter", () => {
  it("detects git diff", () => {
    expect(autoDetectFilter("diff --git a/x b/x\n@@ -1 +1 @@\n+a").filterName).toBe("git-diff");
  });
  it("detects git status", () => {
    expect(autoDetectFilter("On branch main\n  modified:   x.js\n").filterName).toBe("git-status");
  });
  it("detects grep", () => {
    expect(autoDetectFilter("a.js:1:hello\nb.js:2:world\nc.js:3:foo").filterName).toBe("grep");
  });
  it("autoDetectFilter detects Windows grep output", () => {
    expect(autoDetectFilter(makeWindowsGrepOutput()).filterName).toBe("grep");
  });
  it("detects find", () => {
    expect(autoDetectFilter("./a/b.js\n./a/c.js\n./a/d.js").filterName).toBe("find");
  });
  it("falls back to dedupLog for generic text", () => {
    const txt = "line1\nline2\nline3\nline4\nline5\nline6\n";
    expect(autoDetectFilter(txt).filterName).toBe("dedup-log");
  });
  it("prefers smartTruncate over dedupLog for 250+ unique lines", () => {
    const txt = makeUniqueLines(400);
    expect(autoDetectFilter(txt).filterName).toBe("smart-truncate");
  });
});

describe("RTK filters (extras)", () => {
  it("ls: compact_ls strips perms/owner, keeps name + size", () => {
    const input = [
      "total 48",
      "drwxr-xr-x  2 user staff   64 Jan  1 12:00 .",
      "drwxr-xr-x  2 user staff   64 Jan  1 12:00 ..",
      "drwxr-xr-x  2 user staff   64 Jan  1 12:00 src",
      "-rw-r--r--  1 user staff 1234 Jan  1 12:00 Cargo.toml",
      "-rw-r--r--  1 user staff 5678 Jan  1 12:00 README.md"
    ].join("\n");
    const out = ls(input);
    expect(out).toContain("src/");
    expect(out).toContain("Cargo.toml");
    expect(out).toContain("1.2K");
    expect(out).toContain("5.5K");
    expect(out).not.toContain("drwx");
    expect(out).toContain("Summary: 2 files, 1 dirs");
  });

  it("ls: filters noise dirs", () => {
    const input = [
      "total 8",
      "drwxr-xr-x  2 user staff 64 Jan  1 12:00 node_modules",
      "drwxr-xr-x  2 user staff 64 Jan  1 12:00 .git",
      "drwxr-xr-x  2 user staff 64 Jan  1 12:00 src",
      "-rw-r--r--  1 user staff 100 Jan  1 12:00 main.js"
    ].join("\n");
    const out = ls(input);
    expect(out).not.toContain("node_modules");
    expect(out).not.toContain(".git");
    expect(out).toContain("src/");
    expect(out).toContain("main.js");
  });

  it("tree: removes summary, keeps structure", () => {
    const input = ".\n├── src\n│   └── main.rs\n└── Cargo.toml\n\n2 directories, 3 files\n";
    const out = tree(input);
    expect(out).not.toContain("directories");
    expect(out).toContain("├──");
    expect(out).toContain("main.rs");
  });

  it("smartTruncate: keeps head+tail, drops middle", () => {
    const input = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    const out = smartTruncate(input);
    expect(out).toContain("line 0");
    expect(out).toContain("line 399");
    expect(out).toContain("lines truncated");
    expect(out.length).toBeLessThan(input.length);
  });

  it("smartTruncate: passes through small input", () => {
    const input = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    expect(smartTruncate(input)).toBe(input);
  });

  it("readNumbered: compacts very long line-numbered dump", () => {
    const lines = [];
    for (let i = 1; i <= 400; i++) lines.push(`  ${i}|content ${i}`);
    const input = lines.join("\n");
    const out = readNumbered(input);
    expect(out).toContain("1|content 1");
    expect(out).toContain("400|content 400");
    expect(out).toContain("lines truncated");
    expect(out.length).toBeLessThan(input.length);
  });

  it("searchList: groups Cursor Glob output by parent dir", () => {
    const paths = [];
    for (let i = 0; i < 30; i++) paths.push(`- src/a/f${i}.js`);
    for (let i = 0; i < 10; i++) paths.push(`- src/b/g${i}.js`);
    const input = [
      "Result of search in '/Users/x' (total 40 files):",
      ...paths
    ].join("\n");
    const out = searchList(input);
    expect(out).toContain("Result of search in");
    expect(out).toContain("40 files in 2 dirs:");
    expect(out).toContain("src/a/ (30):");
    expect(out).toContain("src/b/ (10):");
    expect(out).toMatch(/\+\d+/);
    expect(out.length).toBeLessThan(input.length);
  });
});

describe("autoDetectFilter (extras)", () => {
  it("detects tree via box-drawing glyphs", () => {
    expect(autoDetectFilter(".\n├── src\n│   └── main.rs\n└── Cargo.toml\n").filterName).toBe("tree");
  });
  it("detects ls via total + perms rows", () => {
    const input = [
      "total 48",
      "drwxr-xr-x  2 user staff   64 Jan  1 12:00 src",
      "-rw-r--r--  1 user staff 1234 Jan  1 12:00 main.js",
      "-rw-r--r--  1 user staff 5678 Jan  1 12:00 README.md"
    ].join("\n");
    expect(autoDetectFilter(input).filterName).toBe("ls");
  });
  it("detects Cursor search list", () => {
    const input = "Result of search in '/x' (total 3 files):\n- a/b.js\n- a/c.js\n- a/d.js";
    expect(autoDetectFilter(input).filterName).toBe("search-list");
  });
});

describe("safeApply", () => {
  it("returns input if filter throws", () => {
    const out = safeApply(() => { throw new Error("boom"); }, "hello");
    expect(out).toBe("hello");
  });
  it("returns input if filter returns non-string", () => {
    const out = safeApply(() => 42, "hello");
    expect(out).toBe("hello");
  });
});

describe("compressMessages (disabled)", () => {

  it("returns null when disabled", () => {
    const body = { messages: [{ role: "tool", tool_call_id: "x", content: makeLongDiff() }] };
    expect(compressMessages(body, false)).toBeNull();
  });
});

describe("compressMessages (enabled)", () => {


  it("compresses OpenAI tool message (string content)", () => {
    const big = makeLongDiff();
    const body = { messages: [{ role: "tool", tool_call_id: "call_1", content: big }] };
    const stats = compressMessages(body, true);
    expect(stats.hits.length).toBeGreaterThan(0);
    expect(body.messages[0].content.length).toBeLessThan(big.length);
    expect(stats.bytesBefore).toBeGreaterThan(stats.bytesAfter);
  });

  it("compresses Claude string-form tool_result", () => {
    const big = makeLongDiff();
    const body = {
      messages: [{
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: big }]
      }]
    };
    const stats = compressMessages(body, true);
    expect(stats.hits.length).toBeGreaterThan(0);
    expect(body.messages[0].content[0].content.length).toBeLessThan(big.length);
  });

  it("compresses Claude array-form tool_result text parts", () => {
    const big = makeLongDiff();
    const body = {
      messages: [{
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: [{ type: "text", text: big }, { type: "text", text: "unchanged short" }]
        }]
      }]
    };
    const stats = compressMessages(body, true);
    expect(stats.hits.length).toBeGreaterThan(0);
    expect(body.messages[0].content[0].content[0].text.length).toBeLessThan(big.length);
    // short part unchanged
    expect(body.messages[0].content[0].content[1].text).toBe("unchanged short");
  });

  it("skips is_error tool_result", () => {
    const big = makeLongDiff();
    const body = {
      messages: [{
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: big, is_error: true }]
      }]
    };
    const stats = compressMessages(body, true);
    expect(stats.hits.length).toBe(0);
    expect(body.messages[0].content[0].content).toBe(big);
  });

  it("skips below MIN_COMPRESS_SIZE (<500 bytes)", () => {
    const small = "diff --git a/x b/x\n@@ -1 +1 @@\n+a";
    const body = { messages: [{ role: "tool", tool_call_id: "x", content: small }] };
    const stats = compressMessages(body, true);
    expect(stats.hits.length).toBe(0);
    expect(body.messages[0].content).toBe(small);
  });

  it("never produces empty content (R14 guard)", () => {
    const input = "a".repeat(1000);
    const body = { messages: [{ role: "tool", tool_call_id: "x", content: input }] };
    compressMessages(body, true);
    expect(body.messages[0].content.length).toBeGreaterThan(0);
  });

  it("skips when body has no messages", () => {
    expect(compressMessages({}, false)).toBeNull();
    expect(compressMessages({ messages: null }, false)).toBeNull();
  });

  it("handles mix of messages without crashing", () => {
    const body = {
      messages: [
        { role: "system", content: "you are" },
        { role: "user", content: "hi" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", function: { name: "x", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: makeGrepOutput() },
        { role: "user", content: [{ type: "text", text: "next" }] }
      ]
    };
    const stats = compressMessages(body, true);
    expect(stats).not.toBeNull();
    expect(stats.hits.length).toBeGreaterThan(0);
  });

  it("compresses 400 unique lines via smart-truncate", () => {
    const big = makeUniqueLines(400);
    const body = { messages: [{ role: "tool", tool_call_id: "x", content: big }] };
    const stats = compressMessages(body, true);
    expect(stats.hits.length).toBeGreaterThan(0);
    expect(stats.hits[0].filter).toBe("smart-truncate");
    expect(stats.bytesAfter).toBeLessThan(stats.bytesBefore);
    expect(body.messages[0].content.length).toBeLessThan(big.length);
  });

  it("compresses duplicate-heavy smaller payloads via dedup-log", () => {
    const big = makeDuplicateHeavyLog();
    const body = { messages: [{ role: "tool", tool_call_id: "x", content: big }] };
    const stats = compressMessages(body, true);
    expect(stats.hits.length).toBeGreaterThan(0);
    expect(stats.hits[0].filter).toBe("dedup-log");
    expect(stats.bytesAfter).toBeLessThan(stats.bytesBefore);
    expect(body.messages[0].content.length).toBeLessThan(big.length);
  });
});

describe("compressMessages Kiro format cache boundary", () => {
  function makeKiroBody(toolText, { cacheOnHistoryIndex = -1 } = {}) {
    const big = toolText ?? makeLongDiff();
    const history = [
      {
        userInputMessage: {
          content: "earlier",
          userInputMessageContext: {
            toolResults: [{ content: [{ text: big }] }]
          }
        }
      },
      {
        userInputMessage: {
          content: "cached turn",
          ...(cacheOnHistoryIndex === 1 ? { cache_control: { type: "ephemeral" } } : {}),
          userInputMessageContext: {
            toolResults: [{ content: [{ text: big }] }]
          }
        }
      }
    ];
    return {
      conversationState: {
        history,
        currentMessage: {
          userInputMessage: {
            content: "current",
            userInputMessageContext: {
              toolResults: [{ content: [{ text: makeGrepOutput() }] }]
            }
          }
        }
      }
    };
  }

  it("compresses Kiro tool results when no cache boundary", () => {
    const body = makeKiroBody();
    const stats = compressMessages(body, true);
    expect(stats.hits.length).toBeGreaterThan(0);
  });

  it("skips Kiro tool results at or before cache boundary in history", () => {
    const big = makeLongDiff();
    const body = makeKiroBody(big, { cacheOnHistoryIndex: 1 });
    const beforeLen = body.conversationState.history[0].userInputMessage.userInputMessageContext.toolResults[0].content[0].text.length;
    const atCacheLen = body.conversationState.history[1].userInputMessage.userInputMessageContext.toolResults[0].content[0].text.length;
    const stats = compressMessages(body, true);
    expect(body.conversationState.history[0].userInputMessage.userInputMessageContext.toolResults[0].content[0].text.length).toBe(beforeLen);
    expect(body.conversationState.history[1].userInputMessage.userInputMessageContext.toolResults[0].content[0].text.length).toBe(atCacheLen);
    expect(stats.hits.length).toBeGreaterThan(0); // currentMessage after boundary
  });

});

describe("cache boundary preservation (Task 11.1)", () => {
  it("findLastCacheBoundary returns index of last cache_control message", () => {
    const messages = [
      { role: "user", content: "a" },
      { role: "assistant", content: [{ type: "text", text: "b", cache_control: { type: "ephemeral" } }] },
      { role: "user", content: "c" },
    ];
    expect(findLastCacheBoundary(messages)).toBe(1);
  });

  it("findLastCacheBoundary returns -1 when no cache_control present", () => {
    expect(findLastCacheBoundary([{ role: "user", content: "hi" }])).toBe(-1);
  });

  it("does not compress messages at or before cache_control boundary", () => {
    const protectedTool = makeLongDiff();
    const compressible = makeLongDiff();
    const body = {
      messages: [
        { role: "user", content: "prefix" },
        { role: "tool", tool_call_id: "protected", content: protectedTool },
        { role: "assistant", content: "cached turn", cache_control: { type: "ephemeral" } },
        { role: "tool", tool_call_id: "after", content: compressible },
      ],
    };
    const beforeProtected = body.messages[1].content;
    const stats = compressMessages(body, true);
    expect(body.messages[1].content).toBe(beforeProtected);
    expect(body.messages[2].content).toBe("cached turn");
    expect(body.messages[3].content.length).toBeLessThan(compressible.length);
    expect(stats.hits.length).toBeGreaterThan(0);
  });
});

describe("RTK secondary fallback (Tasks 11.6–11.7)", () => {
  it("uses smart-truncate when no named filter matches large unstructured blob", () => {
    const input = Array.from({ length: 400 }, (_, i) => `unique unstructured line ${i} ${"z".repeat(40)}`).join("\n");
    const body = { messages: [{ role: "tool", tool_call_id: "x", content: input }] };
    const stats = compressMessages(body, true);
    expect(stats.hits.some((h) => h.filter === "smart-truncate")).toBe(true);
    expect(body.messages[0].content.length).toBeLessThan(input.length);
  });

  it("uses git-diff filter when detected and smaller than input", () => {
    const input = makeLongDiff();
    const body = { messages: [{ role: "tool", tool_call_id: "x", content: input }] };
    const stats = compressMessages(body, true);
    expect(stats.hits.some((h) => h.filter === "git-diff")).toBe(true);
    expect(stats.hits.some((h) => h.filter === "smart-truncate")).toBe(false);
  });

});

describe("RTK Gemini contents", () => {
  it("compresses functionResponse tool output in body.contents", () => {
    const input = makeLongDiff();
    const body = {
      contents: [{
        role: "user",
        parts: [{
          functionResponse: {
            id: "call_1",
            name: "read_file",
            response: { result: input },
          },
        }],
      }],
    };
    const stats = compressMessages(body, true);
    expect(stats).not.toBeNull();
    expect(stats.bytesBefore).toBeGreaterThan(0);
    expect(stats.hits.length).toBeGreaterThan(0);
    const result = body.contents[0].parts[0].functionResponse.response.result;
    const resultText = typeof result === "string" ? result : JSON.stringify(result);
    expect(resultText.length).toBeLessThan(input.length);
  });

  it("compresses functionResponse in antigravity body.request.contents", () => {
    const input = makeGrepOutput();
    const body = {
      request: {
        contents: [{
          role: "user",
          parts: [{
            functionResponse: {
              id: "call_2",
              name: "grep",
              response: { result: input },
            },
          }],
        }],
      },
    };
    const stats = compressMessages(body, true);
    expect(stats).not.toBeNull();
    expect(stats.hits.some((h) => h.filter === "grep")).toBe(true);
  });
});

describe("formatRtkLog", () => {
  it("returns null when no hits", () => {
    expect(formatRtkLog({ bytesBefore: 0, bytesAfter: 0, hits: [] })).toBeNull();
  });
  it("formats savings line with percentage", () => {
    const line = formatRtkLog({ bytesBefore: 1000, bytesAfter: 400, hits: [{ filter: "git-diff" }] });
    expect(line).toContain("saved 600B");
    expect(line).toContain("60.0%");
    expect(line).toContain("git-diff");
  });
});
