"use client";

import PropTypes from "prop-types";
import ThemeToggle from "../ThemeToggle";

export default function AuthLayout({ children }) {
  return (
    <div className="min-h-screen flex flex-col relative dashboard-main-shell transition-colors duration-500 overflow-x-hidden selection:bg-primary/20 selection:text-primary">
      <div className="landing-grid absolute inset-0 pointer-events-none opacity-50 dark:opacity-100" aria-hidden="true" />
      {/* Soft ambient glow — toned down vs prior auth shell */}
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[560px] h-[560px] bg-primary/[0.025] dark:bg-primary/[0.06] rounded-full blur-[128px] pointer-events-none z-0" />
      <div className="fixed bottom-0 right-0 w-[440px] h-[440px] bg-orange-200/12 dark:bg-orange-900/8 rounded-full blur-[140px] pointer-events-none z-0 translate-y-1/3 translate-x-1/3" />

      {/* Theme toggle */}
      <div className="absolute top-6 right-6 z-20">
        <ThemeToggle variant="card" />
      </div>

      {/* Content */}
      <main className="flex-1 flex flex-col items-center justify-center p-4 sm:p-6 z-10 w-full h-full">
        {children}
      </main>
    </div>
  );
}

AuthLayout.propTypes = {
  children: PropTypes.node.isRequired,
};

