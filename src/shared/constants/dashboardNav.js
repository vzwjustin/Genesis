/** Shared dashboard navigation for Sidebar, command palette, and page headers. */

const navItem = (href, label, description, icon, keywords) => ({
  href,
  label,
  description,
  icon,
  keywords,
});

export const DASHBOARD_NAV_SECTIONS = [
  {
    id: "get-started",
    label: "Get started",
    items: [
      navItem("/dashboard", "Overview", "Status, checklist, and where to go next", "home", "home start dashboard"),
      navItem("/dashboard/endpoint", "Endpoint", "Local, tunnel, and cloud API URLs", "api", "api url tunnel cloud base"),
      navItem("/dashboard/api-keys", "API Keys", "Create keys for apps and CLI tools", "vpn_key", "api key token auth secret"),
      navItem("/dashboard/providers", "Providers", "Connect AI accounts and pick models", "dns", "connections oauth models anthropic openai"),
      navItem("/dashboard/cli-tools", "CLI Tools", "Point Claude Code, Cursor, and Codex here", "terminal", "claude codex cursor setup install"),
      navItem("/dashboard/basic-chat", "Basic Chat", "Send a test message through the proxy", "chat", "chat test try model"),
    ],
  },
  {
    id: "routing",
    label: "Routing",
    items: [
      navItem("/dashboard/combos", "Combos", "Ordered failover across models", "layers", "failover chains combo"),
      navItem("/dashboard/caching", "Caching", "Compress prompts and track token savings", "cached", "rtk compression token saver logs headroom"),
      navItem("/dashboard/mitm", "MITM Proxy", "Intercept IDE traffic and route through Genesis", "security", "antigravity copilot kiro cursor intercept"),
    ],
  },
  {
    id: "monitor",
    label: "Monitor",
    items: [
      navItem("/dashboard/usage", "Usage", "Request history, tokens, and spend", "bar_chart", "stats tokens spend analytics"),
      navItem("/dashboard/quota", "Quota Tracker", "Watch provider limits before they fail", "data_usage", "limits quota rate"),
    ],
  },
];

export const DASHBOARD_NAV_DEBUG_ITEMS = [
  navItem("/dashboard/console-log", "Console Log", "Live server console output", "article", "debug logs server"),
  navItem("/dashboard/translator", "Translator", "Debug request translation between formats", "translate", "debug translation passthrough"),
];

export const DASHBOARD_NAV_SYSTEM_ITEMS = [
  navItem("/dashboard/proxy-pools", "Proxy Pools", "Group outbound proxies for connections", "lan", "proxy relay socks"),
  navItem("/dashboard/pricing", "Pricing", "Reference rates for cost estimates", "payments", "cost rates price"),
  navItem("/dashboard/skills", "Skills", "Share capability links with AI agents", "extension", "agent capabilities mcp"),
];

export const DASHBOARD_NAV_SETTINGS = navItem(
  "/dashboard/profile",
  "Settings",
  "Password, security, and UI preferences",
  "settings",
  "password oidc proxy observability profile",
);

/** Flat list for command palette search (includes settings; profile label matches sidebar). */
export const DASHBOARD_NAV_ITEMS = [
  ...DASHBOARD_NAV_SECTIONS.flatMap((section) => section.items),
  ...DASHBOARD_NAV_DEBUG_ITEMS,
  ...DASHBOARD_NAV_SYSTEM_ITEMS,
  DASHBOARD_NAV_SETTINGS,
];

/** Lookup page title/description for header chrome. */
export function getDashboardNavPageMeta(pathname) {
  if (!pathname) return null;
  const item = DASHBOARD_NAV_ITEMS.find((entry) => {
    if (entry.href === "/dashboard") return pathname === "/dashboard";
    return pathname === entry.href || pathname.startsWith(`${entry.href}/`);
  });
  if (!item) return null;
  return { title: item.label, description: item.description, icon: item.icon };
}
