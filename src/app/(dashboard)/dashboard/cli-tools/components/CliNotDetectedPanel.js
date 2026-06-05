"use client";

import { Button } from "@/shared/components";
import InlineAlert from "@/shared/components/InlineAlert";

/**
 * Shared panel when a CLI tool is not installed on the host machine.
 */
export default function CliNotDetectedPanel({
  cliName,
  description = "Remote server? Use manual setup instead.",
  onManualConfig,
  onToggleInstallGuide,
  showInstallGuide,
  installGuide,
}) {
  return (
    <div className="flex flex-col gap-4">
      <InlineAlert variant="caution" title={`${cliName} not detected locally`} message={description} />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={onManualConfig}
          className="!bg-yellow-500/20 !border-yellow-500/40 !text-yellow-700 dark:!text-yellow-300 hover:!bg-yellow-500/30"
        >
          <span className="material-symbols-outlined text-[18px] mr-1">content_copy</span>
          Manual Config
        </Button>
        {onToggleInstallGuide ? (
          <Button variant="outline" size="sm" onClick={onToggleInstallGuide}>
            <span className="material-symbols-outlined text-[18px] mr-1">download</span>
            {showInstallGuide ? "Hide install guide" : "How to Install"}
          </Button>
        ) : null}
      </div>
      {showInstallGuide && installGuide ? <div className="text-sm text-text-muted">{installGuide}</div> : null}
    </div>
  );
}
