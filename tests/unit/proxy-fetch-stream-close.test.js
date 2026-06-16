import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => {
  class Emitter {
    constructor() { this.listeners = {}; }
    on(ev, cb) { (this.listeners[ev] ||= []).push(cb); return this; }
    off(ev, cb) { this.listeners[ev] = (this.listeners[ev] || []).filter((fn) => fn !== cb); return this; }
    emit(ev, ...args) { for (const fn of [...(this.listeners[ev] || [])]) fn(...args); }
    listenerCount(ev) { return (this.listeners[ev] || []).length; }
  }
  const noop = () => {};
  return { response: null, request: null, Emitter, noop };
});

vi.mock("dns", () => {
  const setServers = () => {};
  const resolve4 = (_host, cb) => cb(null, ["93.184.216.34"]);
  const resolve6 = (_host, cb) => cb(null, []);
  const lookup = (_host, _opts, cb) => cb(null, "93.184.216.34", 4);
  class Resolver {
    setServers() {}
    resolve4(host, cb) { resolve4(host, cb); }
  }
  return { default: { setServers, resolve4, resolve6, lookup, Resolver }, setServers, resolve4, resolve6, lookup, Resolver };
});

vi.mock("net", () => {
  class Socket extends mocks.Emitter {
    setTimeout() { return this; }
    connect(_port, _host, cb) { setImmediate(cb); return this; }
    destroy() {}
  }
  return { default: { Socket }, Socket };
});

vi.mock("http", () => {
  const request = (_opts, cb) => {
    mocks.response = new mocks.Emitter();
    mocks.response.headers = { "content-type": "text/plain" };
    mocks.response.statusCode = 200;
    mocks.response.statusMessage = "OK";
    mocks.response.destroy = mocks.noop;
    mocks.request = new mocks.Emitter();
    mocks.request.write = mocks.noop;
    mocks.request.end = mocks.noop;
    mocks.request.destroy = mocks.noop;
    setImmediate(() => cb(mocks.response));
    return mocks.request;
  };
  return { default: { request }, request };
});

vi.mock("../../src/lib/db/repos/settingsRepo.js", () => ({
  getSettings: async () => ({ dnsToolEnabled: { "8.8.8.8": true } }),
}));

describe("proxyAwareFetch bypass streaming body", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.response = null;
    mocks.request = null;
    mocks.socket = null;
  });

  it("does not close a cancelled stream controller when upstream ends late", async () => {
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    const response = await proxyAwareFetch("http://api.github.com/test", { method: "GET" });
    const reader = response.body.getReader();

    const read = reader.read();

    await vi.waitFor(() => {
      expect(mocks.response.listenerCount("end")).toBe(1);
    });

    await reader.cancel("downstream closed");
    await expect(read).resolves.toEqual({ done: true, value: undefined });

    expect(() => mocks.response.emit("end")).not.toThrow();
  });
});
