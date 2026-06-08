import { describe, expect, it } from "vitest";
import {
  getConnectionErrorTag,
  getConnectionErrorHint,
  getConnectionErrorLabel,
} from "../../src/shared/utils/connectionErrorUtils.js";

describe("connectionErrorUtils", () => {
  it("maps explicit lastErrorType to tags", () => {
    expect(getConnectionErrorTag({ lastErrorType: "upstream_auth_error" })).toBe("AUTH");
    expect(getConnectionErrorTag({ lastErrorType: "upstream_rate_limited" })).toBe("429");
    expect(getConnectionErrorTag({ lastErrorType: "network_error" })).toBe("NET");
    expect(getConnectionErrorTag({ lastErrorType: "runtime_error" })).toBe("RUNTIME");
  });

  it("infers auth from message when type is missing", () => {
    expect(getConnectionErrorTag({ lastError: "Invalid API key for provider" })).toBe("AUTH");
  });

  it("uses numeric errorCode when present", () => {
    expect(getConnectionErrorTag({ errorCode: 503 })).toBe("503");
  });

  it("returns actionable hints and labels", () => {
    expect(getConnectionErrorHint("AUTH")).toContain("OAuth");
    expect(getConnectionErrorHint("429")).toContain("Rate limited");
    expect(getConnectionErrorLabel("AUTH")).toBe("Auth");
    expect(getConnectionErrorLabel("503")).toBe("503");
    expect(getConnectionErrorLabel(null)).toBeNull();
  });
});
