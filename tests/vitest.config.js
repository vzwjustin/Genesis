import { defineConfig } from "vitest/config";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["**/*.test.js"],
    // Suppress noisy console output from handlers under test
    silent: false,
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
