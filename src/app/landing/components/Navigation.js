"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function Navigation() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const router = useRouter();

  return (
    <nav className="liquid-glass-nav fixed top-0 z-50 w-full border-b border-[#2A2548]">
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        {/* Logo */}
        <button
          type="button"
          className="flex items-center gap-3 cursor-pointer bg-transparent border-none p-0"
          onClick={() => router.push("/")}
          aria-label="Navigate to home"
        >
          <div className="size-8 rounded bg-linear-to-br from-[#C9A84C] to-[#6B5CE7] flex items-center justify-center text-[#0B0D14]">
            <span className="material-symbols-outlined text-[20px]">auto_awesome</span>
          </div>
          <h2 className="text-white text-xl font-bold tracking-tight">Genesis</h2>
        </button>

        {/* Desktop menu */}
        <div className="hidden md:flex items-center gap-8">
          <a className="landing-nav-link" href="#features">Features</a>
          <a className="landing-nav-link" href="#how-it-works">How it Works</a>
          <a className="landing-nav-link" href="https://github.com/decolua/genesis#readme" target="_blank" rel="noopener noreferrer">Docs</a>
          <a className="landing-nav-link flex items-center gap-1" href="https://github.com/decolua/genesis" target="_blank" rel="noopener noreferrer">
            GitHub <span className="material-symbols-outlined text-[14px]">open_in_new</span>
          </a>
        </div>

        {/* CTA + Mobile menu */}
        <div className="flex items-center gap-4">
          <button 
            onClick={() => router.push("/dashboard")}
            className="hidden sm:flex h-9 items-center justify-center rounded-lg px-4 bg-[#C9A84C] hover:bg-[#B8943F] transition-all text-[#0B0D14] text-sm font-bold shadow-[0_0_15px_rgba(201,168,76,0.4)] hover:shadow-[0_0_20px_rgba(201,168,76,0.6)]"
          >
            Get Started
          </button>
          <button 
            className="md:hidden text-white"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          >
            <span className="material-symbols-outlined">{mobileMenuOpen ? "close" : "menu"}</span>
          </button>
        </div>
      </div>

      {/* Mobile menu dropdown */}
      {mobileMenuOpen && (
        <div className="md:hidden border-t border-[#2A2548] liquid-glass-nav-dropdown">
          <div className="flex flex-col gap-4 p-6">
            <a className="landing-nav-link" href="#features" onClick={() => setMobileMenuOpen(false)}>Features</a>
            <a className="landing-nav-link" href="#how-it-works" onClick={() => setMobileMenuOpen(false)}>How it Works</a>
            <a className="landing-nav-link" href="https://github.com/decolua/genesis#readme" target="_blank" rel="noopener noreferrer">Docs</a>
            <a className="landing-nav-link" href="https://github.com/decolua/genesis" target="_blank" rel="noopener noreferrer">GitHub</a>
            <button 
              onClick={() => router.push("/dashboard")}
              className="h-9 rounded-lg bg-[#C9A84C] hover:bg-[#B8943F] text-[#0B0D14] text-sm font-bold"
            >
              Get Started
            </button>
          </div>
        </div>
      )}
    </nav>
  );
}

