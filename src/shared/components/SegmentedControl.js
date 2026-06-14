"use client";

import { cn } from "@/shared/utils/cn";

export default function SegmentedControl({
  options = [],
  value,
  onChange,
  size = "md",
  className,
}) {
  const sizes = {
    sm: "h-7 text-xs",
    md: "h-9 text-sm",
    lg: "h-11 text-base",
  };

  return (
    <div className={cn("dashboard-segment-flex", className)}>
      {options.map((option) => (
        <button
          key={option.value}
          onClick={() => onChange(option.value)}
          aria-pressed={value === option.value}
          className={cn(
            "dashboard-segment inline-flex items-center gap-1.5 shrink-0 px-4 whitespace-nowrap",
            sizes[size],
            value === option.value && "dashboard-segment-active"
          )}
        >
          {option.icon && (
            <span className="material-symbols-outlined text-[16px]">
              {option.icon}
            </span>
          )}
          {option.label}
        </button>
      ))}
    </div>
  );
}
