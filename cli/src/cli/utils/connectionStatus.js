/**
 * Connection test-status helpers (aligned with dashboard ConnectionRow).
 */

function getModelLockUntil(connection) {
  if (!connection) return null;
  const locks = Object.entries(connection)
    .filter(([key]) => key.startsWith("modelLock_"))
    .map(([, value]) => value)
    .filter(Boolean)
    .sort();
  return locks[0] || null;
}

function isModelCooldownActive(connection) {
  const until = getModelLockUntil(connection);
  if (!until) return false;
  return new Date(until).getTime() > Date.now();
}

function getEffectiveTestStatus(connection) {
  if (!connection) return "unknown";
  if (connection.isActive === false) return "disabled";

  const status = connection.testStatus || "unknown";
  if (status === "unavailable" && !isModelCooldownActive(connection)) {
    return "active";
  }
  return status;
}

function formatStatusIcon(connection) {
  const status = getEffectiveTestStatus(connection);
  if (status === "active" || status === "success") return "✓";
  if (status === "error" || status === "expired" || status === "unavailable") return "✗";
  if (status === "disabled") return "○";
  if (status === "unknown") return "○";
  return "?";
}

function formatStatusLabel(connection) {
  const status = getEffectiveTestStatus(connection);
  const labels = {
    active: "✓ Active",
    success: "✓ Active",
    error: "✗ Error",
    expired: "✗ Expired",
    unavailable: "✗ Unavailable",
    unknown: "○ Untested",
    disabled: "○ Disabled",
  };
  return labels[status] || "? Unknown";
}

function needsConnectionTest(connection) {
  return getEffectiveTestStatus(connection) === "unknown";
}

module.exports = {
  getEffectiveTestStatus,
  formatStatusIcon,
  formatStatusLabel,
  needsConnectionTest,
};
