/**
 * Per-tool DNS hosts — written to hosts file as 127.0.0.1 when MITM DNS is enabled.
 * Kept in sync with MITM routing; shared by Node (dnsConfig) and dashboard UI.
 *
 * /etc/hosts cannot use wildcards (*.kiro.dev). Enumerate each chat API host explicitly.
 *
 * Sources: Kiro extension preset-configurations (krsConfigs, awsCommercialConfigs,
 * awsGovCloudConfigs, awsAdcRegionConfigs) + codewhisperer.{region}.amazonaws.com SDK default.
 *
 * MITM redirects only chat/streaming API hosts. Leave direct (do not add here):
 *   - management.{region}.kiro.dev (CPS / usage limits)
 *   - prod.{region}.auth.desktop.kiro.dev, auth.kiro.dev, app.kiro.dev (OAuth)
 *   - *.telemetry.desktop.kiro.dev, billing.kiro.dev (telemetry/billing)
 *   - prod.download.desktop.kiro.dev (powers/updates)
 *   - api.github.com, objects.githubusercontent.com (CLI updates)
 */

const KIRO_RUNTIME_HOSTS = [
  "runtime.us-east-1.kiro.dev",
  "runtime.eu-central-1.kiro.dev",
];

/** Legacy + GovCloud + ADC — from extension.js allPartitionConfigs */
const KIRO_AWS_Q_HOSTS = [
  "q.us-east-1.amazonaws.com",
  "q.eu-central-1.amazonaws.com",
  "q.us-gov-east-1.amazonaws.com",
  "q.us-gov-west-1.amazonaws.com",
  "q-fips.us-gov-east-1.amazonaws.com",
  "q-fips.us-gov-west-1.amazonaws.com",
  "q.us-iso-east-1.c2s.ic.gov",
  "q.us-isob-east-1.sc2s.sgov.gov",
  "q.us-isof-south-1.csp.hci.ic.gov",
  "q.us-isof-east-1.csp.hci.ic.gov",
];

/** SDK fallback host pattern codewhisperer.{region}.amazonaws.com */
const KIRO_CODEWHISPERER_HOSTS = [
  "codewhisperer.us-east-1.amazonaws.com",
  "codewhisperer.eu-central-1.amazonaws.com",
  "codewhisperer.us-gov-east-1.amazonaws.com",
  "codewhisperer.us-gov-west-1.amazonaws.com",
];

const KIRO_MITM_HOSTS = [
  ...KIRO_RUNTIME_HOSTS,
  ...KIRO_AWS_Q_HOSTS,
  ...KIRO_CODEWHISPERER_HOSTS,
];

/**
 * True when host carries Kiro CodeWhisperer streaming chat (GenerateAssistantResponse).
 * Used by MITM TLS + intercept routing in src/mitm/config.js.
 */
function isKiroMitmHost(host) {
  const h = (host || "").split(":")[0].toLowerCase();
  if (/^runtime\.[a-z0-9-]+\.kiro\.dev$/i.test(h)) return true;
  if (/^codewhisperer\./i.test(h) && h.endsWith(".amazonaws.com")) return true;
  if (/^q(-fips)?\./i.test(h)) {
    return /\.(amazonaws\.com|c2s\.ic\.gov|sc2s\.sgov\.gov|csp\.hci\.ic\.gov)$/i.test(h);
  }
  return false;
}

const TOOL_HOSTS = {
  antigravity: ["daily-cloudcode-pa.googleapis.com", "cloudcode-pa.googleapis.com"],
  copilot: ["api.individual.githubcopilot.com"],
  kiro: KIRO_MITM_HOSTS,
  // cursor: not implemented — do not add hosts until handler exists
};

module.exports = {
  TOOL_HOSTS,
  KIRO_MITM_HOSTS,
  KIRO_RUNTIME_HOSTS,
  KIRO_AWS_Q_HOSTS,
  KIRO_CODEWHISPERER_HOSTS,
  isKiroMitmHost,
};
