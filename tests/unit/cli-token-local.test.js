import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getConsistentMachineId: vi.fn(),
}));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: mocks.getConsistentMachineId,
}));

function makeRequest({ host = "localhost:20128", cliToken, socketIp } = {}) {
  const headers = new Headers({ host });
  if (cliToken !== undefined) headers.set("x-9r-cli-token", cliToken);
  return {
    headers,
    socket: socketIp ? { remoteAddress: socketIp } : undefined,
    ip: socketIp || undefined,
  };
}

describe("hasValidLocalCliToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
  });

  it("accepts matching CLI token from verifiable loopback socket", async () => {
    const { hasValidLocalCliToken } = await import("../../src/shared/auth/cliToken.js");
    expect(await hasValidLocalCliToken(makeRequest({ cliToken: "cli-token", socketIp: "127.0.0.1" }))).toBe(true);
  });

  it("rejects matching CLI token when loopback Host has no socket IP", async () => {
    const { hasValidLocalCliToken } = await import("../../src/shared/auth/cliToken.js");
    expect(await hasValidLocalCliToken(makeRequest({ cliToken: "cli-token" }))).toBe(false);
  });

  it("rejects matching CLI token from private LAN socket by default", async () => {
    const { hasValidLocalCliToken } = await import("../../src/shared/auth/cliToken.js");
    expect(await hasValidLocalCliToken(makeRequest({
      host: "192.168.8.201:20128",
      cliToken: "cli-token",
      socketIp: "192.168.8.50",
    }))).toBe(false);
  });

  it("accepts matching CLI token from private LAN socket when GENESIS_CLI_TOKEN_ALLOW_LAN=1", async () => {
    const prev = process.env.GENESIS_CLI_TOKEN_ALLOW_LAN;
    process.env.GENESIS_CLI_TOKEN_ALLOW_LAN = "1";
    try {
      const { hasValidLocalCliToken } = await import("../../src/shared/auth/cliToken.js");
      expect(await hasValidLocalCliToken(makeRequest({
        host: "192.168.8.201:20128",
        cliToken: "cli-token",
        socketIp: "192.168.8.50",
      }))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.GENESIS_CLI_TOKEN_ALLOW_LAN;
      else process.env.GENESIS_CLI_TOKEN_ALLOW_LAN = prev;
    }
  });

  it("rejects matching CLI token from public host", async () => {
    const { hasValidLocalCliToken } = await import("../../src/shared/auth/cliToken.js");
    expect(await hasValidLocalCliToken(makeRequest({
      host: "router.example.com",
      cliToken: "cli-token",
      socketIp: "203.0.113.9",
    }))).toBe(false);
  });

  it("rejects matching CLI token when LAN Host is spoofed by public socket", async () => {
    const { hasValidLocalCliToken } = await import("../../src/shared/auth/cliToken.js");
    expect(await hasValidLocalCliToken(makeRequest({
      host: "192.168.8.201:20128",
      cliToken: "cli-token",
      socketIp: "203.0.113.9",
    }))).toBe(false);
  });
});
