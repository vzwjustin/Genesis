import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { resetComboRotation } from "open-sse/services/combo.js";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { getRemoteExposureBlockReason, isRemoteExposureRequest } from "@/lib/security/exposureGate";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const SETTINGS_RESPONSE_HEADERS = {
  "Cache-Control": "no-store"
};

const ALLOWED_PATCH_KEYS = new Set([
  "authMode",
  "cavemanEnabled",
  "cavemanLevel",
  "ccFilterNaming",
  "cloudEnabled",
  "cloudUrl",
  "comboStrategies",
  "comboStrategy",
  "comboStickyRoundRobinLimit",
  "currentPassword",
  "enableObservability",
  "fallbackStrategy",
  "headroomEnabled",
  "mitmAutoSetupOnImport",
  "newPassword",
  "observabilityBatchSize",
  "observabilityFlushIntervalMs",
  "observabilityMaxJsonSize",
  "observabilityMaxRecords",
  "oidcClientId",
  "oidcClientSecret",
  "oidcIssuerUrl",
  "oidcLoginLabel",
  "oidcScopes",
  "outboundNoProxy",
  "outboundProxyEnabled",
  "outboundProxyUrl",
  "passthroughCompression",
  "providerStrategies",
  "providerThinking",
  "requireApiKey",
  "requireLogin",
  "rtkEnabled",
  "stickyRoundRobinLimit",
  "tailscaleEnabled",
  "tailscaleUrl",
  "tunnelDashboardAccess",
  "tunnelEnabled",
  "tunnelProvider",
  "tunnelUrl",
]);

function validatePatchKeys(body) {
  for (const key of Object.keys(body || {})) {
    if (!ALLOWED_PATCH_KEYS.has(key)) return key;
  }
  return null;
}

export async function GET() {
  try {
    const settings = await getSettings();
    const { password, oidcClientSecret, ...safeSettings } = settings;
    safeSettings.oidcConfigured = !!(safeSettings.oidcIssuerUrl && safeSettings.oidcClientId && oidcClientSecret);
    
    const enableRequestLogs = process.env.ENABLE_REQUEST_LOGS === "true";
    const enableTranslator = process.env.ENABLE_TRANSLATOR === "true";
    
    return NextResponse.json({ 
      ...safeSettings, 
      enableRequestLogs,
      enableTranslator,
      hasPassword: !!password
    }, { headers: SETTINGS_RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error getting settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const settings0 = await getSettings();
    if (settings0.requireLogin !== false) {
      const cookieStore = await cookies();
      const session = await getDashboardAuthSession(cookieStore.get("auth_token")?.value);
      if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    const body = await request.json();

    if (isRemoteExposureRequest(body)) {
      const current = await getSettings();
      const blockReason = getRemoteExposureBlockReason({ ...current, ...body });
      if (blockReason) {
        return NextResponse.json({ error: blockReason }, { status: 400 });
      }
    }

    const unsupportedKey = validatePatchKeys(body);
    if (unsupportedKey) {
      return NextResponse.json({ error: `Unsupported setting: ${unsupportedKey}` }, { status: 400 });
    }

    // If updating password, hash it
    if (body.newPassword) {
      const settings = await getSettings();
      const currentHash = settings.password;

      // Verify current password if it exists
      if (currentHash) {
        if (!body.currentPassword) {
          return NextResponse.json({ error: "Current password required" }, { status: 400 });
        }
        const isValid = await bcrypt.compare(body.currentPassword, currentHash);
        if (!isValid) {
          return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      } else {
        // First time setting password — no current password required
        if (body.currentPassword) {
          return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      }

      const salt = await bcrypt.genSalt(10);
      body.password = await bcrypt.hash(body.newPassword, salt);
      delete body.newPassword;
      delete body.currentPassword;
    }

    if (Object.prototype.hasOwnProperty.call(body, "oidcClientSecret")) {
      if (!body.oidcClientSecret || !String(body.oidcClientSecret).trim()) {
        delete body.oidcClientSecret;
      }
    }

    const settings = await updateSettings(body);

    // Apply outbound proxy settings immediately (no restart required)
    if (
      Object.prototype.hasOwnProperty.call(body, "outboundProxyEnabled") ||
      Object.prototype.hasOwnProperty.call(body, "outboundProxyUrl") ||
      Object.prototype.hasOwnProperty.call(body, "outboundNoProxy")
    ) {
      applyOutboundProxyEnv(settings);
    }

    // Invalidate combo rotation state when strategy settings change
    if (
      Object.prototype.hasOwnProperty.call(body, "comboStrategy") ||
      Object.prototype.hasOwnProperty.call(body, "comboStickyRoundRobinLimit") ||
      Object.prototype.hasOwnProperty.call(body, "comboStrategies")
    ) {
      resetComboRotation();
    }

    const { password, oidcClientSecret, ...safeSettings } = settings;
    safeSettings.oidcConfigured = !!(safeSettings.oidcIssuerUrl && safeSettings.oidcClientId && oidcClientSecret);
    return NextResponse.json(safeSettings, { headers: SETTINGS_RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error updating settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
