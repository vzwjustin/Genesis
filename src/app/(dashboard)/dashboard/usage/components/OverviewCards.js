"use client";

import PropTypes from "prop-types";

const fmt = (n) => new Intl.NumberFormat().format(n || 0);
const fmtCost = (n) => `$${(n || 0).toFixed(2)}`;

function StatCard({ label, value, valueClassName, hint }) {
  return (
    <div className="glass-stat flex min-w-0 flex-col gap-1 p-4 transition-shadow">
      <span className="text-xs font-medium text-text-subtle">{label}</span>
      <span className={`truncate text-2xl font-semibold tracking-tight ${valueClassName || ""}`}>
        {value}
      </span>
      {hint && <span className="text-[10px] text-text-muted">{hint}</span>}
    </div>
  );
}

StatCard.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.node.isRequired,
  valueClassName: PropTypes.string,
  hint: PropTypes.string,
};

export default function OverviewCards({ stats }) {
  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-4 sm:gap-4">
      <StatCard label="Total Requests" value={fmt(stats.totalRequests)} />
      <StatCard
        label="Total Input Tokens"
        value={fmt(stats.totalPromptTokens)}
        valueClassName="text-primary"
      />
      <StatCard
        label="Output Tokens"
        value={fmt(stats.totalCompletionTokens)}
        valueClassName="text-success"
      />
      <StatCard
        label="Est. Cost"
        value={`~${fmtCost(stats.totalCost)}`}
        valueClassName="text-warning"
        hint="Estimated, not actual billing"
      />
    </div>
  );
}

OverviewCards.propTypes = {
  stats: PropTypes.object.isRequired,
};
