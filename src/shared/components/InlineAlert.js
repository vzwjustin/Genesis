"use client";

import Link from "next/link";
import { cn } from "@/shared/utils/cn";

const VARIANTS = {
  warning: {
    wrapper: "bg-amber-500/10 border-amber-500/20 text-amber-800 dark:text-amber-300",
    icon: "warning",
    iconClass: "text-amber-600 dark:text-amber-400",
  },
  info: {
    wrapper: "bg-blue-500/10 border-blue-500/20 text-blue-800 dark:text-blue-300",
    icon: "info",
    iconClass: "text-blue-600 dark:text-blue-400",
  },
  danger: {
    wrapper: "bg-red-500/10 border-red-500/20 text-red-800 dark:text-red-300",
    icon: "error",
    iconClass: "text-red-600 dark:text-red-400",
  },
  caution: {
    wrapper: "bg-yellow-500/10 border-yellow-500/30 text-yellow-800 dark:text-yellow-300",
    icon: "warning",
    iconClass: "text-yellow-600 dark:text-yellow-400",
  },
};

/**
 * Unified inline alert banner (warning, info, danger, caution).
 */
export default function InlineAlert({
  variant = "warning",
  title,
  message,
  children,
  action,
  className,
  compact = false,
}) {
  const styles = VARIANTS[variant] || VARIANTS.warning;
  const isAnchor = action?.href?.startsWith("#");

  return (
    <div
      className={cn(
        "flex items-start gap-2 border rounded-lg",
        compact ? "px-3 py-2" : "px-3 py-2.5",
        styles.wrapper,
        className
      )}
    >
      <span className={cn("material-symbols-outlined text-[16px] shrink-0 mt-0.5", styles.iconClass)}>
        {styles.icon}
      </span>
      <div className="flex-1 min-w-0">
        {title ? <p className={cn("font-medium", compact ? "text-xs" : "text-sm")}>{title}</p> : null}
        {message ? (
          <p className={cn("leading-relaxed", compact ? "text-xs" : "text-xs sm:text-sm", title && "mt-0.5")}>
            {message}
          </p>
        ) : null}
        {children}
      </div>
      {action ? (
        isAnchor ? (
          <a
            href={action.href}
            className="text-xs font-medium underline shrink-0 hover:opacity-80 mt-0.5"
            onClick={(e) => {
              e.preventDefault();
              document.getElementById(action.href.slice(1))?.scrollIntoView({ behavior: "smooth" });
            }}
          >
            {action.label}
          </a>
        ) : (
          <Link href={action.href} className="text-xs font-medium underline shrink-0 hover:opacity-80 mt-0.5">
            {action.label}
          </Link>
        )
      ) : null}
    </div>
  );
}
