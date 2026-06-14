# Genesis - FREE AI Router & Token Saver

**Never stop coding. Save 20-40% tokens with RTK + auto-fallback to FREE & cheap AI models.**

**Connect All AI Code Tools (Claude Code, Cursor, Antigravity, Copilot, Codex, Gemini, OpenCode, Cline, OpenClaw...) to 40+ AI Providers & 100+ Models.**

[![npm](https://img.shields.io/npm/v/genesis.svg)](https://www.npmjs.com/package/genesis)
[![Downloads](https://img.shields.io/npm/dm/genesis.svg)](https://www.npmjs.com/package/genesis)
[![Docker Pulls](https://img.shields.io/docker/pulls/decolua/genesis.svg?logo=docker&label=Docker%20pulls)](https://hub.docker.com/r/decolua/genesis)
[![GHCR](https://img.shields.io/badge/GHCR-decolua%2Fgenesis-blue?logo=github)](https://github.com/decolua/genesis/pkgs/container/genesis)
[![License](https://img.shields.io/npm/l/genesis.svg)](https://github.com/decolua/genesis/blob/main/LICENSE)

<a href="https://trendshift.io/repositories/22628" target="_blank"><img src="https://trendshift.io/api/badge/repositories/22628" alt="decolua%2Fgenesis | Trendshift" style="width: 250px; height: 55px;" width="250" height="55"/></a>

[🌐 Website](https://genesis.com) • [📖 Full Docs](https://github.com/decolua/genesis)

---

## 🤔 Why Genesis?

**Stop wasting money, tokens and hitting limits:**

- ❌ Subscription quota expires unused every month
- ❌ Rate limits stop you mid-coding
- ❌ Tool outputs (git diff, grep, ls...) burn tokens fast
- ❌ Expensive APIs ($20-50/month per provider)

**Genesis solves this:**

- ✅ **RTK Token Saver** - Auto-compress tool_result, save 20-40% tokens
- ✅ **Maximize subscriptions** - Track quota, use every bit before reset
- ✅ **Auto fallback** - Subscription → Cheap → Free, zero downtime
- ✅ **Multi-account** - Round-robin between accounts per provider
- ✅ **Universal** - Works with any OpenAI/Claude-compatible CLI

---

## ⚡ Quick Start

**Option 1 — npm (recommended for desktop):**

```bash
npm install -g genesis
genesis

# Or run directly with npx
npx genesis
```

**Option 2 — Docker (server/VPS):**

```bash
docker run -d --name genesis -p 20128:20128 \
  -v "$HOME/.genesis:/app/data" -e DATA_DIR=/app/data \
  decolua/genesis:latest
```

Published images: [Docker Hub](https://hub.docker.com/r/decolua/genesis) • [GHCR](https://github.com/decolua/genesis/pkgs/container/genesis) (multi-platform amd64/arm64).

🎉 Dashboard opens at `http://localhost:20128`

**2. Connect a FREE provider (no signup needed):**

Dashboard → Providers → Connect **Kiro AI** (free Claude unlimited) or **OpenCode Free** (no auth) → Done!

**3. Use in your CLI tool:**

```
Claude Code/Codex/OpenClaw/Cursor/Cline Settings:
  Endpoint: http://localhost:20128/v1
  API Key:  [copy from dashboard]
  Model:    kr/claude-sonnet-4.5
```

That's it! Start coding with FREE AI models.

---

## 🚀 CLI Options

```bash
genesis                    # Start with default settings
genesis --port 8080        # Custom port
genesis --no-browser       # Don't open browser
genesis --skip-update      # Skip auto-update check
genesis --help             # Show all options
```

**Dashboard**: `http://localhost:20128/dashboard`

---

## 🛠️ Supported CLI Tools

Claude-Code • OpenClaw • Codex • OpenCode • Cursor • Antigravity • Cline • Continue • Droid • Roo • Copilot • Kilo Code • Gemini CLI • Qwen Code • iFlow • Crush • Crusher • Aider

Any tool supporting OpenAI/Claude-compatible API works.

---

## 💾 Data Location

- **macOS/Linux**: `~/.genesis/db/data.sqlite`
- **Windows**: `%APPDATA%/genesis/db/data.sqlite`
- **Docker**: `/app/data/db/data.sqlite` (mount `$HOME/.genesis` to persist)

---

## 📚 Documentation

Full docs, advanced setup, video tutorials & development guide:

- **GitHub**: https://github.com/decolua/genesis
- **Full README**: https://github.com/decolua/genesis/blob/main/app/README.md
- **Website**: https://genesis.com

---

## 🙏 Acknowledgments

- **[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)** - Original Go implementation

## 📄 License

MIT License - see [LICENSE](LICENSE) for details.
