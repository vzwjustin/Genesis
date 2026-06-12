
import { NextResponse } from "next/server";
import { GET as claudeGet } from "../claude-settings/route";
import { GET as codexGet } from "../codex-settings/route";
import { GET as opencodeGet } from "../opencode-settings/route";
import { GET as droidGet } from "../droid-settings/route";
import { GET as openclawGet } from "../openclaw-settings/route";
import { GET as hermesGet } from "../hermes-settings/route";
import { GET as coworkGet } from "../cowork-settings/route";
import { GET as copilotGet } from "../copilot-settings/route";
import { GET as clineGet } from "../cline-settings/route";
import { GET as kiloGet } from "../kilo-settings/route";
import { GET as deepseekTuiGet } from "../deepseek-tui-settings/route";
import { GET as jcodeGet } from "../jcode-settings/route";

const STATUS_GETTERS = {
  claude: claudeGet,
  codex: codexGet,
  opencode: opencodeGet,
  droid: droidGet,
  openclaw: openclawGet,
  hermes: hermesGet,
  cowork: coworkGet,
  copilot: copilotGet,
  cline: clineGet,
  kilo: kiloGet,
  "deepseek-tui": deepseekTuiGet,
  jcode: jcodeGet,
};

// Batch endpoint: gather all CLI tool statuses in one round-trip
export async function GET() {
  const entries = await Promise.all(
    Object.entries(STATUS_GETTERS).map(async ([toolId, getter]) => {
      try {
        const res = await getter();
        const data = await res.json();
        if (!res.ok) {
          return [toolId, { installed: false, error: data?.error || `HTTP ${res.status}` }];
        }
        return [toolId, data];
      } catch (error) {
        return [toolId, { installed: false, error: error?.message || "status_check_failed" }];
      }
    })
  );
  return NextResponse.json(Object.fromEntries(entries));
}
