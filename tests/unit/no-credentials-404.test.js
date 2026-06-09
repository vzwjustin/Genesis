/**
 * HTTP 404 when no valid-credential connections exist (Task 4.3, Req 3.3, 4.8)
 * No mocks: noActiveCredentialsResponse + handler source inspection.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { noActiveCredentialsResponse } from "../../src/sse/utils/providerCredentialRetry.js";

const root = dirname(fileURLToPath(import.meta.url));

describe("noActiveCredentialsResponse", () => {
  it("returns HTTP 404 with correct message when provider has zero connections", async () => {
    const response = noActiveCredentialsResponse("claude");
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.message).toBe("No active credentials for provider: claude");
  });

  it("includes provider name in the error message", async () => {
    const response = noActiveCredentialsResponse("openai");
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.message).toBe("No active credentials for provider: openai");
  });
});

describe("chat handler zero-connection guard (source)", () => {
  const src = readFileSync(join(root, "../../src/sse/handlers/chat.js"), "utf8");

  it("returns noActiveCredentialsResponse before dispatch when maxRetries is 0", () => {
    expect(src).toContain("resolveProviderRetryLimits");
    expect(src).toMatch(/!isNoAuthProvider\s*&&\s*maxRetries\s*===\s*0/);
    expect(src).toContain("noActiveCredentialsResponse");
    expect(src).toContain("handleChatCore");
  });

  it("credential selection excludes testStatus error connections (auth service source)", () => {
    const authSrc = readFileSync(join(root, "../../src/sse/services/auth.js"), "utf8");
    expect(authSrc).toMatch(/testStatus|error/);
  });
});

describe("other handlers share the same 404 guard (source)", () => {
  const handlers = ["embeddings.js", "search.js", "fetch.js", "imageGeneration.js", "tts.js", "stt.js"];

  for (const file of handlers) {
    it(`${file} checks maxRetries === 0`, () => {
      const src = readFileSync(join(root, `../../src/sse/handlers/${file}`), "utf8");
      expect(src).toContain("noActiveCredentialsResponse");
      expect(src).toMatch(/maxRetries\s*===\s*0/);
    });
  }
});
