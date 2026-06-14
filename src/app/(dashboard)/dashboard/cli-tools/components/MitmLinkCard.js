"use client";

import Link from "next/link";
import { Card } from "@/shared/components";
import Image from "next/image";

/**
 * Clickable card for MITM tools — navigates to /dashboard/mitm on click.
 */
export default function MitmLinkCard({ tool, dnsEnabled = false, serverRunning = false }) {
  return (
    <Link href={`/dashboard/mitm?tool=${tool.id}`} className="block">
      <Card padding="sm" className="overflow-hidden hover:border-border hover:shadow-md transition-all duration-200 cursor-pointer">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="size-8 flex items-center justify-center shrink-0">
              <Image
                src={tool.image}
                alt={tool.name}
                width={32}
                height={32}
                className="size-8 object-contain rounded-lg"
                sizes="32px"
                onError={(e) => { e.target.style.display = "none"; }}
              />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="font-medium text-sm">{tool.name}</h3>
                <span className="px-1.5 py-0.5 text-[10px] font-medium bg-purple-500/10 text-purple-600 dark:text-purple-400 rounded-full">MITM</span>
                {serverRunning && dnsEnabled && (
                  <span className="px-1.5 py-0.5 text-[10px] font-medium bg-success/10 text-success rounded-full">DNS on</span>
                )}
                {serverRunning && !dnsEnabled && (
                  <span className="px-1.5 py-0.5 text-[10px] font-medium bg-warning/10 text-warning rounded-full">DNS off</span>
                )}
              </div>
              <p className="text-xs text-text-muted truncate">{tool.description}</p>
            </div>
          </div>
          <span className="material-symbols-outlined text-text-muted text-[20px]">chevron_right</span>
        </div>
      </Card>
    </Link>
  );
}
