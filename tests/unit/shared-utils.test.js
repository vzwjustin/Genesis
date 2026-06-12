import { describe, it, expect, vi, afterEach } from "vitest";
import { getRelativeTime } from "../../src/shared/utils/index.js";

describe("getRelativeTime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns empty string for falsy input", () => {
    expect(getRelativeTime(null)).toBe("");
    expect(getRelativeTime(undefined)).toBe("");
    expect(getRelativeTime("")).toBe("");
  });

  it("returns empty string for invalid dates", () => {
    expect(getRelativeTime("not-a-date")).toBe("");
    expect(getRelativeTime("Invalid Date")).toBe("");
  });

  it("returns just now for recent timestamps", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-11T12:00:00Z"));
    expect(getRelativeTime("2026-06-11T11:59:30Z")).toBe("just now");
  });

  it("formats minutes, hours, and days", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-11T12:00:00Z"));
    expect(getRelativeTime("2026-06-11T11:30:00Z")).toBe("30m ago");
    expect(getRelativeTime("2026-06-11T09:00:00Z")).toBe("3h ago");
    expect(getRelativeTime("2026-06-09T12:00:00Z")).toBe("2d ago");
  });
});
