import { describe, it, expect, afterEach } from "vitest";
import os from "node:os";

describe("getCliHomeDir", () => {
  const original = process.env.CLI_HOME;

  afterEach(() => {
    if (original === undefined) delete process.env.CLI_HOME;
    else process.env.CLI_HOME = original;
  });

  it("defaults to process homedir", async () => {
    delete process.env.CLI_HOME;
    const { getCliHomeDir } = await import("../../src/shared/utils/cliHome.js");
    expect(getCliHomeDir()).toBe(os.homedir());
  });

  it("uses CLI_HOME when set", async () => {
    process.env.CLI_HOME = "/root";
    const { getCliHomeDir } = await import("../../src/shared/utils/cliHome.js");
    expect(getCliHomeDir()).toBe("/root");
  });
});
