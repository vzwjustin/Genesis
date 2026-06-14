"use client";

import { Button } from "@/shared/components";
import InlineAlert from "@/shared/components/InlineAlert";
import { REMOTE_CLI_SETUP_HINT } from "./cliInstallMode";

/**
 * Info banner when the CLI is not installed on the Genesis host (typical remote server).
 */
export default function CliNotDetectedPanel({
  cliName,
  description = REMOTE_CLI_SETUP_HINT,
  onToggleInstallGuide,
  showInstallGuide,
  installGuide,
}) {
  return (
    <div className="flex flex-col gap-4">
      <InlineAlert
        variant="info"
        title={`${cliName} not on this server`}
        message={description}
      />
      {onToggleInstallGuide ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={onToggleInstallGuide}>
            <span className="material-symbols-outlined text-[18px] mr-1">download</span>
            {showInstallGuide ? "Hide install guide" : "Install on your machine"}
          </Button>
        </div>
      ) : null}
      {showInstallGuide && installGuide ? <div className="glass-stat border-0 p-4 text-sm text-text-muted">{installGuide}</div> : null}
    </div>
  );
}
