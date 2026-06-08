"use client";

import PropTypes from "prop-types";

export function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** ~4 chars per token — matches compressionStats.js estimate */
export function estimateTokensFromBytes(bytes) {
  const n = Number(bytes) || 0;
  return n > 0 ? Math.round(n / 4) : 0;
}

export function resolvedBytesSaved(stats = {}) {
  const explicit = Number(stats.bytesSaved);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const before = Number(stats.bytesBefore) || 0;
  const after = Number(stats.bytesAfter) || 0;
  return before > after ? before - after : 0;
}

/** Headline + subline for RTK / Headroom stat cards */
export function formatCompressionDisplay(stats = {}, kind = "bytes") {
  if (kind === "injections") {
    return {
      headline: `${stats.hits || 0} injections`,
      subline: null,
    };
  }

  const saved = resolvedBytesSaved(stats);
  const processed = Number(stats.bytesBefore) || 0;
  const tokensSaved = stats.tokenSavingsAvailable
    ? (Number(stats.estimatedTokensSaved) || estimateTokensFromBytes(saved))
    : estimateTokensFromBytes(saved);
  const requests = Number(stats.requests) || 0;
  const hits = Number(stats.hits) || 0;

  if (saved > 0) {
    return {
      headline: `~${tokensSaved.toLocaleString()} tokens`,
      subline: `${formatBytes(saved)} saved`,
    };
  }

  if (processed > 0 && (requests > 0 || hits > 0)) {
    return {
      headline: `~${estimateTokensFromBytes(processed).toLocaleString()} tokens`,
      subline: "Processed · no savings yet",
    };
  }

  if (requests > 0 || hits > 0) {
    return {
      headline: `${hits || requests} ${hits ? "filter hits" : "passes"}`,
      subline: "No measurable savings yet",
    };
  }

  return { headline: formatBytes(0), subline: null };
}

const EMPTY_TOOL_STATS = {
  requests: 0,
  hits: 0,
  bytesSaved: 0,
  estimatedTokensSaved: 0,
  tokenSavingsAvailable: false,
  lastDetail: "",
};

export default function CompressionStatRow({ stats, proxyStats, kind, emptyHint, dashboardUrl }) {
  const s = stats ?? EMPTY_TOOL_STATS;
  const saved = resolvedBytesSaved(s);
  const hasLocal = !!(s.hits || s.requests || saved || s.bytesBefore);
  const hasProxy = !!(proxyStats && (
    proxyStats.mcpCompressions ||
    proxyStats.tokensSaved ||
    proxyStats.proxyCompressionSaved ||
    proxyStats.requestsTotal ||
    proxyStats.compressionRequests
  ));
  const isEmpty = !hasLocal && !hasProxy;
  const detail = s.lastDetail ? ` · ${s.lastDetail}` : "";
  const savedLabel = kind === "injections"
    ? `Prompt injections ${s.hits || 0}`
    : saved > 0
      ? `Saved ${formatBytes(saved)} (~${estimateTokensFromBytes(saved).toLocaleString()} tokens)`
      : (Number(s.bytesBefore) || 0) > 0
        ? `Processed ~${estimateTokensFromBytes(s.bytesBefore).toLocaleString()} tokens`
        : `Saved ${formatBytes(0)}`;
  const tokenLabel = kind === "injections"
    ? null
    : saved > 0
      ? `Est. ${(s.estimatedTokensSaved || estimateTokensFromBytes(saved)).toLocaleString()} tokens saved`
      : (Number(s.bytesBefore) || 0) > 0 && hasLocal
        ? `${formatBytes(s.bytesBefore)} scanned`
        : null;
  const proxyTokens = Number(proxyStats?.tokensSaved) || Number(proxyStats?.proxyCompressionSaved) || 0;
  const proxyCompressions = Number(proxyStats?.mcpCompressions) || Number(proxyStats?.compressionRequests) || 0;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
      {isEmpty && emptyHint ? (
        <span>{emptyHint}</span>
      ) : (
        <>
          {hasLocal && (
            <>
              <span>{savedLabel}</span>
              {tokenLabel && <span>{tokenLabel}</span>}
              <span>Hits {s.hits || 0}</span>
              <span>Router requests {s.requests || 0}{detail}</span>
            </>
          )}
          {hasProxy && (
            <>
              <span>Proxy tokens {proxyTokens.toLocaleString()}</span>
              <span>Compressions {proxyCompressions.toLocaleString()}</span>
              {proxyStats.requestsTotal > 0 && (
                <span>Proxy API requests {proxyStats.requestsTotal.toLocaleString()}</span>
              )}
            </>
          )}
          {dashboardUrl && (
            <a
              href={dashboardUrl}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline hover:opacity-80"
            >
              Headroom dashboard
            </a>
          )}
        </>
      )}
    </div>
  );
}

CompressionStatRow.propTypes = {
  stats: PropTypes.shape({
    hits: PropTypes.number,
    requests: PropTypes.number,
    bytesSaved: PropTypes.number,
    estimatedTokensSaved: PropTypes.number,
    tokenSavingsAvailable: PropTypes.bool,
    lastDetail: PropTypes.string,
  }),
  proxyStats: PropTypes.shape({
    mcpCompressions: PropTypes.number,
    tokensSaved: PropTypes.number,
    proxyCompressionSaved: PropTypes.number,
    requestsTotal: PropTypes.number,
    compressionRequests: PropTypes.number,
  }),
  kind: PropTypes.oneOf(["bytes", "injections"]),
  emptyHint: PropTypes.string,
  dashboardUrl: PropTypes.string,
};
