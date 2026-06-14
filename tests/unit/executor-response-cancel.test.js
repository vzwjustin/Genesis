import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cancelResponseBody } from "../../open-sse/utils/proxyFetch.js";
import { KiroExecutor } from "../../open-sse/executors/kiro.js";

const root = join(import.meta.dirname, "..", "..");
const mockProxyAwareFetch = vi.fn();

vi.mock("../../open-sse/utils/proxyFetch.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    proxyAwareFetch: (...args) => mockProxyAwareFetch(...args),
  };
});

const credentials = {
  accessToken: "tok",
  providerSpecificData: {
    profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/ABC",
  },
};

describe("cancelResponseBody", () => {
  it("does not throw when body or cancel is missing", async () => {
    await expect(cancelResponseBody({})).resolves.toBeUndefined();
    await expect(cancelResponseBody({ body: null })).resolves.toBeUndefined();
    await expect(cancelResponseBody({ body: {} })).resolves.toBeUndefined();
  });

  it("invokes cancel when present", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    await cancelResponseBody({ body: { cancel } });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("swallows cancel rejections", async () => {
    const cancel = vi.fn().mockRejectedValue(new Error("already consumed"));
    await expect(cancelResponseBody({ body: { cancel } })).resolves.toBeUndefined();
  });
});

describe("KiroExecutor network retry", () => {
  beforeEach(() => {
    mockProxyAwareFetch.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries fetch failures via 502 retry config", async () => {
    mockProxyAwareFetch
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const executor = new KiroExecutor();
    vi.spyOn(executor, "transformEventStreamToSSE").mockReturnValue(new Response("sse"));

    const execPromise = executor.execute({
      model: "auto",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials,
      log: { debug: vi.fn() },
    });

    await vi.advanceTimersByTimeAsync(3000);
    await execPromise;

    expect(mockProxyAwareFetch).toHaveBeenCalledTimes(2);
  });

  it("uses guarded body cancel on status retries", () => {
    const src = readFileSync(join(root, "open-sse/executors/kiro.js"), "utf8");
    expect(src).toContain("cancelResponseBody(response)");
    expect(src).not.toContain("body?.cancel?.().catch");
  });
});
