"use client";

import { useState, useRef, useCallback } from "react";
import { cn } from "@/shared/utils/cn";

const ICON_SIZE = {
  xs: "text-[12px]",
  sm: "text-[14px]",
  md: "text-[18px]",
};

async function writeClipboard(text) {
  if (navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

/**
 * Self-contained copy-to-clipboard button. Tracks its own copied state, so no
 * `copied`/`onCopy` prop-drilling. Swaps content_copy → check on success.
 *
 * @param {string} [value] - text to copy (synchronous case)
 * @param {() => Promise<string>|string} [getValue] - async resolver (e.g. reveal a secret) — takes precedence over value
 * @param {string} [label] - when set, renders icon + label ("Copy" → "Copied!")
 * @param {"xs"|"sm"|"md"} [size] - icon size (default "sm")
 * @param {string} [ariaLabel] - accessible label for icon-only buttons (default "Copy")
 * @param {boolean} [stopPropagation] - stop click bubbling (for buttons inside clickable rows/cards)
 */
export default function CopyButton({
  value,
  getValue,
  label,
  size = "sm",
  ariaLabel = "Copy",
  stopPropagation = false,
  className,
  ...props
}) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef(null);

  const handleCopy = useCallback(async (e) => {
    if (stopPropagation) e.stopPropagation();
    const text = getValue ? await getValue() : value;
    if (!text) return;
    await writeClipboard(text);
    setCopied(true);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopied(false), 2000);
  }, [value, getValue, stopPropagation]);

  if (label) {
    return (
      <button
        type="button"
        onClick={handleCopy}
        aria-label={ariaLabel}
        className={cn(
          "inline-flex items-center gap-1.5 text-text-muted transition-colors hover:text-brand-500",
          className,
        )}
        {...props}
      >
        <span className={cn("material-symbols-outlined", ICON_SIZE[size])}>
          {copied ? "check" : "content_copy"}
        </span>
        {copied ? "Copied!" : label}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={ariaLabel}
      className={cn(
        "rounded p-1 text-text-muted transition-colors dashboard-row-hover hover:text-text-main",
        className,
      )}
      {...props}
    >
      <span className={cn("material-symbols-outlined", ICON_SIZE[size])}>
        {copied ? "check" : "content_copy"}
      </span>
    </button>
  );
}
