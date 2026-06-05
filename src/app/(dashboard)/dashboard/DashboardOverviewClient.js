"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, Button } from "@/shared/components";
import { useDashboardSecurity } from "@/shared/hooks/useDashboardSecurity";
import { SECURITY_COPY } from "@/shared/constants/securityCopy";
import InlineAlert from "@/shared/components/InlineAlert";
import { CLI_TOOLS } from "@/shared/constants/cliTools";
import { getToolInstallStatus } from "@/shared/components/ConfigStatusBadge";

const QUICK_LINKS = [
  { href: "/dashboard/endpoint", label: "Endpoint", icon: "api", desc: "URLs, tunnel, API keys" },
  { href: "/dashboard/providers", label: "Providers", icon: "dns", desc: "Connect AI accounts" },
  { href: "/dashboard/cli-tools", label: "CLI Tools", icon: "terminal", desc: "Point local tools here" },
  { href: "/dashboard/profile", label: "Security", icon: "shield", desc: "Password and login" },
];

export default function DashboardOverviewClient() {
  const security = useDashboardSecurity();
  const [providerCount, setProviderCount] = useState(null);
  const [cliStats, setCliStats] = useState({ configured: 0, total: 0 });
  const [version, setVersion] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [providersRes, cliRes, versionRes] = await Promise.all([
          fetch("/api/providers"),
          fetch("/api/cli-tools/all-statuses"),
          fetch("/api/version"),
        ]);
        if (cancelled) return;
        if (providersRes.ok) {
          const data = await providersRes.json();
          setProviderCount((data.connections || []).length);
        }
        if (cliRes.ok) {
          const statuses = await cliRes.json();
          const toolIds = Object.keys(CLI_TOOLS);
          let configured = 0;
          for (const id of toolIds) {
            if (getToolInstallStatus(statuses[id]).status === "configured") configured++;
          }
          setCliStats({ configured, total: toolIds.length });
        }
        if (versionRes.ok) {
          const v = await versionRes.json();
          setVersion(v.version || "");
        }
      } catch {
        /* ignore */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const securityIssues = [];
  if (!security.loading && !security.hasPassword) {
    securityIssues.push({ key: "pw", message: SECURITY_COPY.defaultPassword });
  }
  if (!security.loading && !security.requireLogin) {
    securityIssues.push({ key: "login", message: SECURITY_COPY.requireLoginOff });
  }
  if (!security.loading && security.remoteExposureActive && !security.requireApiKey) {
    securityIssues.push({ key: "api", message: SECURITY_COPY.requireApiKeyOff });
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text-main">Overview</h1>
          <p className="text-sm text-text-muted mt-0.5">
            Start here: secure the dashboard, add providers, then share your endpoint.
          </p>
        </div>
        {version ? (
          <span className="text-xs text-text-muted font-mono">v{version}</span>
        ) : null}
      </div>

      {securityIssues.length > 0 ? (
        <div className="flex flex-col gap-2">
          {securityIssues.map((issue) => (
            <InlineAlert
              key={issue.key}
              variant="warning"
              message={issue.message}
              action={{ label: "Fix in Profile", href: "/dashboard/profile" }}
              compact
            />
          ))}
        </div>
      ) : (
        <InlineAlert variant="info" compact message="Security basics look good. You can enable tunnels and share your endpoint when ready." />
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Card padding="sm">
          <p className="text-xs text-text-muted">Providers</p>
          <p className="text-2xl font-semibold mt-1">{providerCount ?? "—"}</p>
          <Link href="/dashboard/providers" className="text-xs text-primary mt-2 inline-block hover:underline">
            Manage providers
          </Link>
        </Card>
        <Card padding="sm">
          <p className="text-xs text-text-muted">CLI tools configured</p>
          <p className="text-2xl font-semibold mt-1">
            {cliStats.total ? `${cliStats.configured}/${cliStats.total}` : "—"}
          </p>
          <Link href="/dashboard/cli-tools" className="text-xs text-primary mt-2 inline-block hover:underline">
            Configure tools
          </Link>
        </Card>
        <Card padding="sm">
          <p className="text-xs text-text-muted">Remote access</p>
          <p className="text-2xl font-semibold mt-1">
            {security.tunnelEnabled || security.tailscaleEnabled ? "On" : "Off"}
          </p>
          <Link href="/dashboard/endpoint" className="text-xs text-primary mt-2 inline-block hover:underline">
            Endpoint settings
          </Link>
        </Card>
      </div>

      <div>
        <h2 className="text-sm font-semibold text-text-main mb-3">Quick links</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {QUICK_LINKS.map((link) => (
            <Link key={link.href} href={link.href}>
              <Card padding="sm" className="h-full hover:border-primary/40 transition-colors">
                <div className="flex items-start gap-3">
                  <span className="material-symbols-outlined text-primary text-[20px]">{link.icon}</span>
                  <div>
                    <p className="text-sm font-medium">{link.label}</p>
                    <p className="text-xs text-text-muted mt-0.5">{link.desc}</p>
                  </div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      </div>

      <Card padding="sm" className="bg-primary/5 border-primary/20">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium">Ready to connect a coding tool?</p>
            <p className="text-xs text-text-muted mt-0.5">Copy your endpoint URL and API key from the Endpoint page.</p>
          </div>
          <Link href="/dashboard/endpoint">
            <Button variant="primary" size="sm">Open Endpoint</Button>
          </Link>
        </div>
      </Card>
    </div>
  );
}
