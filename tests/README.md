# Genesis Tests

Unit and integration tests for the genesis proxy, API routes, translators, and handlers.

## Setup

Install dependencies from the **repository root** first (tests import `src/` and `open-sse/` modules that depend on Next.js, `uuid`, `better-sqlite3`, etc.):

```bash
cd /workspace   # repo root
npm install
cd tests
npm install
```

## Running Tests

From the repo root (recommended):

```bash
npm test
```

From the `tests/` directory (requires root `npm install`):

```bash
cd tests
npm test
```

## Test layout

| Path | Focus |
|------|--------|
| `tests/unit/*.test.js` | Handlers, translators, auth, combo, streaming, passthrough |
| `tests/vitest.config.js` | Aliases for `@/` and `open-sse/`; isolated `DATA_DIR` |

## Live E2E (opt-in)

See `tests/README.md` in-repo notes and `RUN_E2E=1` with a server on port 20128.
