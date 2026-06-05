"use client";

import Link from "next/link";
import { useDashboardSecurity } from "@/shared/hooks/useDashboardSecurity";

/** Amber dot on Profile nav when dashboard security settings need attention. */
export default function SidebarSecurityHint() {
  const { loading, isLoginUnsafe, requireApiKey, remoteExposureActive } = useDashboardSecurity();

  if (loading) return null;
  const needsAttention = isLoginUnsafe || (remoteExposureActive && !requireApiKey);
  if (!needsAttention) return null;

  return (
    <Link
      href="/dashboard/profile"
      className="mx-3 mb-2 flex items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-800 dark:text-amber-200 hover:bg-amber-500/15 transition-colors"
      title="Review security settings"
    >
      <span className="material-symbols-outlined text-[14px]">shield</span>
      <span className="flex-1 leading-snug">Security settings need attention</span>
      <span className="material-symbols-outlined text-[14px]">chevron_right</span>
    </Link>
  );
}
