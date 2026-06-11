import { describe, it, expect } from "vitest";
import { parseUpstreamError } from "../../open-sse/utils/error.js";

describe("parseUpstreamError — executor parseError shapes", () => {
  it("accepts string parseError return values", async () => {
    const executor = {
      parseError: () => "provider-specific message",
    };
    const response = new Response("ignored body", { status: 502 });
    const { statusCode, message } = await parseUpstreamError(response, executor);
    expect(statusCode).toBe(502);
    expect(message).toBe("provider-specific message");
  });

  it("accepts object parseError return values with code", async () => {
    const executor = {
      parseError: () => ({
        status: 401,
        message: "reconnect required",
        code: "reauth_required",
      }),
    };
    const response = new Response("{}", { status: 401 });
    const { statusCode, message } = await parseUpstreamError(response, executor);
    expect(statusCode).toBe(401);
    expect(message).toBe("reconnect required");
  });
});
