import { sanitizeValue } from "@/shared/utils/redaction";

export function sanitizeProviderConnection(connection, overrides = {}) {
  if (!connection) return connection;
  return sanitizeValue({ ...connection, ...overrides });
}
