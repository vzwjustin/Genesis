"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import Button from "./Button";
import {
  DASHBOARD_TOUR_STEPS,
  DASHBOARD_TOUR_OPEN_EVENT,
  completeDashboardTour,
  isDashboardTourComplete,
  isDashboardTourSnoozed,
  snoozeDashboardTour,
} from "@/shared/utils/dashboardTour";

export default function DashboardTour() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);

  const close = useCallback((markComplete) => {
    if (markComplete) completeDashboardTour();
    setOpen(false);
    setStepIndex(0);
  }, []);

  const tryAutoOpen = useCallback(() => {
    if (pathname !== "/dashboard") return;
    if (isDashboardTourComplete() || isDashboardTourSnoozed()) return;
    setStepIndex(0);
    setOpen(true);
  }, [pathname]);

  useEffect(() => {
    tryAutoOpen();
  }, [tryAutoOpen]);

  useEffect(() => {
    const onOpen = () => {
      setStepIndex(0);
      setOpen(true);
    };
    window.addEventListener(DASHBOARD_TOUR_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(DASHBOARD_TOUR_OPEN_EVENT, onOpen);
  }, []);

  if (!open) return null;

  const step = DASHBOARD_TOUR_STEPS[stepIndex];
  const isLast = stepIndex === DASHBOARD_TOUR_STEPS.length - 1;

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div className="absolute inset-0 glass-overlay-heavy" aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="dashboard-tour-title"
        aria-describedby="dashboard-tour-body"
        className="relative z-10 w-full max-w-md rounded-xl glass-modal-panel p-6 shadow-2xl"
      >
        <div className="mb-4 flex items-start gap-3">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-brand-500/15 text-brand-500">
            <span className="material-symbols-outlined text-[24px]">{step.icon}</span>
          </div>
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
              Quick tour · {stepIndex + 1}/{DASHBOARD_TOUR_STEPS.length}
            </p>
            <h2 id="dashboard-tour-title" className="mt-1 text-lg font-semibold text-text-main">
              {step.title}
            </h2>
          </div>
        </div>

        <p id="dashboard-tour-body" className="text-sm leading-relaxed text-text-muted">
          {step.body}
        </p>

        <div className="mt-4 flex items-center gap-1.5">
          {DASHBOARD_TOUR_STEPS.map((_, index) => (
            <span
              key={index}
              className={`h-1.5 flex-1 rounded-full transition-colors ${
                index <= stepIndex ? "bg-brand-500" : "bg-border/70"
              }`}
              aria-hidden="true"
            />
          ))}
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              snoozeDashboardTour();
              close(false);
            }}
          >
            Remind me later
          </Button>
          {stepIndex > 0 ? (
            <Button variant="outline" size="sm" onClick={() => setStepIndex((i) => i - 1)}>
              Back
            </Button>
          ) : null}
          {step.href ? (
            <Link href={step.href} className="ml-auto" onClick={() => close(true)}>
              <Button size="sm" variant="outline">{step.action}</Button>
            </Link>
          ) : null}
          {isLast ? (
            <Button size="sm" variant="primary" onClick={() => close(true)} className={step.href ? "" : "ml-auto"}>
              Got it
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              onClick={() => setStepIndex((i) => i + 1)}
              className={step.href ? "" : "ml-auto"}
            >
              Next
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
