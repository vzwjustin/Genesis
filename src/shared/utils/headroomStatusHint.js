/** User-facing Headroom setup / readiness hints for dashboard toggles. */
export function formatHeadroomSetupHint(status) {
  if (!status) return "Checking Headroom status…";

  if (status.cloud) {
    return status.reachable
      ? "Headroom Cloud (HEADROOM_API_KEY) — ready"
      : "HEADROOM_API_KEY set but cloud API unreachable";
  }

  if (!status.installed) {
    return "headroom-ai npm client missing from this install — compression cannot run (proxy alone is not enough)";
  }

  if (!status.reachable) {
    return 'Local proxy not reachable — install: pipx install "headroom-ai[proxy]" (genesis can auto-start it)';
  }

  return `Proxy ready at ${status.proxyUrl} — compresses post-cache chat tails (skips tool-heavy agent loops)`;
}

/** Headroom toggle should only enable when the JS client can call compress(). */
export function headroomCanEnable(status) {
  if (!status) return false;
  if (status.cloud) return !!status.reachable;
  return !!status.installed && !!status.reachable;
}
