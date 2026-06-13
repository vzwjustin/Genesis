export function isJsonObjectBody(body) {
  return body !== null && typeof body === "object" && !Array.isArray(body);
}

export function isInvalidJsonObjectBody(body) {
  return !isJsonObjectBody(body);
}
