# HARD INSTRUCTIONS — ALWAYS, NON-NEGOTIABLE
On EVERY task, before answering or acting:
1. **5 Whys** — ask "why" 5x to reach root cause/intent, not surface symptom.
2. **What-ifs** — surface edge cases, failure modes, alternative interpretations.
3. **Self-reflect** — audit own reasoning for gaps, hidden assumptions, errors before committing. Revise if weak.
No skip. Applies even to "simple" tasks.

---

# Behavioral Guidelines — reduce common LLM coding mistakes

Bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think before coding
Don't assume, don't hide confusion, surface tradeoffs.
- State assumptions explicitly. Uncertain → ask.
- Multiple interpretations → present them, don't pick silently.
- Simpler approach exists → say so. Push back when warranted.
- Unclear → stop, name what's confusing, ask. (Pairs with the 5-Whys above.)

## 2. Simplicity first
Minimum code that solves the problem. Nothing speculative.
- No features beyond what was asked.
- No abstractions for single-use code.
- No unrequested "flexibility"/"configurability".
- No error handling for impossible scenarios.
- 200 lines that could be 50 → rewrite.
- Test: "Would a senior engineer call this overcomplicated?" Yes → simplify.

## 3. Surgical changes
Touch only what you must. Clean up only your own mess.
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor what isn't broken.
- Match existing style even if you'd do it differently.
- Notice unrelated dead code → mention it, don't delete it.
- Remove imports/vars/functions YOUR changes orphaned; leave pre-existing dead code unless asked.
- Test: every changed line traces directly to the request.

## 4. Goal-driven execution
Define success criteria, loop until verified.
- "Add validation" → write tests for invalid inputs, make them pass.
- "Fix the bug" → write a test reproducing it, make it pass.
- "Refactor X" → tests pass before and after.
- Multi-step → state a brief plan, each step with a verify check.

Working if: fewer unnecessary diff lines, fewer overcomplication rewrites, clarifying questions come *before* implementation.

> See also AGENTS.md: "Fail closed for correctness/security" and the TDD/testing requirements — these guidelines apply on top of those repo rules.

---

## Quick Start

```bash
npm install                      # root deps (tests import src/ + open-sse/)
npm test                         # vitest run --config tests/vitest.config.js
npm run lint:backend             # eslint src/lib, cli, open-sse
npm run build                    # next build (web dashboard)

# CLI/proxy (the running server) — ALWAYS clear webpack cache first,
# else stale compiled output runs instead of your edits (esp. open-sse/):
rm -rf .next-cli-build && cd cli && npm run build
```

---

See [AGENTS.md](./AGENTS.md) for full repo agent instructions.
