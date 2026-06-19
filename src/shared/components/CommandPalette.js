"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { DASHBOARD_NAV_ITEMS } from "@/shared/constants/dashboardNav";

export default function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return DASHBOARD_NAV_ITEMS;
    return DASHBOARD_NAV_ITEMS.filter(
      (item) =>
        item.label.toLowerCase().includes(q) ||
        item.href.toLowerCase().includes(q) ||
        (item.description || "").toLowerCase().includes(q) ||
        (item.keywords || "").includes(q)
    );
  }, [query]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActiveIndex(0);
  }, []);

  const navigate = useCallback(
    (href) => {
      close();
      router.push(href);
    },
    [close, router]
  );

  useEffect(() => {
    const onKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
        setQuery("");
        setActiveIndex(0);
        return;
      }
      if (!open) return;
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, Math.max(0, results.length - 1)));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" && results[activeIndex]) {
        e.preventDefault();
        navigate(results[activeIndex].href);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, results, activeIndex, close, navigate]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center glass-overlay-heavy p-4 pt-[12vh]"
      onClick={close}
      role="presentation"
    >
      <div
        className="glass-modal-panel w-full max-w-lg rounded-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Go to page"
      >
        <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
          <span className="material-symbols-outlined text-text-muted text-[20px]">search</span>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search pages by name or purpose…"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-text-muted"
            aria-label="Search pages"
          />
          <kbd className="hidden sm:inline glass-code px-1.5 py-0.5 text-[10px] text-text-muted">Esc</kbd>
        </div>
        <ul className="max-h-72 overflow-y-auto py-1" role="listbox">
          {results.length === 0 ? (
            <li className="px-4 py-6 text-center text-sm text-text-muted">No matching pages</li>
          ) : (
            results.map((item, index) => (
              <li key={item.href}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  onClick={() => navigate(item.href)}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={`flex w-full items-start gap-3 px-4 py-2.5 text-left text-sm transition-colors ${
                    index === activeIndex ? "dashboard-filter-active font-medium" : "dashboard-row-hover"
                  }`}
                >
                  <span className="material-symbols-outlined text-[18px] mt-0.5 shrink-0">{item.icon}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{item.label}</span>
                    {item.description ? (
                      <span className="block text-xs text-text-muted font-normal leading-snug mt-0.5">
                        {item.description}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
        <div className="border-t border-border px-3 py-2 text-[10px] text-text-muted flex gap-3">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span className="ml-auto">⌘K / Ctrl+K</span>
        </div>
      </div>
    </div>
  );
}
