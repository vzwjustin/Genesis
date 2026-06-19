import { NextResponse } from "next/server";
import { getSettingsSafe } from "@/lib/localDb";
import bcrypt from "bcryptjs";
import { timingSafeEqual, createHash } from "node:crypto";
import { cookies } from "next/headers";
import { setDashboardAuthCookie } from "@/lib/auth/dashboardSession";
import { isOidcConfigured } from "@/lib/auth/oidc";
import { checkLock, recordFail, recordSuccess, getClientIp } from "@/lib/auth/loginLimiter";
import { isTunnelDashboardAccessDenied } from "@/shared/utils/tunnelRequest";

const RESET_HINT = "Forgot password? Reset to default via Genesis CLI → Settings → Reset Password to Default.";

// Constant-time string compare. timingSafeEqual requires equal-length buffers
// and throws otherwise, which itself leaks length — hash both sides to a fixed
// width first so the comparison is length-independent.
function timingSafeEqualStr(a, b) {
  const ha = createHash("sha256").update(String(a ?? "")).digest();
  const hb = createHash("sha256").update(String(b ?? "")).digest();
  return timingSafeEqual(ha, hb);
}

export async function POST(request) {
  try {
    const ip = getClientIp(request);
    const lock = checkLock(ip);
    if (lock.locked) {
      return NextResponse.json(
        { error: `Too many failed attempts. Try again in ${lock.retryAfter}s. ${RESET_HINT}`, retryAfter: lock.retryAfter, resetHint: RESET_HINT },
        { status: 429, headers: { "Retry-After": String(lock.retryAfter) } }
      );
    }

    let password;
    try {
      ({ password } = await request.json());
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }
    const settings = await getSettingsSafe();

    // Block login via tunnel/tailscale if dashboard access is disabled
    if (isTunnelDashboardAccessDenied(request, settings)) {
      return NextResponse.json({ error: "Dashboard access via tunnel is disabled" }, { status: 403 });
    }

    // First-run password must be explicitly provided via INITIAL_PASSWORD.
    const storedHash = settings.password;

    if (settings.authMode === "oidc" && isOidcConfigured(settings)) {
      return NextResponse.json({ error: "Password login is disabled. Use OIDC sign in." }, { status: 403 });
    }

    // Reserve this attempt and re-check the lock BEFORE the (deliberately slow)
    // password comparison, with NO await between record + check, so a burst of
    // concurrent requests can't all slip past the single top-of-handler lock
    // check during the compare window (TOCTOU brute-force amplification).
    const { remainingBeforeLock } = recordFail(ip);
    const reservedLock = checkLock(ip);
    if (reservedLock.locked) {
      return NextResponse.json(
        { error: `Too many failed attempts. Try again in ${reservedLock.retryAfter}s. ${RESET_HINT}`, retryAfter: reservedLock.retryAfter, resetHint: RESET_HINT },
        { status: 429, headers: { "Retry-After": String(reservedLock.retryAfter) } }
      );
    }

    let isValid = false;
    if (storedHash) {
      isValid = await bcrypt.compare(password, storedHash);
    } else {
      // Constant-time compare so the pre-setup path doesn't leak
      // INITIAL_PASSWORD length/content via response timing.
      const initialPassword = process.env.INITIAL_PASSWORD;
      isValid = typeof initialPassword === "string"
        && initialPassword.length > 0
        && timingSafeEqualStr(password, initialPassword);
    }

    if (isValid) {
      // Clear the reserved attempt on success.
      recordSuccess(ip);
      const cookieStore = await cookies();
      await setDashboardAuthCookie(cookieStore, request);

      return NextResponse.json({ success: true });
    }

    // The failed attempt was already recorded above; do not double-count.
    return NextResponse.json(
      { error: `Invalid password. ${remainingBeforeLock} attempt(s) left before lockout.`, remainingBeforeLock },
      { status: 401 }
    );
  } catch (error) {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
