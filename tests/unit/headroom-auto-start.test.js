/**
 * Headroom proxy auto-start gating
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const execSync = vi.fn();
const spawn = vi.fn();
const getHeadroomStatus = vi.fn();
const invalidateHeadroomProbe = vi.fn();

vi.mock("child_process", () => ({
  execSync: (...args) => execSync(...args),
  spawn: (...args) => spawn(...args),
}));

vi.mock("../../open-sse/rtk/headroom.js", () => ({
  getHeadroomStatus,
  invalidateHeadroomProbe,
}));

describe("autoStartHeadroomProxy", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.HEADROOM_AUTO_START;
    delete process.env.HEADROOM_API_KEY;
    delete process.env.HEADROOM_BASE_URL;
    delete process.env.HEADROOM_PORT;
    execSync.mockReset();
    spawn.mockReset();
    getHeadroomStatus.mockReset();
    invalidateHeadroomProbe.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("skips when HEADROOM_AUTO_START=false", async () => {
    process.env.HEADROOM_AUTO_START = "false";
    const { autoStartHeadroomProxy } = await import("../../src/shared/services/headroomManager.js");
    await autoStartHeadroomProxy();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("skips when HEADROOM_API_KEY is set (cloud mode)", async () => {
    process.env.HEADROOM_API_KEY = "hr_test";
    const { autoStartHeadroomProxy } = await import("../../src/shared/services/headroomManager.js");
    await autoStartHeadroomProxy();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("skips when headroom CLI is missing", async () => {
    execSync.mockImplementation(() => {
      throw new Error("missing");
    });
    const logSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { autoStartHeadroomProxy } = await import("../../src/shared/services/headroomManager.js");
    await autoStartHeadroomProxy();
    expect(spawn).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/Headroom CLI not found/));
    logSpy.mockRestore();
  });

  it("logs when proxy is already reachable", async () => {
    execSync.mockReturnValue(Buffer.from("0.23.0"));
    getHeadroomStatus.mockResolvedValue({ reachable: true, proxyUrl: "http://localhost:8787" });
    const logSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { autoStartHeadroomProxy } = await import("../../src/shared/services/headroomManager.js");
    await autoStartHeadroomProxy();
    expect(spawn).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith("[InitApp] Headroom proxy already reachable at http://localhost:8787");
    logSpy.mockRestore();
  });

  it("skips spawn when proxy is already reachable", async () => {
    execSync.mockReturnValue(Buffer.from("0.23.0"));
    getHeadroomStatus.mockResolvedValue({ reachable: true, proxyUrl: "http://localhost:8787" });
    const { autoStartHeadroomProxy } = await import("../../src/shared/services/headroomManager.js");
    await autoStartHeadroomProxy();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("spawns headroom proxy when CLI exists and proxy is down", async () => {
    execSync.mockReturnValue(Buffer.from("0.23.0"));
    getHeadroomStatus
      .mockResolvedValueOnce({ reachable: false, proxyUrl: "http://localhost:8787" })
      .mockResolvedValue({ reachable: true, proxyUrl: "http://localhost:8787" });

    const fakeChild = {
      stderr: { on: vi.fn() },
      on: vi.fn(),
      pid: 4242,
    };
    spawn.mockReturnValue(fakeChild);

    const { autoStartHeadroomProxy } = await import("../../src/shared/services/headroomManager.js");
    await autoStartHeadroomProxy();

    expect(spawn).toHaveBeenCalledWith(
      "headroom",
      ["proxy", "--port", "8787"],
      expect.objectContaining({
        env: expect.objectContaining({ HEADROOM_PORT: "8787" }),
      })
    );
  });
});
