import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import tseslint from "typescript-eslint";

const eslintConfig = defineConfig([
  ...nextVitals,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".next-cli-build/**",
    "cli/app/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    rules: {
      "react-hooks/set-state-in-effect": "warn",
    },
  },
  // Type-aware safety rule for backend JS: flags unhandled promise rejections
  // (fire-and-forget async with no .catch — the bug-class behind several past
  // crashes). Scoped to non-React modules; warn-only so CI never breaks.
  // projectService auto-discovers jsconfig.json for type info.
  // (require-await deliberately omitted — most async fns here are intentional
  // async-by-contract APIs, so it's near-all false positives.)
  {
    files: ["src/lib/**/*.js", "cli/**/*.js", "open-sse/**/*.js"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/no-floating-promises": "warn",
      // Flags async fns passed where a void/sync callback is expected (event
      // handlers, array methods) — their rejections are silently swallowed.
      "@typescript-eslint/no-misused-promises": [
        "warn",
        { checksVoidReturn: { arguments: false, attributes: false } },
      ],
    },
  },
]);

export default eslintConfig;
