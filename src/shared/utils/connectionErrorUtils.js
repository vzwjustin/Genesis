import { getErrorCode } from "./index.js";

export function getConnectionErrorTag(connection) {
  if (!connection) return null;

  const explicitType = connection.lastErrorType;
  if (explicitType === "runtime_error") return "RUNTIME";
  if (
    explicitType === "upstream_auth_error" ||
    explicitType === "auth_missing" ||
    explicitType === "token_refresh_failed" ||
    explicitType === "token_expired"
  )
    return "AUTH";
  if (explicitType === "upstream_rate_limited") return "429";
  if (explicitType === "upstream_unavailable") return "5XX";
  if (explicitType === "network_error") return "NET";

  const numericCode = Number(connection.errorCode);
  if (Number.isFinite(numericCode) && numericCode >= 400)
    return String(numericCode);

  const fromMessage = getErrorCode(connection.lastError);
  if (fromMessage === "401" || fromMessage === "403") return "AUTH";
  if (fromMessage && fromMessage !== "ERR") return fromMessage;

  const msg = (connection.lastError || "").toLowerCase();
  if (
    msg.includes("runtime") ||
    msg.includes("not runnable") ||
    msg.includes("not installed")
  )
    return "RUNTIME";
  if (
    msg.includes("invalid api key") ||
    msg.includes("token invalid") ||
    msg.includes("revoked") ||
    msg.includes("unauthorized")
  )
    return "AUTH";

  return "ERR";
}

const HINTS = {
  AUTH: "Reconnect or refresh OAuth credentials.",
  "429": "Rate limited — wait for cooldown or add another connection.",
  "5XX": "Upstream unavailable — retry shortly or switch combo.",
  NET: "Network/proxy issue — check outbound proxy and DNS.",
  RUNTIME: "Provider runtime missing — verify CLI/install on host.",
};

export function getConnectionErrorHint(tag) {
  return HINTS[tag] || "Open connection details or test again.";
}

export function getConnectionErrorLabel(tag) {
  if (!tag) return null;
  if (tag === "AUTH") return "Auth";
  if (tag === "NET") return "Network";
  if (tag === "RUNTIME") return "Runtime";
  return tag;
}
