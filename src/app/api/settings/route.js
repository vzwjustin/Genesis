import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { resetComboRotation } from "open-sse/services/combo.js";
import bcrypt from "bcryptjs";
import { requireDashboardApiAuth } from "@/lib/auth/dashboardApiAuth";
import {
  getRemoteExposureBlockReason,
  isRemoteExposureActive,
  isRemoteExposureRequest,
} from "@/lib/security/exposureGate";

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
  "mitmRouterBaseUrl",
  "dnsToolEnabled",
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
  "resetPasswordToDefault",
  "rtkEnabled",
  "rtkFilterConfig",
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

export async function GET(request) {
  try {
    const auth = await requireDashboardApiAuth(request);
    if (!auth.ok) return auth.response;

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
    const auth = await requireDashboardApiAuth(request);
    if (!auth.ok) return auth.response;

    const settings0 = await getSettings();
    const body = await request.json();

    const resetPasswordToDefault = body.resetPasswordToDefault === true;
    delete body.resetPasswordToDefault;
    delete body.password;

    const unsupportedKey = validatePatchKeys(body);
    if (unsupportedKey) {
      return NextResponse.json({ error: `Unsupported setting: ${unsupportedKey}` }, { status: 400 });
    }

    if (resetPasswordToDefault) {
      const currentHash = settings0.password;
      if (currentHash) {
        if (!body.currentPassword) {
          return NextResponse.json({ error: "Current password required" }, { status: 400 });
        }
        const isValid = await bcrypt.compare(body.currentPassword, currentHash);
        if (!isValid) {
          return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      }
      delete body.currentPassword;
      const projected = { ...settings0, ...body, password: null };
      if (isRemoteExposureActive(projected) || isRemoteExposureRequest(body)) {
        const blockReason = getRemoteExposureBlockReason(projected);
        if (blockReason) {
          return NextResponse.json({ error: blockReason }, { status: 400 });
        }
      }
      const settings = await updateSettings({ password: null });
      const { password, oidcClientSecret, ...safeSettings } = settings;
      safeSettings.oidcConfigured = !!(safeSettings.oidcIssuerUrl && safeSettings.oidcClientId && oidcClientSecret);
      return NextResponse.json(safeSettings, { headers: SETTINGS_RESPONSE_HEADERS });
    }

    const projected = { ...settings0, ...body };
    if (isRemoteExposureActive(projected) || isRemoteExposureRequest(body)) {
      const blockReason = getRemoteExposureBlockReason(projected);
      if (blockReason) {
        return NextResponse.json({ error: blockReason }, { status: 400 });
      }
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
          return NextResponse.json({ error: "No password is set; omit currentPassword" }, { status: 400 });
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
