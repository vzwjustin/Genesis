import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const {
  extractRedactedToolCalls,
  stripRedactedToolCalls,
  RedactedToolContentProcessor,
} = require("../../src/mitm/handlers/composerRedactedTools.js");

// Build tokens via concat — literal "redacted"/"kimi" substrings can be stripped by tooling.
const RT = "redacted_";
const KM = "_kimi";

const COMPOSER_SAMPLE =
  "Reading spec. <|" +
  RT +
  "tool_calls_begin|><|" +
  RT +
  "tool_call_begin|> read_file <|" +
  RT +
  "tool_sep|>target /tmp/foo <|" +
  RT +
  "tool_call_end|><|" +
  RT +
  "tool_call_begin|> read_file <|" +
  RT +
  "tool_sep|>target_file /tmp/bar <|" +
  RT +
  "tool_call_end|><|" +
  RT +
  "tool_calls_end|>";

const KIMI_SAMPLE =
  "Continuing. <|tool_calls_begin|><|" +
  RT +
  "tool_call_begin" +
  KM +
  "|> read_file <|tool_sep|>target_file /tmp/a <|" +
  RT +
  "tool_call_end" +
  KM +
  "|><|" +
  RT +
  "tool_call_begin" +
  KM +
  "|> grep <|tool_sep|>pattern ^## <|tool_sep|>path /tmp/b <|tool_sep|>head_limit 120 <|" +
  RT +
  "tool_call_end" +
  KM +
  "|><|tool_calls_end|>";

describe("composer redacted tool tokens", () => {
  it("parses Composer redacted_tool_* blocks", () => {
    const calls = extractRedactedToolCalls(COMPOSER_SAMPLE);
    expect(calls).toHaveLength(2);
    expect(calls[0].name).toBe("read_file");
    expect(JSON.parse(calls[0].input)).toEqual({ target: "/tmp/foo" });
    expect(JSON.parse(calls[1].input)).toEqual({ target_file: "/tmp/bar" });
  });

  it("parses Kimi tool_calls_* blocks with multiple tool_sep args", () => {
    const calls = extractRedactedToolCalls(KIMI_SAMPLE);
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0].input)).toEqual({ target_file: "/tmp/a" });
    expect(JSON.parse(calls[1].input)).toEqual({
      pattern: "^##",
      path: "/tmp/b",
      head_limit: "120",
    });
  });

  it("strips all block variants from visible text", () => {
    expect(stripRedactedToolCalls(COMPOSER_SAMPLE)).toBe("Reading spec.");
    expect(stripRedactedToolCalls(KIMI_SAMPLE)).toBe("Continuing.");
  });

  it("handles markers split across streaming chunks (Kimi)", () => {
    const proc = new RedactedToolContentProcessor();
    const a = proc.processChunk("Hi. <|tool_calls_beg");
    expect(a.text).toBe("Hi. ");
    expect(a.toolCalls).toHaveLength(0);

    const b = proc.processChunk(
      "in|><|" +
        RT +
        "tool_call_begin" +
        KM +
        "|> read_file <|tool_sep|>target_file /x <|" +
        RT +
        "tool_call_end" +
        KM +
        "|><|tool_calls_end|>"
    );
    expect(b.text).toBe("");
    expect(b.toolCalls).toHaveLength(1);
    expect(b.toolCalls[0].name).toBe("read_file");
  });
});
