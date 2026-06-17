/**
 * Codex executor: verify remote image URLs are fetched and inlined as
 * base64 data URIs BEFORE the request body reaches the upstream API.
 *
 * Covers bug #575:
 *  - prefetchImages must await async image fetches
 *  - execute() must run prefetchImages before super.execute so the body
 *    sent to upstream contains base64 data, not remote URLs
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import * as proxyFetchModule from "../../open-sse/utils/proxyFetch.js";

const IMAGE_1MB_BYTES = 1024 * 1024;
const REMOTE_URL = "https://example.com/big.jpg";
const DATA_URI = "data:image/png;base64,iVBORw0KGgo=";

function makeImageBuffer(sizeBytes) {
  const buf = new Uint8Array(sizeBytes);
  for (let i = 0; i < sizeBytes; i++) buf[i] = i & 0xff;
  return buf.buffer;
}

function mockImageFetch(sizeBytes, mimeType = "image/jpeg") {
  return {
    ok: true,
    headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? mimeType : null) },
    arrayBuffer: async () => makeImageBuffer(sizeBytes),
  };
}

describe("CodexExecutor image handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches 1MB remote image and inlines it as base64 data URI", async () => {
    const fetchSpy = vi.spyOn(proxyFetchModule, "proxyAwareFetch")
      .mockImplementation(async () => mockImageFetch(IMAGE_1MB_BYTES));

    const executor = new CodexExecutor();
    const body = {
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "describe this" },
            { type: "image_url", image_url: { url: REMOTE_URL, detail: "high" } },
          ],
        },
      ],
    };

    await executor.prefetchImages(body);

    const imgBlock = body.input[0].content.find((c) => c.type === "input_image");
    expect(imgBlock, "input_image block must be present after prefetch").toBeDefined();
    expect(imgBlock.image_url.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(imgBlock.detail).toBe("high");

    const base64Payload = imgBlock.image_url.split(",")[1];
    const decodedLen = Buffer.from(base64Payload, "base64").length;
    expect(decodedLen).toBe(IMAGE_1MB_BYTES);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("passes through existing data URIs without calling fetch", async () => {
    const fetchSpy = vi.spyOn(proxyFetchModule, "proxyAwareFetch");

    const executor = new CodexExecutor();
    const body = {
      input: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: DATA_URI } }],
        },
      ],
    };

    await executor.prefetchImages(body);

    const imgBlock = body.input[0].content.find((c) => c.type === "input_image");
    expect(imgBlock.image_url).toBe(DATA_URI);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls back to original URL when remote fetch fails", async () => {
    vi.spyOn(proxyFetchModule, "proxyAwareFetch")
      .mockImplementation(async () => { throw new Error("network down"); });

    const executor = new CodexExecutor();
    const body = {
      input: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: REMOTE_URL } }],
        },
      ],
    };

    await executor.prefetchImages(body);

    const imgBlock = body.input[0].content.find((c) => c.type === "input_image");
    expect(imgBlock.image_url).toBe(REMOTE_URL);
  });

  it("does not buffer remote images larger than the configured cap", async () => {
    const arrayBuffer = vi.fn(async () => makeImageBuffer(1));
    vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockImplementation(async () => ({
      ok: true,
      headers: {
        get: (k) => {
          const key = String(k).toLowerCase();
          if (key === "content-type") return "image/jpeg";
          if (key === "content-length") return String(25 * 1024 * 1024);
          return null;
        },
      },
      arrayBuffer,
    }));

    const executor = new CodexExecutor();
    const body = {
      input: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: REMOTE_URL } }],
        },
      ],
    };

    await executor.prefetchImages(body);

    const imgBlock = body.input[0].content.find((c) => c.type === "input_image");
    expect(imgBlock.image_url).toBe(REMOTE_URL);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("execute() prefetches images before sending to upstream", async () => {
    let capturedBodyString = null;
    vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockImplementation(async (url, init) => {
      if (String(url).includes("example.com")) {
        return mockImageFetch(IMAGE_1MB_BYTES);
      }
      capturedBodyString = init.body;
      return { ok: true, status: 200, headers: new Map() };
    });

    const executor = new CodexExecutor();
    const body = {
      input: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: REMOTE_URL } }],
        },
      ],
    };

    await executor.execute({
      model: "gpt-5.3-codex",
      body,
      stream: true,
      credentials: { accessToken: "test" },
    });

    expect(capturedBodyString).toBeTypeOf("string");
    expect(capturedBodyString).not.toBe("{}");
    const parsed = JSON.parse(capturedBodyString);
    const imgBlock = parsed.input[0].content.find((c) => c.type === "input_image");
    expect(imgBlock.image_url.startsWith("data:image/jpeg;base64,")).toBe(true);
  });

  it("prefetches images in passthrough mode when remote image_url is present", async () => {
    const executor = new CodexExecutor();
    const prefetchSpy = vi.spyOn(executor, "prefetchImages").mockResolvedValue();
    vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map(),
    });

    await executor.execute({
      model: "gpt-5.3-codex",
      body: {
        input: [{
          role: "user",
          content: [{ type: "image_url", image_url: REMOTE_URL }],
        }],
      },
      stream: true,
      credentials: { accessToken: "test" },
      passthrough: true,
    });

    expect(prefetchSpy).toHaveBeenCalled();
  });

  it("skips prefetchImages in passthrough mode when no images", async () => {
    const executor = new CodexExecutor();
    const prefetchSpy = vi.spyOn(executor, "prefetchImages").mockResolvedValue();
    vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map(),
    });

    await executor.execute({
      model: "gpt-5.3-codex",
      body: { input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }] },
      stream: true,
      credentials: { accessToken: "test" },
      passthrough: true,
    });

    expect(prefetchSpy).not.toHaveBeenCalled();
  });

  it("routes compact requests to /compact without leaking state to later requests", async () => {
    const urls = [];
    const sentBodies = [];
    vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockImplementation(async (url, init) => {
      urls.push(String(url));
      sentBodies.push(JSON.parse(init.body));
      return { ok: true, status: 200, headers: new Map() };
    });

    const executor = new CodexExecutor();
    const credentials = { accessToken: "test" };

    await executor.execute({
      model: "gpt-5.3-codex",
      body: { _compact: true, input: [{ role: "user", content: [{ type: "input_text", text: "compact" }] }] },
      stream: true,
      credentials,
    });

    await executor.execute({
      model: "gpt-5.3-codex",
      body: { input: [{ role: "user", content: [{ type: "input_text", text: "normal" }] }] },
      stream: true,
      credentials,
    });

    expect(urls[0]).toMatch(/\/compact$/);
    expect(urls[1]).not.toMatch(/\/compact$/);
    expect(sentBodies[0]._compact).toBeUndefined();
    expect(sentBodies[1]._compact).toBeUndefined();
  });

  it("routes passthrough compact requests to /compact and strips only the local marker", async () => {
    let capturedUrl = null;
    let capturedBody = null;
    vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockImplementation(async (url, init) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(init.body);
      return { ok: true, status: 200, headers: new Map() };
    });

    const executor = new CodexExecutor();
    await executor.execute({
      model: "gpt-5.3-codex",
      body: {
        _compact: true,
        input: [{ role: "user", content: [{ type: "input_text", text: "compact" }] }],
        custom_provider_field: "preserve-me",
      },
      stream: true,
      credentials: { accessToken: "test" },
      passthrough: true,
    });

    expect(capturedUrl).toMatch(/\/compact$/);
    expect(capturedBody._compact).toBeUndefined();
    expect(capturedBody.custom_provider_field).toBe("preserve-me");
  });
});
