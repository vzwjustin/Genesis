/**
 * Request logging tests (Task 17)
 * Requirements: 12.4, 12.5
 */
import { describe, it, expect } from "vitest";
import { formatLogFolderPrefix } from "../../open-sse/utils/requestLogger.js";

describe("request log folder naming (Task 17.6)", () => {
  it("labels passthrough sessions with passthrough_ prefix", () => {
    const prefix = formatLogFolderPrefix("claude", "claude", "claude-sonnet", { passthrough: true });
    expect(prefix).toBe("passthrough_claude_claude_claude-sonnet");
  });

  it("uses normal prefix for translated sessions", () => {
    const prefix = formatLogFolderPrefix("openai", "claude", "claude-sonnet", { passthrough: false });
    expect(prefix).toBe("openai_claude_claude-sonnet");
  });

  it("sanitizes model slashes in folder prefix", () => {
    const prefix = formatLogFolderPrefix("openai", "openai", "anthropic/claude-sonnet");
    expect(prefix).toBe("openai_openai_anthropic-claude-sonnet");
  });
});
