import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "genesis-model-kind-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("custom model kind catalog", () => {
  it("lists custom embedding models on the embedding endpoint by declared type", async () => {
    const db = await import("../../src/lib/db/index.js");
    await db.importDb({
      providerConnections: [
        {
          id: "conn-openai",
          provider: "openai",
          authType: "apikey",
          name: "OpenAI",
          apiKey: "sk-test",
          isActive: true,
        },
      ],
      customModels: [
        {
          providerAlias: "openai",
          id: "private-vector-v1",
          type: "embedding",
          name: "Private Vector V1",
        },
      ],
    });

    const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");
    const embeddingIds = (await buildModelsList(["embedding"])).map((m) => m.id);
    const llmIds = (await buildModelsList(["llm"])).map((m) => m.id);

    expect(embeddingIds).toContain("openai/private-vector-v1");
    expect(llmIds).not.toContain("openai/private-vector-v1");
  });
});
