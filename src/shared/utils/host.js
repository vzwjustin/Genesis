export function normalizeHostHeaderHostname(value) {
  if (!value) return "";
  let host = String(value).trim().toLowerCase();
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? "" : host.slice(1, end);
  }
  if ((host.match(/:/g) || []).length === 1) return host.split(":")[0];
  return host;
}
