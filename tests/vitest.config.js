import { defineConfig } from "vitest/config";
import { resolve, join } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// Isolate the runtime data dir so tests never read or mutate the real ~/.genesis
// DB. Several tests run `DELETE FROM providerConnections` and seed fixtures via
// getAdapter(); without this they wipe the user's live provider connections.
// getDataDir() honors DATA_DIR over the ~/.genesis default.
const TEST_DATA_DIR = join(tmpdir(), "genesis-test-data");
process.env.DATA_DIR = TEST_DATA_DIR;

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["**/*.test.js"],
    // Suppress noisy console output from handlers under test
    silent: false,
    env: {
      DATA_DIR: TEST_DATA_DIR,
    },
  },
  resolve: {
    alias: [
      // Resolve open-sse/* imports to the actual local package
      { find: /^open-sse(.*)$/, replacement: resolve(__dirname, "../open-sse$1") },
      // Resolve @/* imports to src directory
      { find: /^@\/(.*)$/, replacement: resolve(__dirname, "../src/$1") },
    ],
  },
});
