"use client";

import { useState, useEffect, useCallback } from "react";
import Card from "./Card";

export default function RequestLogger() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const fetchLogs = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    try {
      const res = await fetch("/api/usage/request-logs");
      if (res.ok) {
        const data = await res.json();
        setLogs(data);
      }
    } catch (error) {
      console.error("Failed to fetch logs:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Run inside an async IIFE so the setState calls happen after an await
    // (avoids react-hooks/set-state-in-effect's synchronous-setState flag).
    (async () => { await fetchLogs(false); })();
  }, [fetchLogs]);

  useEffect(() => {
    let interval;
    if (autoRefresh) {
      interval = setInterval(() => {
        fetchLogs(false);
      }, 3000);
    }
    return () => clearInterval(interval);
  }, [autoRefresh, fetchLogs]);

  const filteredLogs = logs.filter((log) => {
    const parts = log.split(" | ");
    if (parts.length < 7) return false;
    const status = parts[6] || "";
    if (statusFilter === "failed" && !status.includes("FAILED")) return false;
    if (statusFilter === "ok" && !status.includes("OK")) return false;
    if (statusFilter === "pending" && !status.includes("PENDING")) return false;
    if (search.trim()) {
      const hay = log.toLowerCase();
      if (!hay.includes(search.trim().toLowerCase())) return false;
    }
    return true;
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">Request Logs</h2>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search model, provider, account…"
            className="px-3 py-1.5 text-xs rounded-lg border border-border bg-surface min-w-[200px]"
            aria-label="Search request logs"
          />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-2 py-1.5 text-xs rounded-lg border border-border bg-surface"
            aria-label="Filter by status"
          >
            <option value="all">All status</option>
            <option value="ok">OK</option>
            <option value="failed">Failed</option>
            <option value="pending">Pending</option>
          </select>
          <label className="text-sm font-medium text-text-muted flex items-center gap-2 cursor-pointer">
            <span>Auto Refresh (3s)</span>
            <div
              onClick={() => setAutoRefresh(!autoRefresh)}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${autoRefresh ? "bg-success" : "bg-surface-3"
                }`}
            >
              <span
                className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${autoRefresh ? "translate-x-5" : "translate-x-1"
                  }`}
              />
            </div>
          </label>
        </div>
      </div>

      <Card className="overflow-hidden">
        <div className="p-0 overflow-x-auto max-h-[600px] overflow-y-auto font-mono text-xs">
          {loading && logs.length === 0 ? (
            <div className="p-8 text-center text-text-muted">Loading logs...</div>
          ) : filteredLogs.length === 0 ? (
            <div className="p-8 text-center text-text-muted">
              {logs.length === 0 ? "No logs recorded yet." : "No logs match the current filter."}
            </div>
          ) : (
            <table className="w-full text-left border-collapse whitespace-nowrap">
              <thead className="sticky top-0 glass-stat border-0 border-b border-border z-10">
                <tr>
                  <th className="px-3 py-2 border-r border-border">DateTime</th>
                  <th className="px-3 py-2 border-r border-border">Model</th>
                  <th className="px-3 py-2 border-r border-border">Provider</th>
                  <th className="px-3 py-2 border-r border-border">Account</th>
                  <th className="px-3 py-2 border-r border-border">In</th>
                  <th className="px-3 py-2 border-r border-border">Out</th>
                  <th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {filteredLogs.map((log, i) => {
                  const parts = log.split(" | ");
                  if (parts.length < 7) return null;

                  const status = parts[6];
                  const isPending = status.includes("PENDING");
                  const isFailed = status.includes("FAILED");
                  const isSuccess = status.includes("OK");

                  return (
                    <tr key={i} className={`dashboard-row-hover transition-colors ${isPending ? "dashboard-filter-active" : ""}`}>
                      <td className="px-3 py-1.5 border-r border-border text-text-muted">{parts[0]}</td>
                      <td className="px-3 py-1.5 border-r border-border font-medium">{parts[1]}</td>
                      <td className="px-3 py-1.5 border-r border-border">
                        <span className="px-1.5 py-0.5 rounded glass-stat border-0 text-[10px] uppercase font-medium">
                          {parts[2]}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 border-r border-border truncate max-w-[150px]" title={parts[3]}>{parts[3]}</td>
                      <td className="px-3 py-1.5 border-r border-border text-right text-primary">{parts[4]}</td>
                      <td className="px-3 py-1.5 border-r border-border text-right text-success">{parts[5]}</td>
                      <td className={`px-3 py-1.5 font-bold ${isSuccess ? 'text-success' :
                          isFailed ? 'text-error' :
                            'text-primary animate-pulse'
                        }`}>
                        {status}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </Card>
      <div className="text-[10px] text-text-muted italic">
        Logs are loaded from the request history database.
      </div>
    </div>
  );
}
