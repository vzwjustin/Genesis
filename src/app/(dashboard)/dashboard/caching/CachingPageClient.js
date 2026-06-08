"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  Card,
  Button,
  Toggle,
  SegmentedControl,
  Badge,
  PageLoading,
} from "@/shared/components";
import CompressionStatRow, { formatBytes } from "@/shared/components/CompressionStatRow";
import InlineAlert from "@/shared/components/InlineAlert";
import RequestLogSessionModal from "@/shared/components/RequestLogSessionModal";
import { useHeaderSearchStore } from "@/store/headerSearchStore";

const TABS = [
  { value: "overview", label: "Overview" },
  { value: "history", label: "History" },
  { value: "provider", label: "Provider Cache" },
  { value: "logs", label: "Debug Logs" },
];

const CACHE_PERIODS = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "All" },
];

const CAVEMAN_LEVELS = [
  { id: "lite", label: "Lite", desc: "Drop filler, keep grammar" },
  { id: "full", label: "Full", desc: "Drop articles, fragments OK" },
  { id: "ultra", label: "Ultra", desc: "Telegraphic, max compression" },
];

const SUBSYSTEMS = [
  { value: "", label: "All" },
  { value: "rtk", label: "RTK" },
  { value: "headroom", label: "Headroom" },
  { value: "caveman", label: "Caveman" },
];

function StatCard({ title, icon, color, stats, kind, proxyStats, dashboardUrl }) {
  const s = stats || {};
  const primary = kind === "injections"
    ? `${s.hits || 0} injections`
    : formatBytes(s.bytesSaved || 0);
  const secondary = kind === "bytes" && s.tokenSavingsAvailable
    ? `~${(s.estimatedTokensSaved || 0).toLocaleString()} tokens`
    : kind === "bytes" && (s.bytesSaved || 0) > 0
      ? "Savings estimated"
      : null;

  return (
    <Card padding="md" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`material-symbols-outlined text-[22px] ${color}`}>{icon}</span>
          <h3 className="font-semibold text-sm truncate">{title}</h3>
        </div>
        {(s.hits > 0 || s.requests > 0) && (
          <Badge variant="success" size="sm">{s.hits || s.requests} hits</Badge>
        )}
      </div>
      <div>
        <p className="text-2xl font-bold text-text-main tabular-nums">{primary}</p>
        {secondary && <p className="text-xs text-text-muted mt-0.5">{secondary}</p>}
      </div>
      <CompressionStatRow
        stats={stats}
        proxyStats={proxyStats}
        kind={kind}
        dashboardUrl={dashboardUrl}
        emptyHint="No activity yet — send chat traffic through 9router"
      />
    </Card>
  );
}

export default function CachingPageClient() {
  const [activeTab, setActiveTab] = useState("overview");
  const [loading, setLoading] = useState(true);
  const [compressionStats, setCompressionStats] = useState(null);
  const [headroomStatus, setHeadroomStatus] = useState(null);
  const [history, setHistory] = useState([]);
  const [historyFilter, setHistoryFilter] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [resetting, setResetting] = useState(false);

  const [rtkEnabled, setRtkEnabled] = useState(true);
  const [cavemanEnabled, setCavemanEnabled] = useState(false);
  const [cavemanLevel, setCavemanLevel] = useState("full");
  const [headroomEnabled, setHeadroomEnabled] = useState(false);
  const [passthroughCompression, setPassthroughCompression] = useState(false);
  const [ccFilterNaming, setCcFilterNaming] = useState(false);
  const [mitmAutoSetupOnImport, setMitmAutoSetupOnImport] = useState(true);
  const [providerCache, setProviderCache] = useState(null);
  const [cachePeriod, setCachePeriod] = useState("7d");
  const [filterLeaderboard, setFilterLeaderboard] = useState([]);
  const [fileLogSessions, setFileLogSessions] = useState([]);
  const [enableRequestLogs, setEnableRequestLogs] = useState(false);
  const [clearingHistory, setClearingHistory] = useState(false);
  const [logsFailedOnly, setLogsFailedOnly] = useState(false);
  const [selectedLogSession, setSelectedLogSession] = useState(null);
  const searchQuery = useHeaderSearchStore((s) => s.query);
  const registerSearch = useHeaderSearchStore((s) => s.register);
  const unregisterSearch = useHeaderSearchStore((s) => s.unregister);

  const patchSetting = async (patch) => {
    try {
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    } catch { /* ignore */ }
  };

  const fetchCompressionStats = useCallback(async () => {
    try {
      const res = await fetch("/api/compression/stats", { cache: "no-store" });
      if (res.ok) setCompressionStats(await res.json());
    } catch { /* ignore */ }
  }, []);

  const fetchHeadroomStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/headroom/status");
      if (res.ok) setHeadroomStatus(await res.json());
    } catch { /* ignore */ }
  }, []);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setRtkEnabled(data.rtkEnabled !== false);
      setCavemanEnabled(data.cavemanEnabled === true);
      setCavemanLevel(data.cavemanLevel || "full");
      setHeadroomEnabled(data.headroomEnabled === true);
      setPassthroughCompression(data.passthroughCompression === true);
      setCcFilterNaming(data.ccFilterNaming === true);
      setMitmAutoSetupOnImport(data.mitmAutoSetupOnImport !== false);
      setEnableRequestLogs(data.enableRequestLogs === true);
    } catch { /* ignore */ }
  }, []);

  const fetchProviderCache = useCallback(async (period = cachePeriod) => {
    try {
      const res = await fetch(`/api/compression/provider-cache?period=${period}`, { cache: "no-store" });
      if (res.ok) setProviderCache(await res.json());
    } catch { /* ignore */ }
  }, [cachePeriod]);

  const fetchFilterLeaderboard = useCallback(async () => {
    try {
      const res = await fetch("/api/compression/filter-leaderboard?limit=12", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setFilterLeaderboard(data.rows || []);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (activeTab === "logs") {
      registerSearch("Filter log sessions…");
    } else {
      unregisterSearch();
    }
    return () => unregisterSearch();
  }, [activeTab, registerSearch, unregisterSearch]);

  const visibleFileLogSessions = fileLogSessions.filter((s) => {
    if (logsFailedOnly && !s.hasError) return false;
    if (searchQuery.trim()) {
      return s.name.toLowerCase().includes(searchQuery.trim().toLowerCase());
    }
    return true;
  });

  const fetchFileLogSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/request-logs/sessions?limit=30", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setFileLogSessions(data.sessions || []);
      }
    } catch { /* ignore */ }
  }, []);

  const fetchHistory = useCallback(async (subsystem = historyFilter) => {
    setHistoryLoading(true);
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (subsystem) params.set("subsystem", subsystem);
      const res = await fetch(`/api/compression/history?${params}`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setHistory(data.rows || []);
      }
    } catch { /* ignore */ } finally {
      setHistoryLoading(false);
    }
  }, [historyFilter]);

  useEffect(() => {
    Promise.all([fetchSettings(), fetchCompressionStats(), fetchHeadroomStatus()])
      .finally(() => setLoading(false));
  }, [fetchSettings, fetchCompressionStats, fetchHeadroomStatus]);

  useEffect(() => {
    if (activeTab !== "history") return;
    fetchHistory(historyFilter);
  }, [activeTab, historyFilter, fetchHistory]);

  useEffect(() => {
    if (activeTab === "provider") fetchProviderCache(cachePeriod);
    if (activeTab === "overview") fetchFilterLeaderboard();
    if (activeTab === "logs") fetchFileLogSessions();
  }, [activeTab, cachePeriod, fetchProviderCache, fetchFilterLeaderboard, fetchFileLogSessions]);

  useEffect(() => {
    const anyOn = rtkEnabled || cavemanEnabled || headroomEnabled;
    if (!anyOn) return;
    const timer = setInterval(() => {
      if (!document.hidden) fetchCompressionStats();
    }, 30000);
    return () => clearInterval(timer);
  }, [rtkEnabled, cavemanEnabled, headroomEnabled, fetchCompressionStats]);

  const handleResetStats = async () => {
    if (!window.confirm("Reset aggregate compression statistics? Per-request history rows are kept.")) return;
    setResetting(true);
    try {
      const res = await fetch("/api/compression/reset", { method: "POST" });
      if (res.ok) await fetchCompressionStats();
    } finally {
      setResetting(false);
    }
  };

  const handleClearHistory = async () => {
    if (!window.confirm("Delete all per-request compression history rows? This cannot be undone.")) return;
    setClearingHistory(true);
    try {
      const res = await fetch("/api/compression/history/clear", { method: "POST" });
      if (res.ok) {
        setHistory([]);
        await fetchFilterLeaderboard();
      }
    } finally {
      setClearingHistory(false);
    }
  };

  const headroomDashboardUrl =
    compressionStats?.headroomProxy?.dashboardUrl ||
    (headroomStatus?.reachable ? `${headroomStatus.proxyUrl}/dashboard` : null);

  if (loading) return <PageLoading />;

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text-main">Caching & Compression</h1>
          <p className="text-sm text-text-muted mt-1">
            Token savers, compression history, and upstream provider prompt-cache behavior.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            icon="refresh"
            onClick={() => {
              fetchCompressionStats();
              if (activeTab === "history") fetchHistory();
            }}
          >
            Refresh
          </Button>
          {activeTab === "overview" && (
            <Button
              size="sm"
              variant="ghost"
              icon="restart_alt"
              onClick={handleResetStats}
              loading={resetting}
            >
              Reset totals
            </Button>
          )}
        </div>
      </div>

      <SegmentedControl options={TABS} value={activeTab} onChange={setActiveTab} />

      {activeTab === "overview" && (
        <>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <StatCard
              title="RTK"
              icon="compress"
              color="text-primary"
              stats={compressionStats?.tools?.rtk}
              kind="bytes"
            />
            <StatCard
              title="Headroom"
              icon="history"
              color="text-info"
              stats={compressionStats?.tools?.headroom}
              kind="bytes"
              proxyStats={compressionStats?.headroomProxy}
              dashboardUrl={headroomDashboardUrl}
            />
            <StatCard
              title="Caveman"
              icon="short_text"
              color="text-warning"
              stats={compressionStats?.tools?.caveman}
              kind="injections"
            />
          </div>

          {compressionStats?.updatedAt && (
            <p className="text-xs text-text-muted">
              Last updated {new Date(compressionStats.updatedAt).toLocaleString()}
            </p>
          )}

          <Card>
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <span className="material-symbols-outlined text-primary">tune</span>
              Controls
            </h2>
            <div className="flex flex-col divide-y divide-border">
              <div className="flex items-center justify-between py-4 gap-4">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">RTK tool-output compression</p>
                  <p className="text-sm text-text-muted">git/grep/diff filters — respects provider cache boundaries</p>
                </div>
                <Toggle
                  checked={rtkEnabled}
                  onChange={(v) => { setRtkEnabled(v); patchSetting({ rtkEnabled: v }); fetchCompressionStats(); }}
                />
              </div>
              <div className="flex items-center justify-between py-4 gap-4 flex-wrap">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">Caveman output compression</p>
                  <p className="text-sm text-text-muted">Terse system prompts — preserves cached prefix blocks</p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {cavemanEnabled && CAVEMAN_LEVELS.map((lvl) => (
                    <button
                      key={lvl.id}
                      type="button"
                      onClick={() => { setCavemanLevel(lvl.id); patchSetting({ cavemanLevel: lvl.id }); }}
                      className={`px-3 py-1.5 rounded text-xs font-medium border transition-colors ${
                        cavemanLevel === lvl.id
                          ? "bg-primary text-white border-primary"
                          : "bg-transparent border-border text-text-muted hover:bg-surface-2"
                      }`}
                      title={lvl.desc}
                    >
                      {lvl.label}
                    </button>
                  ))}
                  <Toggle
                    checked={cavemanEnabled}
                    onChange={(v) => { setCavemanEnabled(v); patchSetting({ cavemanEnabled: v }); fetchCompressionStats(); }}
                  />
                </div>
              </div>
              <div className="flex items-center justify-between py-4 gap-4">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">Headroom history compression</p>
                  <p className="text-sm text-text-muted">
                    {headroomStatus?.reachable
                      ? `Proxy reachable at ${headroomStatus.proxyUrl}`
                      : "Install headroom-ai[proxy] or set HEADROOM_API_KEY for cloud"}
                  </p>
                </div>
                <Toggle
                  checked={headroomEnabled}
                  onChange={(v) => {
                    setHeadroomEnabled(v);
                    patchSetting({ headroomEnabled: v });
                    if (v) fetchHeadroomStatus();
                    fetchCompressionStats();
                  }}
                  disabled={!headroomStatus?.reachable}
                />
              </div>
              <div className="flex items-center justify-between py-4 gap-4">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">Passthrough compression</p>
                  <p className="text-sm text-text-muted">Apply savers to native passthrough traffic (off by default)</p>
                </div>
                <Toggle
                  checked={passthroughCompression}
                  onChange={(v) => {
                    setPassthroughCompression(v);
                    patchSetting({ passthroughCompression: v });
                    fetchCompressionStats();
                  }}
                />
              </div>
              <div className="flex items-center justify-between py-4 gap-4">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">Claude Code filter naming</p>
                  <p className="text-sm text-text-muted">Bypass RTK when tool names match CC filter patterns</p>
                </div>
                <Toggle
                  checked={ccFilterNaming}
                  onChange={(v) => { setCcFilterNaming(v); patchSetting({ ccFilterNaming: v }); }}
                />
              </div>
              <div className="flex items-center justify-between py-4 gap-4">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">MITM auto-setup on OAuth import</p>
                  <p className="text-sm text-text-muted">Start MITM + DNS + model mappings after Kiro/Antigravity/Copilot OAuth</p>
                </div>
                <Toggle
                  checked={mitmAutoSetupOnImport}
                  onChange={(v) => { setMitmAutoSetupOnImport(v); patchSetting({ mitmAutoSetupOnImport: v }); }}
                />
              </div>
            </div>
          </Card>

          <Card>
            <h2 className="text-lg font-semibold mb-3">RTK filter leaderboard</h2>
            {filterLeaderboard.length === 0 ? (
              <p className="text-sm text-text-muted">No RTK filter hits yet — compression stats appear after chat traffic.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-text-muted">
                      <th className="px-3 py-2">Filter</th>
                      <th className="px-3 py-2 text-right">Hits</th>
                      <th className="px-3 py-2 text-right">Bytes saved</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filterLeaderboard.map((row) => (
                      <tr key={row.filter} className="border-b border-border/50">
                        <td className="px-3 py-2 font-mono text-xs">{row.filter}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{row.hits}</td>
                        <td className="px-3 py-2 text-right font-mono text-xs text-success">{formatBytes(row.bytesSaved)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <InlineAlert
            variant="info"
            message={
              <>
                Tunnel and endpoint settings live on the{" "}
                <Link href="/dashboard/endpoint#rtk" className="text-primary underline">Endpoint</Link> page.
                Compression chain order: RTK → Headroom → Caveman.
              </>
            }
          />
        </>
      )}

      {activeTab === "history" && (
        <Card padding="sm">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between px-2 pt-2">
            <h2 className="text-lg font-semibold">Per-request compression log</h2>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                icon="delete_sweep"
                onClick={handleClearHistory}
                loading={clearingHistory}
              >
                Clear history
              </Button>
              {SUBSYSTEMS.map((s) => (
                <button
                  key={s.value || "all"}
                  type="button"
                  onClick={() => setHistoryFilter(s.value)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                    historyFilter === s.value
                      ? "bg-primary/10 border-primary/40 text-primary"
                      : "border-border text-text-muted hover:bg-surface-2"
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          {historyLoading ? (
            <p className="p-4 text-sm text-text-muted">Loading…</p>
          ) : history.length === 0 ? (
            <p className="p-4 text-sm text-text-muted">No compression events recorded yet.</p>
          ) : (
            <div className="overflow-x-auto mt-2">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-text-muted">
                    <th className="px-3 py-2 font-medium">Time</th>
                    <th className="px-3 py-2 font-medium">Subsystem</th>
                    <th className="px-3 py-2 font-medium text-right">Before</th>
                    <th className="px-3 py-2 font-medium text-right">After</th>
                    <th className="px-3 py-2 font-medium text-right">Saved</th>
                    <th className="px-3 py-2 font-medium">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((row) => (
                    <tr key={row.id} className="border-b border-border/50 hover:bg-surface-2/50">
                      <td className="px-3 py-2 whitespace-nowrap text-xs">
                        {new Date(row.timestamp).toLocaleString()}
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant="default" size="sm">{row.subsystem}</Badge>
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{formatBytes(row.bytesBefore)}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{formatBytes(row.bytesAfter)}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs text-success">
                        {formatBytes(row.bytesSaved)}
                      </td>
                      <td className="px-3 py-2 text-xs text-text-muted max-w-[200px] truncate">
                        {row.level ? `level=${row.level}` : row.filterHits || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {activeTab === "provider" && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <InlineAlert
              variant="info"
              className="flex-1"
              message="Upstream prompt-cache tokens are tracked in usage logs. Web search responses are cached locally per provider cacheTTLMs."
            />
            <SegmentedControl
              options={CACHE_PERIODS}
              value={cachePeriod}
              onChange={(v) => { setCachePeriod(v); fetchProviderCache(v); }}
              size="sm"
            />
          </div>

          {providerCache?.providerCache && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Card padding="md">
                <p className="text-xs text-text-muted">Cache hit rate</p>
                <p className="text-2xl font-bold tabular-nums">{providerCache.providerCache.hitRate}%</p>
              </Card>
              <Card padding="md">
                <p className="text-xs text-text-muted">Cache read tokens</p>
                <p className="text-2xl font-bold tabular-nums">{providerCache.providerCache.cacheReadTokens.toLocaleString()}</p>
              </Card>
              <Card padding="md">
                <p className="text-xs text-text-muted">Cache creation</p>
                <p className="text-2xl font-bold tabular-nums">{providerCache.providerCache.cacheCreationTokens.toLocaleString()}</p>
              </Card>
              <Card padding="md">
                <p className="text-xs text-text-muted">Search cache hits</p>
                <p className="text-2xl font-bold tabular-nums">{providerCache.searchCache?.hits || 0}</p>
              </Card>
            </div>
          )}

          {providerCache?.providerCache?.byProvider?.length > 0 && (
            <Card padding="sm">
              <h3 className="font-semibold px-2 pt-2 mb-2">By provider</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-text-muted">
                      <th className="px-3 py-2">Provider</th>
                      <th className="px-3 py-2 text-right">Requests</th>
                      <th className="px-3 py-2 text-right">Hit rate</th>
                      <th className="px-3 py-2 text-right">Cache read</th>
                      <th className="px-3 py-2 text-right">Cache create</th>
                    </tr>
                  </thead>
                  <tbody>
                    {providerCache.providerCache.byProvider.map((row) => (
                      <tr key={row.provider} className="border-b border-border/50">
                        <td className="px-3 py-2">{row.provider}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{row.requests}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{row.hitRate}%</td>
                        <td className="px-3 py-2 text-right tabular-nums">{row.cacheReadTokens.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{row.cacheCreationTokens.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Card>
              <h3 className="font-semibold mb-2 flex items-center gap-2">
                <span className="material-symbols-outlined text-primary text-[20px]">memory</span>
                Anthropic KV cache
              </h3>
              <p className="text-sm text-text-muted">
                Tracks <code className="text-xs">cache_read_input_tokens</code> and{" "}
                <code className="text-xs">cache_creation_input_tokens</code>. RTK and Headroom stop at the last{" "}
                <code className="text-xs">cache_control</code> boundary so cached prefixes stay valid.
              </p>
            </Card>
            <Card>
              <h3 className="font-semibold mb-2 flex items-center gap-2">
                <span className="material-symbols-outlined text-primary text-[20px]">memory</span>
                OpenAI prefix cache
              </h3>
              <p className="text-sm text-text-muted">
                Uses <code className="text-xs">cached_tokens</code> in usage metadata. Codex may send{" "}
                <code className="text-xs">prompt_cache_key</code> for session-stable caching.
              </p>
            </Card>
            <Card>
              <h3 className="font-semibold mb-2 flex items-center gap-2">
                <span className="material-symbols-outlined text-primary text-[20px]">memory</span>
                Antigravity / Gemini
              </h3>
              <p className="text-sm text-text-muted">
                Implicit prompt cache via stable <code className="text-xs">sessionId</code>. Usage reports{" "}
                <code className="text-xs">cachedContentTokenCount</code>. Configure MITM mappings on the{" "}
                <Link href="/dashboard/mitm" className="text-primary underline">MITM Proxy</Link> page.
              </p>
            </Card>
            <Card>
              <h3 className="font-semibold mb-2 flex items-center gap-2">
                <span className="material-symbols-outlined text-primary text-[20px]">shield</span>
                Safety rules
              </h3>
              <ul className="text-sm text-text-muted list-disc pl-4 space-y-1">
                <li>Compression failures never block requests</li>
                <li>Passthrough traffic is not compressed unless explicitly enabled</li>
                <li>Stats write failures are logged and ignored</li>
              </ul>
            </Card>
          </div>

          <Card>
            <p className="text-sm text-text-muted">
              Per-request cache token breakdown is available in{" "}
              <Link href="/dashboard/usage?tab=details" className="text-primary underline">Usage → Details</Link>.
              Model rates: <Link href="/dashboard/pricing" className="text-primary underline">Pricing</Link>.
            </p>
          </Card>
        </div>
      )}

      {activeTab === "logs" && (
        <div className="flex flex-col gap-4">
          <Card>
            <h2 className="text-lg font-semibold mb-2">Usage request log (SQLite)</h2>
            <p className="text-sm text-text-muted mb-3">
              Live usage rows from the dashboard database. View formatted entries on the Usage page.
            </p>
            <Link href="/dashboard/usage?tab=logs">
              <Button size="sm" variant="secondary" icon="open_in_new">Open Usage → Logs</Button>
            </Link>
          </Card>

          <Card>
            <div className="flex items-center justify-between gap-3 mb-3">
              <div>
                <h2 className="text-lg font-semibold">File request logs</h2>
                <p className="text-sm text-text-muted">
                  Raw translator dumps when <code className="text-xs">ENABLE_REQUEST_LOGS=true</code>
                  {enableRequestLogs ? " (enabled)" : " (disabled — set env var and restart)"}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Toggle checked={logsFailedOnly} onChange={setLogsFailedOnly} />
                <span className="text-xs text-text-muted whitespace-nowrap">Failed only</span>
                <Button size="sm" variant="ghost" icon="refresh" onClick={fetchFileLogSessions}>Refresh</Button>
              </div>
            </div>
            {visibleFileLogSessions.length === 0 ? (
              <p className="text-sm text-text-muted">
                {fileLogSessions.length === 0
                  ? "No file log sessions found under ./logs"
                  : "No sessions match the current filter"}
              </p>
            ) : (
              <div className="overflow-x-auto max-h-96 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-text-muted">
                      <th className="px-3 py-2">Session folder</th>
                      <th className="px-3 py-2">Modified</th>
                      <th className="px-3 py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleFileLogSessions.map((s) => (
                      <tr
                        key={s.name}
                        className="border-b border-border/50 hover:bg-surface-2 cursor-pointer"
                        onClick={() => setSelectedLogSession(s.name)}
                      >
                        <td className="px-3 py-2 font-mono text-xs truncate max-w-md">{s.name}</td>
                        <td className="px-3 py-2 text-xs whitespace-nowrap">
                          {s.mtime ? new Date(s.mtime).toLocaleString() : "—"}
                        </td>
                        <td className="px-3 py-2">
                          <Badge variant={s.hasError ? "error" : "success"} size="sm">
                            {s.hasError ? "failed" : "ok"}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <RequestLogSessionModal
            sessionName={selectedLogSession}
            onClose={() => setSelectedLogSession(null)}
          />
        </div>
      )}
    </div>
  );
}
