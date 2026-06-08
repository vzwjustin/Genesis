"use client";

import PropTypes from "prop-types";

export function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
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
  const hasLocal = !!(s.hits || s.requests || s.bytesSaved);
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
    : `Saved ${formatBytes(s.bytesSaved)}`;
  const tokenLabel = kind === "injections"
    ? null
    : s.tokenSavingsAvailable
      ? `Est. tokens saved ${s.estimatedTokensSaved || 0}`
      : hasLocal
        ? "Savings not measurable"
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
