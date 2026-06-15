"use client";

import Link from "next/link";
import { Button } from "@/shared/components";
import { cn } from "@/shared/utils/cn";

/**
 * Consistent empty state with optional primary action.
 */
export default function EmptyState({
  icon = "inbox",
  title,
  description,
  action,
  borderless = false,
  className,
}) {
  return (
    <div
      className={cn(
        "relative flex flex-col items-center justify-center px-6 py-12 text-center",
        !borderless && "glass-panel border border-dashed border-border/80",
        className,
      )}
    >
      <div className="glass-icon-ring mb-4 text-brand-500" aria-hidden="true">
        <span className="material-symbols-outlined text-[28px]">{icon}</span>
      </div>
      <h3 className="text-base font-semibold tracking-tight text-text-main">{title}</h3>
      {description ? (
        <p className="text-sm leading-relaxed text-text-muted mt-2 max-w-md">{description}</p>
      ) : null}
      {action ? (
        <div className="mt-4">
          {action.href ? (
            <Link href={action.href}>
              <Button variant="primary" size="sm">{action.label}</Button>
            </Link>
          ) : (
            <Button variant="primary" size="sm" onClick={action.onClick}>{action.label}</Button>
          )}
        </div>
      ) : null}
    </div>
  );
}
