import { describe, it, expect, vi } from "vitest";
import {
  buildKiroChatUrl,
  buildKiroListModelsUrl,
  buildKiroSocialAuthRefreshUrl,
  buildKiroFingerprintHeaders,
  regionFromProfileArn,
} from "../../open-sse/services/kiroHeaders.js";
import { KiroExecutor } from "../../open-sse/executors/kiro.js";

const EU_ARN = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/ABC";

describe("kiroHeaders — regional URLs", () => {
  it("derives region from profileArn", () => {
    expect(regionFromProfileArn(EU_ARN)).toBe("eu-central-1");
    expect(regionFromProfileArn("")).toBe("us-east-1");
  });

  it("builds regional chat and catalog URLs", () => {
    const credentials = {
      accessToken: "tok",
      providerSpecificData: { profileArn: EU_ARN },
    };
    expect(buildKiroChatUrl(credentials)).toBe(
      "https://codewhisperer.eu-central-1.amazonaws.com/generateAssistantResponse"
    );
    expect(buildKiroListModelsUrl(credentials, EU_ARN)).toContain(
      "https://q.eu-central-1.amazonaws.com/ListAvailableModels"
    );
    expect(buildKiroSocialAuthRefreshUrl("eu-central-1")).toBe(
      "https://prod.eu-central-1.auth.desktop.kiro.dev/refreshToken"
    );
  });

  it("builds IDE-like fingerprint User-Agent", () => {
    const headers = buildKiroFingerprintHeaders({ refreshToken: "seed-token" });
    expect(headers["User-Agent"]).toMatch(/KiroIDE-/);
    expect(headers["User-Agent"]).toMatch(/api\/codewhispererruntime/);
    expect(headers["x-amz-user-agent"]).toMatch(/KiroIDE-/);
  });
});

describe("KiroExecutor — regional endpoint and fingerprint headers", () => {
  it("buildUrl uses region from profileArn", () => {
    const executor = new KiroExecutor();
    const url = executor.buildUrl("auto", true, 0, {
      accessToken: "tok",
      providerSpecificData: { profileArn: EU_ARN },
    });
    expect(url).toBe("https://codewhisperer.eu-central-1.amazonaws.com/generateAssistantResponse");
  });

  it("buildHeaders uses fingerprint instead of static legacy UA", () => {
    const executor = new KiroExecutor();
    const headers = executor.buildHeaders({ accessToken: "tok", refreshToken: "seed" }, true);
    expect(headers["User-Agent"]).toMatch(/KiroIDE-/);
    expect(headers["User-Agent"]).not.toBe("AWS-SDK-JS/3.0.0 kiro-ide/1.0.0");
    expect(headers.Accept).toBe("application/vnd.amazon.eventstream");
    expect(headers.Authorization).toBe("Bearer tok");
  });
});

describe("refreshTokenByProvider — Kiro proxyOptions", () => {
  it("forwards proxyOptions to refreshKiroToken", async () => {
    const proxyOptions = { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy:8080" };
    const fetchSpy = vi.spyOn(
      await import("../../open-sse/utils/proxyFetch.js"),
      "proxyAwareFetch"
    ).mockResolvedValue({
      ok: true,
      json: async () => ({
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresIn: 3600,
      }),
    });

    const { refreshTokenByProvider } = await import("../../open-sse/services/tokenRefresh.js");
    const result = await refreshTokenByProvider(
      "kiro",
      {
        refreshToken: "social-refresh",
        providerSpecificData: { authMethod: "google" },
      },
      null,
      proxyOptions
    );

    expect(result?.accessToken).toBe("new-access");
    expect(fetchSpy).toHaveBeenCalled();
    const passedProxy = fetchSpy.mock.calls[0][2];
    expect(passedProxy).toBe(proxyOptions);

    fetchSpy.mockRestore();
  });
});
