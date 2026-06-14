import os from "node:os";

/**
 * Home directory for CLI tool binaries and dotfile configs.
 * Defaults to the process user (genesis service account). Override with CLI_HOME
 * when CLIs were installed/configured under a different user (e.g. /root).
 */
export function getCliHomeDir() {
  const configured = process.env.CLI_HOME?.trim() || process.env.NINE_ROUTER_CLI_HOME?.trim();
  if (!configured) return os.homedir();
  if (configured === "~") return os.homedir();
  if (configured.startsWith("~/")) {
    return `${os.homedir()}${configured.slice(1)}`;
  }
  return configured;
}
