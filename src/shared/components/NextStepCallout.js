"use client";

import Link from "next/link";
import PropTypes from "prop-types";
import Button from "./Button";

export default function NextStepCallout({ step, stepIndex, totalSteps }) {
  if (!step) return null;

  return (
    <div className="rounded-xl border border-brand-500/30 bg-brand-500/10 p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-500/20 text-brand-500">
            <span className="material-symbols-outlined text-[22px]">{step.icon}</span>
          </div>
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-wide text-brand-500">
              Next step · {stepIndex + 1} of {totalSteps}
              {step.optional ? " · optional" : ""}
            </p>
            <h2 className="mt-0.5 text-sm font-semibold text-text-main">{step.label}</h2>
            <p className="mt-1 text-xs leading-relaxed text-text-muted">{step.description}</p>
          </div>
        </div>
        <Link href={step.href} className="shrink-0">
          <Button size="sm" variant="primary">{step.action}</Button>
        </Link>
      </div>
    </div>
  );
}

NextStepCallout.propTypes = {
  step: PropTypes.shape({
    label: PropTypes.string.isRequired,
    description: PropTypes.string.isRequired,
    href: PropTypes.string.isRequired,
    icon: PropTypes.string.isRequired,
    action: PropTypes.string.isRequired,
    optional: PropTypes.bool,
  }),
  stepIndex: PropTypes.number.isRequired,
  totalSteps: PropTypes.number.isRequired,
};
