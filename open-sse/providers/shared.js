// Anthropic API version header value, shared across executors that talk to
// Anthropic-compatible backends. Kept here (no imports) so executors can pull
// it without dragging in provider-config dependencies.
export const ANTHROPIC_API_VERSION = "2023-06-01";
