// Tests for compression pipeline bug fixes (gitDiff, buildOutput, dedupLog)
// Fix 1 (headroomManager) tests live in headroom-auto-start.test.js
import { describe, it, expect } from "vitest";
import { gitDiff } from "../../open-sse/rtk/filters/gitDiff.js";
import { buildOutput } from "../../open-sse/rtk/filters/buildOutput.js";
import { dedupLog } from "../../open-sse/rtk/filters/dedupLog.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fix 2: gitDiff — leading context lines in a hunk must not be dropped
// ─────────────────────────────────────────────────────────────────────────────
describe("gitDiff — leading context lines preserved (fix: removed hunkShown>0 guard)", () => {
  it("emits context lines that appear before the first +/- line in a hunk", () => {
    const diff = [
      "diff --git a/foo.js b/foo.js",
      "--- a/foo.js",
      "+++ b/foo.js",
      "@@ -1,5 +1,5 @@",
      " context line 1",  // leading context — was silently dropped before fix
      " context line 2",
      "-removed line",
      "+added line",
      " trailing context",
    ].join("\n");

    const out = gitDiff(diff, 500);

    expect(out).toContain("context line 1");
    expect(out).toContain("context line 2");
    expect(out).toContain("-removed line");
    expect(out).toContain("+added line");
    expect(out).toContain("trailing context");
  });

  it("counts leading context lines against the hunk line cap", () => {
    // Build a hunk with 5 leading context lines then many added lines
    const lines = [
      "diff --git a/x.js b/x.js",
      "--- a/x.js",
      "+++ b/x.js",
      "@@ -1,110 +1,110 @@",
    ];
    for (let i = 0; i < 5; i++) lines.push(` context ${i}`);
    for (let i = 0; i < 110; i++) lines.push(`+added ${i}`);
    const diff = lines.join("\n");

    const out = gitDiff(diff, 500);

    // Leading context lines must appear
    expect(out).toContain("context 0");
    expect(out).toContain("context 4");
    // Overflow annotation present because total lines exceed cap
    expect(out).toContain("lines truncated");
  });

  it("hunk with only context lines (no +/-) still emits them", () => {
    const diff = [
      "diff --git a/a.rs b/a.rs",
      "--- a/a.rs",
      "+++ b/a.rs",
      "@@ -1,3 +1,3 @@",
      " line one",
      " line two",
      " line three",
    ].join("\n");

    const out = gitDiff(diff, 500);

    expect(out).toContain("line one");
    expect(out).toContain("line two");
    expect(out).toContain("line three");
  });

  it("silently drops context lines beyond maxHunkLines (only +/- overflow triggers annotation)", () => {
    const lines = [
      "diff --git a/big.rs b/big.rs",
      "--- a/big.rs",
      "+++ b/big.rs",
      "@@ -1,200 +1,200 @@",
    ];
    // 200 context lines — all leading, none are +/-
    for (let i = 0; i < 200; i++) lines.push(` ctx ${i}`);
    const diff = lines.join("\n");

    const out = gitDiff(diff, 500);

    // First context line should appear (leading context preserved by the fix)
    expect(out).toContain("ctx 0");
    // The cap (GIT_DIFF_HUNK_MAX_LINES = 100) stops output at ctx 99
    expect(out).toContain("ctx 99");
    // Lines beyond the cap are silently dropped — context overflow does not
    // produce a "lines truncated" annotation (only +/- overflow does)
    expect(out).not.toContain("ctx 100");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fix 3: buildOutput — Rust warning continuation lines route to warnings
// ─────────────────────────────────────────────────────────────────────────────
describe("buildOutput — Rust warning continuations route to warnings, not errors", () => {
  it("warning continuation lines appear in output (not silently dropped as error continuations)", () => {
    // Keep the block short so all continuation lines fit within the 5-warning display limit
    const input = [
      "warning[W0001]: unused variable: `x`",
      "  --> src/main.rs:3:9",
      "   |",
      "3  |     let x = 5;",
    ].join("\n");

    const out = buildOutput(input);

    // The warning header AND its continuation lines must all be present
    expect(out).toContain("warning[W0001]");
    expect(out).toContain("src/main.rs:3:9");
    expect(out).toContain("3  |     let x = 5;");
  });

  it("warning continuations do not bleed into the errors list", () => {
    const input = [
      "warning[W0001]: dead_code",
      "  --> src/lib.rs:10:5",
      "   |",
      "10 |     fn unused() {}",
      "   |        ^^^^^^",
      "",
      "error[E0308]: mismatched types",
      "  --> src/main.rs:5:9",
      "   |",
      "5  |     let x: u32 = \"hello\";",
      "   |                  ^^^^^^^ expected `u32`, found `&str`",
    ].join("\n");

    const out = buildOutput(input);

    // Both the error and the warning must be present
    expect(out).toContain("error[E0308]");
    expect(out).toContain("warning[W0001]");

    // Warning continuation ("src/lib.rs:10:5") should not appear inside the
    // errors section — check it's present but the error block is still intact
    expect(out).toContain("src/lib.rs:10:5");
    expect(out).toContain("src/main.rs:5:9");
  });

  it("warning block terminated by blank line does not contaminate subsequent lines", () => {
    const input = [
      "warning[W0002]: unused import",
      "  --> src/lib.rs:1:5",
      "   |",
      "1  |     use std::fmt;",
      "   |         ^^^^^^^^",
      "",
      "   Compiling mylib v0.1.0",
      "    Finished `dev` profile in 0.50s",
    ].join("\n");

    const out = buildOutput(input);

    expect(out).toContain("warning[W0002]");
    // The Compiling line should be counted as compiled, not leaked into warnings
    expect(out).toContain("Compiled 1 packages");
    expect(out).toContain("Finished");
  });

  it("error continuation lines still route to errors (regression guard)", () => {
    const input = [
      "error[E0308]: mismatched types",
      "  --> src/main.rs:5:9",
      "   |",
      "5  |     let x: u32 = \"hello\";",
      "   |                  ^^^^^^^ expected `u32`, found `&str`",
    ].join("\n");

    const out = buildOutput(input);

    expect(out).toContain("error[E0308]");
    expect(out).toContain("src/main.rs:5:9");
    expect(out).toContain("expected `u32`");
  });

  it("interleaved errors and warnings both produce correct continuation routing", () => {
    const input = [
      "warning[W0001]: unused variable `y`",
      "  --> src/a.rs:2:9",
      "   |",
      "2  |     let y = 10;",
      "",
      "error[E0412]: cannot find type `Foo`",
      "  --> src/b.rs:8:12",
      "   |",
      "8  |     let f: Foo = bar();",
      "   |            ^^^ not found in this scope",
    ].join("\n");

    const out = buildOutput(input);

    expect(out).toContain("warning[W0001]");
    expect(out).toContain("src/a.rs:2:9");
    expect(out).toContain("error[E0412]");
    expect(out).toContain("src/b.rs:8:12");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fix 4: dedupLog — flushRun must emit BEFORE the blank line, not after
// ─────────────────────────────────────────────────────────────────────────────
describe("dedupLog — duplicate-count annotation appears before blank line", () => {
  it("annotation precedes the blank line separator", () => {
    const lines = [
      "repeated",
      "repeated",
      "repeated",
      "",
      "next section",
    ];
    const input = lines.join("\n");
    const out = dedupLog(input);

    const annotationIdx = out.indexOf("duplicate lines");
    const blankIdx = out.indexOf("\n\n");

    expect(annotationIdx).toBeGreaterThanOrEqual(0);
    // The "... (N duplicate lines)" text must appear before the blank separator
    expect(annotationIdx).toBeLessThan(blankIdx === -1 ? Infinity : blankIdx);
  });

  it("blank line still appears after the annotation", () => {
    const input = [
      "dup",
      "dup",
      "dup",
      "",
      "after",
    ].join("\n");

    const out = dedupLog(input);
    const parts = out.split("\n");

    // Find the annotation line
    const annIdx = parts.findIndex(l => l.includes("duplicate lines"));
    expect(annIdx).toBeGreaterThanOrEqual(0);

    // The line immediately after the annotation must be blank
    expect(parts[annIdx + 1]).toBe("");
  });

  it("no annotation emitted when there are no duplicates before blank line", () => {
    const input = ["alpha", "", "beta", "", "gamma"].join("\n");
    const out = dedupLog(input);
    expect(out).not.toContain("duplicate lines");
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
    expect(out).toContain("gamma");
  });

  it("multiple duplicate runs each flush before their separating blank", () => {
    const input = [
      "A", "A", "A",    // run of 3
      "",
      "B", "B",         // run of 2
      "",
      "C",
    ].join("\n");

    const out = dedupLog(input);
    const parts = out.split("\n");

    // Find first annotation (for A run)
    const ann1Idx = parts.findIndex(l => l.includes("duplicate lines"));
    expect(ann1Idx).toBeGreaterThanOrEqual(0);
    expect(parts[ann1Idx + 1]).toBe("");   // blank follows first annotation

    // Find second annotation (for B run) — must exist if B run > 1
    const ann2Idx = parts.findIndex((l, i) => i > ann1Idx && l.includes("duplicate lines"));
    expect(ann2Idx).toBeGreaterThanOrEqual(0);
    expect(parts[ann2Idx + 1]).toBe("");   // blank follows second annotation
  });

  it("trailing duplicates at end of input flush correctly (no blank line needed)", () => {
    const input = ["X", "X", "X"].join("\n");
    const out = dedupLog(input);
    expect(out).toContain("X");
    expect(out).toContain("duplicate lines");
    // No spurious blank at start
    expect(out.startsWith("\n")).toBe(false);
  });
});

