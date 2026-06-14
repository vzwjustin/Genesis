"use client";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

export default function GetStarted() {
  const { copied, copy } = useCopyToClipboard();

  const handleCopy = (text) => {
    copy(text, "landing");
  };

  return (
    <section id="get-started" className="py-24 px-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-col lg:flex-row gap-16 items-start">
          {/* Left: Steps */}
          <div className="flex-1">
            <h2 className="text-3xl md:text-4xl font-bold mb-6">Get Started in 30 Seconds</h2>
            <p className="text-gray-400 text-lg mb-8">
              Install Genesis, configure your providers via web dashboard, and start routing AI requests.
            </p>
            
            <div className="flex flex-col gap-6">
              <div className="flex gap-4">
                <div className="flex-none w-8 h-8 rounded-full bg-[#C9A84C]/20 text-[#C9A84C] flex items-center justify-center font-bold">1</div>
                <div>
                  <h4 className="font-bold text-lg">Install Genesis</h4>
                  <p className="text-sm text-gray-500 mt-1">Run npx command to start the server instantly</p>
                </div>
              </div>
              
              <div className="flex gap-4">
                <div className="flex-none w-8 h-8 rounded-full bg-[#C9A84C]/20 text-[#C9A84C] flex items-center justify-center font-bold">2</div>
                <div>
                  <h4 className="font-bold text-lg">Open Dashboard</h4>
                  <p className="text-sm text-gray-500 mt-1">Configure providers and API keys via web interface</p>
                </div>
              </div>
              
              <div className="flex gap-4">
                <div className="flex-none w-8 h-8 rounded-full bg-[#C9A84C]/20 text-[#C9A84C] flex items-center justify-center font-bold">3</div>
                <div>
                  <h4 className="font-bold text-lg">Route Requests</h4>
                  <p className="text-sm text-gray-500 mt-1">Point your CLI tools to http://localhost:20128</p>
                </div>
              </div>

              <div className="flex gap-4">
                <div className="flex-none w-8 h-8 rounded-full bg-amber-500/20 text-amber-400 flex items-center justify-center font-bold">!</div>
                <div>
                  <h4 className="font-bold text-lg">Secure before you share</h4>
                  <p className="text-sm text-gray-500 mt-1">Change the default password in Profile before enabling tunnels or remote dashboard access.</p>
                </div>
              </div>
            </div>
          </div>

          {/* Right: Code block */}
          <div className="flex-1 w-full">
            <div className="rounded-xl overflow-hidden landing-glass-terminal shadow-2xl">
              {/* Terminal header */}
              <div className="flex items-center gap-2 px-4 py-3 landing-glass-terminal-header">
                <div className="w-3 h-3 rounded-full bg-red-500"></div>
                <div className="w-3 h-3 rounded-full bg-yellow-500"></div>
                <div className="w-3 h-3 rounded-full bg-green-500"></div>
                <div className="ml-2 text-xs text-gray-500 font-mono">terminal</div>
              </div>
              
              {/* Terminal content */}
              <div className="p-6 font-mono text-sm leading-relaxed overflow-x-auto">
                <div 
                  className="flex items-center gap-2 mb-4 group cursor-pointer"
                  onClick={() => handleCopy("npx genesis")}
                >
                  <span className="text-green-400">$</span>
                  <span className="text-white">npx genesis</span>
                  <span className="ml-auto text-gray-500 text-xs opacity-0 group-hover:opacity-100">
                    {copied === "landing" ? "✓ Copied" : "Copy"}
                  </span>
                </div>
                
                <div className="text-gray-400 mb-6">
                  <span className="text-[#C9A84C]">&gt;</span> Starting Genesis...<br/>
                  <span className="text-[#C9A84C]">&gt;</span> Server running on <span className="text-blue-400">http://localhost:20128</span><br/>
                  <span className="text-[#C9A84C]">&gt;</span> Dashboard: <span className="text-blue-400">http://localhost:20128/dashboard</span><br/>
                  <span className="text-green-400">&gt;</span> Ready to route! ✓
                </div>
                
                <div className="text-xs text-gray-500 mb-2 border-t border-gray-700 pt-4">
                  📝 Configure providers in dashboard or use environment variables
                </div>
                
                <div className="text-gray-400 text-xs">
                  <span className="text-purple-400">Data Location:</span><br/>
                  <span className="text-gray-500">  macOS/Linux:</span> ~/.genesis/db/data.sqlite<br/>
                  <span className="text-gray-500">  Windows:</span> %APPDATA%/genesis/db/data.sqlite
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

