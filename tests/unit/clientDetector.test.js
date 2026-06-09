import { describe, it, expect } from "vitest";
import { detectClientTool, isNativePassthrough } from "../../open-sse/utils/clientDetector.js";

// ============================================================================
// detectClientTool — identifies the CLI/SDK tool from request headers and body
// ============================================================================

describe("detectClientTool", () => {
  // --- Claude CLI / Claude Code ---
  it("detects Claude CLI from user-agent", () => {
    expect(detectClientTool({ "user-agent": "claude-cli/2.1.92 (external, sdk-cli)" }, {})).toBe("claude");
  });

  it("detects Claude Code from user-agent", () => {
    expect(detectClientTool({ "user-agent": "claude-code/1.0.0" }, {})).toBe("claude");
  });

  it("detects Claude CLI from x-app header", () => {
    expect(detectClientTool({ "x-app": "cli" }, {})).toBe("claude");
  });

  // --- OpenAI SDK ---
  it("detects OpenAI Python SDK from user-agent", () => {
    expect(detectClientTool({ "user-agent": "OpenAI/Python 1.52.0" }, {})).toBe("openai");
  });

  it("detects OpenAI Node SDK from user-agent", () => {
    expect(detectClientTool({ "user-agent": "OpenAI/Node 4.73.0" }, {})).toBe("openai");
  });

  it("detects openai-python legacy user-agent", () => {
    expect(detectClientTool({ "user-agent": "openai-python/0.27.0" }, {})).toBe("openai");
  });

  it("detects openai-node legacy user-agent", () => {
    expect(detectClientTool({ "user-agent": "openai-node/3.0.0" }, {})).toBe("openai");
  });

  // --- Cursor ---
  it("detects Cursor from user-agent containing 'cursor'", () => {
    expect(detectClientTool({ "user-agent": "cursor/3.1.0" }, {})).toBe("cursor");
  });

  it("detects Cursor from x-cursor-client-version header", () => {
    expect(detectClientTool({ "x-cursor-client-version": "3.1.0" }, {})).toBe("cursor");
  });

  it("detects Cursor from connect-protocol-version header", () => {
    expect(detectClientTool({ "connect-protocol-version": "1" }, {})).toBe("cursor");
  });

  // --- Gemini CLI ---
  it("detects Gemini CLI from user-agent", () => {
    expect(detectClientTool({ "user-agent": "gemini-cli/1.0.0" }, {})).toBe("gemini-cli");
  });

  // --- Codex CLI ---
  it("detects Codex CLI from user-agent", () => {
    expect(detectClientTool({ "user-agent": "codex-cli/1.0.18 (macOS; arm64)" }, {})).toBe("codex");
  });

  // --- Antigravity ---
  it("detects Antigravity from body.userAgent field", () => {
    expect(detectClientTool({}, { userAgent: "antigravity" })).toBe("antigravity");
  });

  // --- GitHub Copilot ---
  it("detects GitHub Copilot from user-agent", () => {
    expect(detectClientTool({ "user-agent": "GitHubCopilotChat/0.38.0" }, {})).toBe("github-copilot");
  });

  it("detects GitHub Copilot from openai-intent header", () => {
    expect(detectClientTool({ "openai-intent": "conversation-panel" }, {})).toBe("github-copilot");
  });

  it("does not detect github-copilot from x-initiator alone", () => {
    expect(detectClientTool({ "x-initiator": "user" }, {})).toBeNull();
  });

  // --- DeepSeek TUI ---
  it("detects DeepSeek TUI from user-agent", () => {
    expect(detectClientTool({ "user-agent": "deepseek-tui/1.0.0" }, {})).toBe("deepseek-tui");
  });

  // --- Unknown / null ---
  it("returns null for unknown user-agent", () => {
    expect(detectClientTool({ "user-agent": "my-custom-tool/1.0" }, {})).toBeNull();
  });

  it("returns null for empty headers", () => {
    expect(detectClientTool({}, {})).toBeNull();
  });
});

// ============================================================================
// isNativePassthrough — determines if client/provider pair enables passthrough
// (also referenced as "passthru" in some parts of the codebase)
// ============================================================================

describe("isNativePassthrough", () => {
  // --- Claude CLI → Anthropic (passthrough / passthru) ---
  it("Claude CLI → claude provider is passthrough", () => {
    expect(isNativePassthrough("claude", "claude")).toBe(true);
  });

  it("Claude CLI → anthropic provider is passthrough", () => {
    expect(isNativePassthrough("claude", "anthropic")).toBe(true);
  });

  it("Claude CLI → anthropic-compatible-x variant is passthrough", () => {
    expect(isNativePassthrough("claude", "anthropic-compatible-minimax")).toBe(true);
  });

  // --- OpenAI SDK → OpenAI (passthrough / passthru) ---
  it("OpenAI SDK → openai provider is passthrough", () => {
    expect(isNativePassthrough("openai", "openai")).toBe(true);
  });

  it("OpenAI SDK → claude provider is NOT passthrough", () => {
    expect(isNativePassthrough("openai", "claude")).toBe(false);
  });

  it("OpenAI SDK → gemini provider is NOT passthrough", () => {
    expect(isNativePassthrough("openai", "gemini")).toBe(false);
  });

  // --- Cursor → Cursor (passthrough / passthru) ---
  it("Cursor → cursor provider is passthrough", () => {
    expect(isNativePassthrough("cursor", "cursor")).toBe(true);
  });

  it("Cursor → openai provider is NOT passthrough", () => {
    expect(isNativePassthrough("cursor", "openai")).toBe(false);
  });

  // --- Gemini CLI → Gemini CLI ---
  it("Gemini CLI → gemini-cli provider is passthrough", () => {
    expect(isNativePassthrough("gemini-cli", "gemini-cli")).toBe(true);
  });

  // --- Antigravity → Antigravity ---
  it("Antigravity → antigravity provider is passthrough", () => {
    expect(isNativePassthrough("antigravity", "antigravity")).toBe(true);
  });

  // --- Codex → Codex ---
  it("Codex CLI → codex provider is passthrough", () => {
    expect(isNativePassthrough("codex", "codex")).toBe(true);
  });

  // --- Cross-ecosystem: NOT passthrough ---
  it("Claude CLI → openai provider is NOT passthrough", () => {
    expect(isNativePassthrough("claude", "openai")).toBe(false);
  });

  it("OpenAI SDK → cursor provider is NOT passthrough", () => {
    expect(isNativePassthrough("openai", "cursor")).toBe(false);
  });

  it("Cursor → claude provider is NOT passthrough", () => {
    expect(isNativePassthrough("cursor", "claude")).toBe(false);
  });

  // --- Edge cases ---
  it("null clientTool always returns false", () => {
    expect(isNativePassthrough(null, "openai")).toBe(false);
  });

  it("unknown clientTool returns false", () => {
    expect(isNativePassthrough("unknown-tool", "openai")).toBe(false);
  });

  it("github-copilot is NOT natively paired with any provider", () => {
    expect(isNativePassthrough("github-copilot", "openai")).toBe(false);
    expect(isNativePassthrough("github-copilot", "github")).toBe(false);
  });

  it("deepseek-tui is NOT natively paired with any provider", () => {
    expect(isNativePassthrough("deepseek-tui", "deepseek")).toBe(false);
  });
});
