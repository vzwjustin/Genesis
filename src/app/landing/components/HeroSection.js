"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function HeroSection() {
  const router = useRouter();
  const [version, setVersion] = useState("");

  useEffect(() => {
    fetch("/api/version")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (data?.version) setVersion(data.version); })
      .catch(() => {});
  }, []);

  const scrollToGetStarted = () => {
    const el = document.getElementById("get-started");
    if (el) el.scrollIntoView({ behavior: "smooth" });
    else router.push("/dashboard");
  };

  return (
    <section className="relative pt-32 pb-20 px-6 min-h-[90vh] flex flex-col items-center justify-center overflow-hidden">
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[1000px] h-[500px] bg-[#C9A84C]/10 rounded-full blur-[120px] pointer-events-none" />

      <div className="relative z-10 max-w-4xl w-full text-center flex flex-col items-center gap-8">
        <div className="inline-flex items-center gap-2 rounded-full landing-glass-card px-3 py-1 text-xs font-medium text-[#C9A84C]">
          <span className="flex h-2 w-2 rounded-full bg-[#C9A84C] animate-pulse" />
          {version ? `v${version} — open source` : "Open source AI router"}
        </div>

        <h1 className="text-5xl md:text-7xl font-black leading-[1.1] tracking-tight">
          One Endpoint for <br />
          <span className="text-[#C9A84C]">All AI Providers</span>
        </h1>

        <p className="text-lg md:text-xl text-gray-400 max-w-2xl mx-auto font-light">
          Route Claude Code, Codex, Cline, and other CLI tools through one local proxy with a security-first dashboard.
        </p>

        <p className="text-sm text-amber-400/90 max-w-xl">
          Change the default password in Profile before enabling tunnels or sharing your dashboard remotely.
        </p>

        <div className="flex flex-wrap items-center justify-center gap-4 w-full">
          <button
            type="button"
            onClick={scrollToGetStarted}
            className="h-12 px-8 rounded-lg bg-[#C9A84C] hover:bg-[#B8943F] text-[#0B0D14] text-base font-bold transition-all shadow-[0_0_15px_rgba(201,168,76,0.4)] flex items-center gap-2"
          >
            <span className="material-symbols-outlined">rocket_launch</span>
            Get Started
          </button>
          <button
            type="button"
            onClick={() => router.push("/dashboard")}
            className="h-12 px-8 rounded-lg border border-white/15 bg-white/5 backdrop-blur-md hover:bg-white/10 text-white text-base font-bold transition-all flex items-center gap-2"
          >
            <span className="material-symbols-outlined">dashboard</span>
            Open Dashboard
          </button>
          <a
            href="https://github.com/decolua/genesis"
            target="_blank"
            rel="noopener noreferrer"
            className="h-12 px-8 rounded-lg border border-white/15 bg-white/5 backdrop-blur-md hover:bg-white/10 text-white text-base font-bold transition-all flex items-center gap-2"
          >
            <span className="material-symbols-outlined">code</span>
            View on GitHub
          </a>
        </div>
      </div>
    </section>
  );
}
