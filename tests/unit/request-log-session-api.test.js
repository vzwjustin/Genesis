import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getRequestLogSession: vi.fn(),
  readRequestLogSessionFile: vi.fn(),
  json: vi.fn((body, init) => ({ status: init?.status || 200, body })),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: mocks.json },
}));

vi.mock("open-sse/utils/requestLogger.js", () => ({
  getRequestLogSession: mocks.getRequestLogSession,
  readRequestLogSessionFile: mocks.readRequestLogSessionFile,
}));

const { GET } = await import("../../src/app/api/request-logs/sessions/[name]/route.js");

describe("request log session API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns session metadata without file param", async () => {
    mocks.getRequestLogSession.mockResolvedValue({
      enabled: true,
      name: "openai_claude_test",
      files: [{ name: "1_req_client.json", size: 100 }],
    });

    const req = new Request("http://localhost/api/request-logs/sessions/openai_claude_test");
    const res = await GET(req, { params: Promise.resolve({ name: "openai_claude_test" }) });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("openai_claude_test");
    expect(mocks.getRequestLogSession).toHaveBeenCalledWith("openai_claude_test");
  });

  it("returns file content when file query is set", async () => {
    mocks.readRequestLogSessionFile.mockResolvedValue({
      enabled: true,
      name: "sess",
      file: "8_error.json",
      contentType: "json",
      content: "{}",
    });

    const req = new Request("http://localhost/api/request-logs/sessions/sess?file=8_error.json");
    const res = await GET(req, { params: Promise.resolve({ name: "sess" }) });

    expect(res.status).toBe(200);
    expect(res.body.file).toBe("8_error.json");
    expect(mocks.readRequestLogSessionFile).toHaveBeenCalledWith("sess", "8_error.json");
  });

  it("returns 404 when session is missing", async () => {
    mocks.getRequestLogSession.mockResolvedValue({ error: "Session not found" });

    const req = new Request("http://localhost/api/request-logs/sessions/missing");
    const res = await GET(req, { params: Promise.resolve({ name: "missing" }) });

    expect(res.status).toBe(404);
  });
});
