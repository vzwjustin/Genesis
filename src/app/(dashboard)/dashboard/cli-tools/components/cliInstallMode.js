/** CLI is probed on the 9Router host — remote dashboards use manual copy instead. */

export const REMOTE_CLI_SETUP_HINT =
  "This 9Router server does not have the CLI installed. Pick endpoint, API key, and models below, then use Manual Config to copy settings to your machine.";

export function canAutoApplyOnServer(status) {
  return status?.installed === true;
}
