import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { getToolForHost, TARGET_HOSTS, MODEL_SYNONYMS } = require("../../src/mitm/config.js");
const {
  KIRO_MITM_HOSTS,
  isKiroMitmHost,
} = require("../../src/shared/constants/mitmToolHosts.js");

describe("mitm config — Kiro hosts", () => {
  it("maps Kiro runtime, commercial, and GovCloud AWS hosts to kiro", () => {
    expect(getToolForHost("runtime.us-east-1.kiro.dev")).toBe("kiro");
    expect(getToolForHost("runtime.eu-central-1.kiro.dev")).toBe("kiro");
    expect(getToolForHost("q.us-east-1.amazonaws.com")).toBe("kiro");
    expect(getToolForHost("q.eu-central-1.amazonaws.com")).toBe("kiro");
    expect(getToolForHost("q-fips.us-gov-east-1.amazonaws.com")).toBe("kiro");
    expect(getToolForHost("q.us-gov-east-1.amazonaws.com")).toBe("kiro");
    expect(getToolForHost("codewhisperer.us-east-1.amazonaws.com")).toBe("kiro");
    expect(getToolForHost("codewhisperer.eu-central-1.amazonaws.com")).toBe("kiro");
    expect(getToolForHost("codewhisperer.us-gov-west-1.amazonaws.com")).toBe("kiro");
    expect(getToolForHost("q.us-iso-east-1.c2s.ic.gov")).toBe("kiro");
  });

  it("does not treat auth, management, or telemetry as kiro chat hosts", () => {
    expect(getToolForHost("management.us-east-1.kiro.dev")).toBeNull();
    expect(getToolForHost("management.eu-central-1.kiro.dev")).toBeNull();
    expect(getToolForHost("prod.us-east-1.auth.desktop.kiro.dev")).toBeNull();
    expect(getToolForHost("prod.us-east-1.telemetry.desktop.kiro.dev")).toBeNull();
    expect(isKiroMitmHost("auth.kiro.dev")).toBe(false);
    expect(isKiroMitmHost("billing.kiro.dev")).toBe(false);
  });

  it("includes every enumerated Kiro MITM host in TARGET_HOSTS", () => {
    for (const host of KIRO_MITM_HOSTS) {
      expect(TARGET_HOSTS).toContain(host);
      expect(isKiroMitmHost(host)).toBe(true);
    }
  });

  it("normalizes common Kiro model id variants via MODEL_SYNONYMS", () => {
    expect(MODEL_SYNONYMS.kiro["claude-sonnet-4-6"]).toBe("claude-sonnet-4.6");
    expect(MODEL_SYNONYMS.kiro["claude-sonnet-4-5"]).toBe("claude-sonnet-4.6");
    expect(MODEL_SYNONYMS.kiro["CLAUDE_SONNET_4_20250514_V1_0"]).toBe("claude-sonnet-4.6");
    expect(MODEL_SYNONYMS.kiro.auto).toBe("claude-sonnet-4.6");
    expect(MODEL_SYNONYMS.kiro["qdev::auto"]).toBe("claude-sonnet-4.6");
    expect(MODEL_SYNONYMS.kiro["simple-task"]).toBe("qwen3-coder-next");
    expect(MODEL_SYNONYMS.kiro["minimax-m2.1"]).toBe("MiniMax-M2.5");
  });

  it("maps api2.cursor.sh to cursor tool", () => {
    expect(getToolForHost("api2.cursor.sh")).toBe("cursor");
  });
});
