"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { useNotificationStore } from "@/store/notificationStore";
import Sidebar from "../Sidebar";
import Header from "../Header";
import ConfirmDialogHost from "../ConfirmDialogHost";
import DashboardSecurityBanner from "../DashboardSecurityBanner";
import FirstRunSecurityWizard from "../FirstRunSecurityWizard";
import CommandPalette from "../CommandPalette";

function getToastStyle(type) {
  if (type === "success") {
    return {
      wrapper: "border-success/30 bg-success/10 text-success",
      icon: "check_circle",
    };
  }
  if (type === "error") {
    return {
      wrapper: "border-danger/30 bg-danger/10 text-danger",
      icon: "error",
    };
  }
  if (type === "warning") {
    return {
      wrapper: "border-warning/30 bg-warning/10 text-warning",
      icon: "warning",
    };
  }
  return {
    wrapper: "border-info/30 bg-info/10 text-info",
    icon: "info",
  };
}

export default function DashboardLayout({ children }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const pathname = usePathname();
  const notifications = useNotificationStore((state) => state.notifications);
  const removeNotification = useNotificationStore((state) => state.removeNotification);
  const clearAll = useNotificationStore((state) => state.clearAll);

  return (
    <div className="flex h-screen w-full overflow-hidden">
      <ConfirmDialogHost />
      <CommandPalette />
      <div className="fixed bottom-4 right-4 z-[80] flex w-[min(92vw,380px)] flex-col gap-2 sm:top-4 sm:bottom-auto">
        {notifications.length > 1 && (
          <button
            type="button"
            onClick={clearAll}
            className="glass-stat self-end rounded-md border-0 px-2 py-1 text-[11px] text-text-muted dashboard-row-hover transition-colors hover:text-text-main"
          >
            Dismiss all
          </button>
        )}
        {notifications.map((n) => {
          const style = getToastStyle(n.type);
          return (
            <div
              key={n.id}
              className={`rounded-lg border px-3 py-2 shadow-lg backdrop-blur-sm ${style.wrapper}`}
            >
              <div className="flex items-start gap-2">
                <span className="material-symbols-outlined text-[18px] leading-5">{style.icon}</span>
                <div className="min-w-0 flex-1">
                  {n.title ? <p className="text-xs font-semibold mb-0.5">{n.title}</p> : null}
                  <p className="text-xs whitespace-pre-wrap break-words">{n.message}</p>
                  {n.action?.label ? (
                    <button
                      type="button"
                      onClick={() => {
                        n.action.onClick?.();
                        removeNotification(n.id);
                      }}
                      className="mt-2 text-xs font-semibold underline hover:opacity-80"
                    >
                      {n.action.label}
                    </button>
                  ) : null}
                </div>
                {n.dismissible ? (
                  <button
                    type="button"
                    onClick={() => removeNotification(n.id)}
                    className="text-current/70 hover:text-current"
                    aria-label="Dismiss notification"
                  >
                    <span className="material-symbols-outlined text-[16px]">close</span>
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/20 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar - Desktop */}
      <div className="hidden lg:flex">
        <Sidebar />
      </div>

      {/* Sidebar - Mobile */}
      <div
        className={`fixed inset-y-0 left-0 z-50 transform lg:hidden transition-transform duration-300 ease-in-out ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <Sidebar onClose={() => setSidebarOpen(false)} />
      </div>

      {/* Main content */}
      <main className="dashboard-main-shell flex flex-col flex-1 h-full min-w-0 relative transition-colors duration-300 isolate dashboard-shell-bg">
        <Header onMenuClick={() => setSidebarOpen(true)} />
        <div className={`flex-1 overflow-y-auto custom-scrollbar ${pathname.startsWith("/dashboard/basic-chat") ? "" : "p-6 lg:px-10 lg:py-8"} ${pathname.startsWith("/dashboard/basic-chat") ? "flex flex-col overflow-hidden" : ""}`}>
          <div className={`${pathname.startsWith("/dashboard/basic-chat") ? "flex-1 w-full h-full flex flex-col" : "max-w-7xl mx-auto"}`}>
            {!pathname.startsWith("/dashboard/basic-chat") ? (
              <>
                <FirstRunSecurityWizard />
                <DashboardSecurityBanner />
              </>
            ) : null}
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
