// Strip request params a given provider/model rejects upstream (e.g. HTTP 400).
// Config-driven: add a rule instead of scattering `delete body.x` across executors.

const STRIP_RULES = [
  { match: /claude-opus-4/i, drop: ["temperature"] },
  { provider: "github", match: /gpt-5\.4/i, drop: ["temperature"] },
  {
    provider: "github",
    match: (m) => /claude/i.test(m) && !/claude.*(opus|sonnet).*4\.6/i.test(m),
    drop: ["thinking", "reasoning_effort"],
  },
];

function matches(rule, model) {
  return typeof rule.match === "function" ? rule.match(model) : rule.match.test(model);
}

export function stripUnsupportedParams(provider, model, body) {
  if (!model || !body || typeof body !== "object") return body;
  for (const rule of STRIP_RULES) {
    if (rule.provider && rule.provider !== provider) continue;
    if (!matches(rule, model)) continue;
    for (const key of rule.drop) {
      if (body[key] !== undefined) delete body[key];
    }
  }
  return body;
}
