"use client";

export default function Footer() {
  return (
    <footer className="border-t border-white/10 liquid-glass-nav pt-16 pb-8 px-6">
      <div className="max-w-7xl mx-auto">
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-8 mb-16">
          {/* Brand */}
          <div className="col-span-2 lg:col-span-2">
            <div className="flex items-center gap-3 mb-6">
              <div className="size-6 rounded bg-linear-to-br from-[#C9A84C] to-[#6B5CE7] flex items-center justify-center text-[#0B0D14]">
                <span className="material-symbols-outlined text-[16px]">auto_awesome</span>
              </div>
              <h3 className="text-white text-lg font-bold">Genesis</h3>
            </div>
            <p className="text-gray-500 text-sm max-w-xs mb-6">
              The unified endpoint for AI generation. Connect, route, and manage your AI providers with ease.
            </p>
            <div className="flex gap-4">
              <a className="text-gray-400 hover:text-white transition-colors" href="https://github.com/decolua/genesis" target="_blank" rel="noopener noreferrer">
                <span className="material-symbols-outlined">code</span>
              </a>
            </div>
          </div>
          
          {/* Product */}
          <div className="flex flex-col gap-4">
            <h4 className="font-bold text-white">Product</h4>
            <a className="text-gray-400 hover:text-[#C9A84C] text-sm transition-colors" href="#features">Features</a>
            <a className="text-gray-400 hover:text-[#C9A84C] text-sm transition-colors" href="/dashboard">Dashboard</a>
            <a className="text-gray-400 hover:text-[#C9A84C] text-sm transition-colors" href="https://github.com/decolua/genesis" target="_blank" rel="noopener noreferrer">Changelog</a>
          </div>
          
          {/* Resources */}
          <div className="flex flex-col gap-4">
            <h4 className="font-bold text-white">Resources</h4>
            <a className="text-gray-400 hover:text-[#C9A84C] text-sm transition-colors" href="https://github.com/decolua/genesis#readme" target="_blank" rel="noopener noreferrer">Documentation</a>
            <a className="text-gray-400 hover:text-[#C9A84C] text-sm transition-colors" href="https://github.com/decolua/genesis" target="_blank" rel="noopener noreferrer">GitHub</a>
            <a className="text-gray-400 hover:text-[#C9A84C] text-sm transition-colors" href="https://www.npmjs.com/package/genesis" target="_blank" rel="noopener noreferrer">NPM</a>
          </div>
          
          {/* Legal */}
          <div className="flex flex-col gap-4">
            <h4 className="font-bold text-white">Legal</h4>
            <a className="text-gray-400 hover:text-[#C9A84C] text-sm transition-colors" href="https://github.com/decolua/genesis/blob/main/LICENSE" target="_blank" rel="noopener noreferrer">MIT License</a>
          </div>
        </div>
        
        {/* Bottom */}
        <div className="border-t border-white/10 pt-8 flex flex-col md:flex-row justify-between items-center gap-4">
          <p className="text-gray-600 text-sm">© 2025 Genesis. All rights reserved.</p>
          <div className="flex gap-6">
            <a className="text-gray-600 hover:text-white text-sm transition-colors" href="https://github.com/decolua/genesis" target="_blank" rel="noopener noreferrer">GitHub</a>
            <a className="text-gray-600 hover:text-white text-sm transition-colors" href="https://www.npmjs.com/package/genesis" target="_blank" rel="noopener noreferrer">NPM</a>
          </div>
        </div>
      </div>
    </footer>
  );
}

