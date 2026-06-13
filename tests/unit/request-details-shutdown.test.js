import { describe, expect, it, vi } from "vitest";

describe("request detail shutdown behavior", () => {
  it("does not install process shutdown or signal listeners on import", async () => {
    const events = ["SIGINT", "SIGTERM", "beforeExit", "exit"];
    const before = Object.fromEntries(events.map((event) => [event, process.listenerCount(event)]));

    vi.resetModules();
    await import("@/lib/db/repos/requestDetailsRepo.js");

    const after = Object.fromEntries(events.map((event) => [event, process.listenerCount(event)]));
    expect(after).toEqual(before);
  });
});
