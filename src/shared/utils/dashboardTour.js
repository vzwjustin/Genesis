export const DASHBOARD_TOUR_COMPLETE_KEY = "genesis-dashboard-tour-complete";
export const DASHBOARD_TOUR_SNOOZE_KEY = "genesis-dashboard-tour-snooze-until";
export const DASHBOARD_TOUR_SNOOZE_MS = 24 * 60 * 60 * 1000;
export const DASHBOARD_TOUR_OPEN_EVENT = "genesis-dashboard-tour-open";

export function isDashboardTourComplete() {
  if (typeof window === "undefined") return true;
  try {
    return localStorage.getItem(DASHBOARD_TOUR_COMPLETE_KEY) === "1";
  } catch {
    return true;
  }
}

export function isDashboardTourSnoozed() {
  if (typeof window === "undefined") return false;
  try {
    const until = Number(localStorage.getItem(DASHBOARD_TOUR_SNOOZE_KEY) || 0);
    return until > Date.now();
  } catch {
    return false;
  }
}

export function completeDashboardTour() {
  try {
    localStorage.setItem(DASHBOARD_TOUR_COMPLETE_KEY, "1");
    localStorage.removeItem(DASHBOARD_TOUR_SNOOZE_KEY);
  } catch {
    /* ignore */
  }
}

export function snoozeDashboardTour() {
  try {
    localStorage.setItem(DASHBOARD_TOUR_SNOOZE_KEY, String(Date.now() + DASHBOARD_TOUR_SNOOZE_MS));
  } catch {
    /* ignore */
  }
}

export function resetDashboardTour() {
  try {
    localStorage.removeItem(DASHBOARD_TOUR_COMPLETE_KEY);
    localStorage.removeItem(DASHBOARD_TOUR_SNOOZE_KEY);
  } catch {
    /* ignore */
  }
}

export function openDashboardTour() {
  resetDashboardTour();
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(DASHBOARD_TOUR_OPEN_EVENT));
  }
}

export const DASHBOARD_TOUR_STEPS = [
  {
    icon: "hub",
    title: "Genesis is your local AI gateway",
    body: "It sits between coding tools (Claude Code, Cursor, Codex) and upstream providers (Anthropic, OpenAI, custom endpoints). One local URL handles routing, failover, and compression.",
  },
  {
    icon: "dns",
    title: "Step 1: Connect providers",
    body: "Add at least one provider under Providers. OAuth and API key connections live there. Without a provider, nothing can be routed upstream.",
    href: "/dashboard/providers",
    action: "Open Providers",
  },
  {
    icon: "api",
    title: "Step 2: Copy your endpoint",
    body: "Endpoint shows the base URL and API key settings your tools should use. Enable “Require API key” before exposing tunnels or sharing access.",
    href: "/dashboard/endpoint",
    action: "Open Endpoint",
  },
  {
    icon: "menu",
    title: "Find anything quickly",
    body: "The sidebar is grouped by task: Get started, Routing, Monitor, and Advanced. Press ⌘K or Ctrl+K to jump to any page with a short description.",
  },
];
