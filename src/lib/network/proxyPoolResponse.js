export function sanitizeProxyPoolForResponse(pool) {
  if (!pool) return pool;
  const { relayAuthSecret, ...safe } = pool;
  return {
    ...safe,
    hasRelayAuthSecret: Boolean(relayAuthSecret),
  };
}

export function sanitizeProxyPoolsForResponse(pools = []) {
  return pools.map(sanitizeProxyPoolForResponse);
}
