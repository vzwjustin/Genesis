"use client";

import { useEffect, useState } from "react";
import PropTypes from "prop-types";

function hintStorageKey(id) {
  return `genesis-page-hint-dismissed-${id}`;
}

export default function PageHint({ id, title, children }) {
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(hintStorageKey(id)) === "1");
    } catch {
      setDismissed(false);
    }
  }, [id]);

  if (dismissed) return null;

  return (
    <div className="mb-4 rounded-xl border border-info/25 bg-info/10 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-2">
            <span className="material-symbols-outlined text-[16px] text-info">info</span>
            <h2 className="text-sm font-semibold text-text-main">{title}</h2>
          </div>
          <div className="text-xs leading-relaxed text-text-muted">{children}</div>
        </div>
        <button
          type="button"
          onClick={() => {
            try {
              localStorage.setItem(hintStorageKey(id), "1");
            } catch {
              /* ignore */
            }
            setDismissed(true);
          }}
          className="shrink-0 rounded-md p-1 text-text-muted transition-colors dashboard-row-hover hover:text-text-main"
          aria-label="Dismiss hint"
        >
          <span className="material-symbols-outlined text-[18px]">close</span>
        </button>
      </div>
    </div>
  );
}

PageHint.propTypes = {
  id: PropTypes.string.isRequired,
  title: PropTypes.string.isRequired,
  children: PropTypes.node.isRequired,
};
