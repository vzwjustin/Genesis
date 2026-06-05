import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const read = (path) => readFileSync(join(root, path), "utf8");

describe("frontend accessibility regressions", () => {
  it("exposes the request logs tab from the usage tab switcher", () => {
    const page = read("src/app/(dashboard)/dashboard/usage/page.js");

    expect(page).toMatch(/\{\s*value:\s*"logs",\s*label:\s*"Logs"\s*\}/);
  });

  it("marks sidebar navigation and accordion state for assistive tech", () => {
    const sidebar = read("src/shared/components/Sidebar.js");

    expect(sidebar).toContain('aria-hidden="true"');
    expect(sidebar).toContain('aria-current={isActive(item.href) ? "page" : undefined}');
    expect(sidebar).toContain("aria-expanded={mediaOpen}");
    expect(sidebar).toContain('aria-controls="sidebar-media-providers"');
    expect(sidebar).toContain('id="sidebar-media-providers"');
  });

  it("gives the dashboard menu button and popup menu semantics", () => {
    const menu = read("src/shared/components/HeaderMenu.js");

    expect(menu).toContain('aria-label="Open dashboard menu"');
    expect(menu).toContain('aria-haspopup="menu"');
    expect(menu).toContain("aria-expanded={isOpen}");
    expect(menu).toContain('role="menu"');
    expect(menu).toContain('role="menuitem"');
  });

  it("labels modal dialogs and page search", () => {
    const modal = read("src/shared/components/Modal.js");
    const header = read("src/shared/components/Header.js");

    expect(modal).toContain('role="dialog"');
    expect(modal).toContain('aria-modal="true"');
    expect(modal).toContain("aria-labelledby={title ? titleId : undefined}");
    expect(header).toContain('aria-label="Search current page"');
  });

  it("does not hide Material Symbols forever if font loading stalls", () => {
    const layout = read("src/app/layout.js");
    const css = read("src/app/globals.css");

    expect(layout).toContain("fonts-failed");
    expect(css).toContain(".fonts-failed .material-symbols-outlined");
  });

  it("marks provider quota controls with menu and icon-only button semantics", () => {
    const providerLimits = read("src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js");

    expect(providerLimits).toContain('role="menu"');
    expect(providerLimits).toContain('role="menuitemradio"');
    expect(providerLimits).toContain("aria-checked={providerFilter === provider}");
    expect(providerLimits).toContain('aria-label={autoRefresh ? "Disable auto-refresh" : "Enable auto-refresh"}');
    expect(providerLimits).toContain('aria-label="Refresh all quotas"');
  });

  it("offers release history upgrade and downgrade controls in the sidebar", () => {
    const sidebar = read("src/shared/components/Sidebar.js");

    expect(sidebar).toContain('fetch("/api/version/releases")');
    expect(sidebar).toContain("selectedReleaseVersion");
    expect(sidebar).toContain("Release history");
    expect(sidebar).toContain("Install & Restart");
    expect(sidebar).toContain('fetch("/api/version/update"');
  });

  it("shows compression stats in the token saver card", () => {
    const endpoint = read("src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js");

    expect(endpoint).toContain('fetch("/api/compression/stats")');
    expect(endpoint).toContain("CompressionStatRow");
    expect(endpoint).toContain("Saved");
    expect(endpoint).toContain("Est. tokens saved");
    expect(endpoint).toContain("Savings not measurable");
    expect(endpoint).toContain("Hits");
    expect(endpoint).toContain("Prompt injections");
  });

  it("marks Headroom as coming soon instead of enabling an offline proxy", () => {
    const endpoint = read("src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js");

    expect(endpoint).toContain("Coming soon");
    expect(endpoint).toContain("Headroom is coming soon");
    expect(endpoint).toContain("disabled");
  });
});
