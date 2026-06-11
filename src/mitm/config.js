// All intercepted domains + URL patterns per tool

const fs = require("fs");
const { TOOL_HOSTS, isKiroMitmHost } = require("../shared/constants/mitmToolHosts.js");

const IS_DEV = process.env.NODE_ENV === "development";

// Resolve lsof absolute path — packaged apps / sudo secure_path may strip /usr/sbin from PATH
const LSOF_BIN = (() => {
  if (process.platform === "win32") return null;
  for (const p of ["/usr/sbin/lsof", "/usr/bin/lsof", "/sbin/lsof"]) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* try next */ }
  }
  return "lsof"; // last-resort fallback (depends on PATH)
})();

const TARGET_HOSTS = Object.values(TOOL_HOSTS).flat();

const URL_PATTERNS = {
  antigravity: [":generateContent", ":streamGenerateContent"],
  copilot: ["/chat/completions", "/v1/messages", "/responses"],
  kiro: ["/generateAssistantResponse"],
  cursor: ["/aiserver.v1.ChatService/StreamUnifiedChatWithTools"],
};

// Synonym map: rawModel from request → canonical alias key in mitmAlias DB
const MODEL_SYNONYMS = {
  kiro: {
    "claude-sonnet-4-6": "claude-sonnet-4.6",
    "claude-sonnet-4-5": "claude-sonnet-4.6",
    "claude-haiku-4-5": "claude-haiku-4.5",
    "CLAUDE_SONNET_4_20250514_V1_0": "claude-sonnet-4.6",
    "qdev::CLAUDE_SONNET_4_20250514_V1_0": "claude-sonnet-4.6",
    "auto": "claude-sonnet-4.6",
    "qdev::auto": "claude-sonnet-4.6",
    "minimax-m2.1": "MiniMax-M2.5",
    "simple-task": "qwen3-coder-next",
  },
  cursor: {
    "default": "auto",
    "claude-sonnet-4-5": "claude-4.5-sonnet",
    "claude-sonnet-4.6": "claude-4.6-sonnet-medium",
    "claude-sonnet-4-6": "claude-4.6-sonnet-medium",
  },
  antigravity: {
    "gemini-default": "gemini-3.5-flash-low",
    "gemini-3.1-pro-high": "gemini-pro-agent",
    "gemini-3-pro-high": "gemini-pro-agent",
    "gemini-3-pro-low": "gemini-3.1-pro-low",
  },
};

// Pattern fallback: rawModel regex → canonical alias key (when exact + prefix match fail)
// Order matters: more specific patterns first. Catches AG renamed variants (e.g. gemini-pro-agent)
const MODEL_PATTERNS = {
  kiro: [
    { match: /CLAUDE_SONNET|claude-sonnet/i, alias: "claude-sonnet-4.6" },
    { match: /CLAUDE_HAIKU|claude-haiku/i, alias: "claude-haiku-4.5" },
    { match: /deepseek/i, alias: "deepseek-3.2" },
    { match: /minimax/i, alias: "MiniMax-M2.5" },
    { match: /qwen|simple.?task|coder.?next/i, alias: "qwen3-coder-next" },
  ],
  cursor: [
    { match: /composer/i, alias: "composer-2.5-fast" },
    { match: /opus.*4\.8|opus-4-8/i, alias: "claude-opus-4-8-high" },
    { match: /opus/i, alias: "claude-opus-4-8-high" },
    { match: /sonnet.*4\.6|sonnet-4-6/i, alias: "claude-4.6-sonnet-medium" },
    { match: /sonnet/i, alias: "claude-4.5-sonnet" },
    { match: /gpt-5\.5|gpt5\.5/i, alias: "gpt-5.5-medium" },
    { match: /gpt/i, alias: "gpt-5.4-medium" },
    { match: /^auto$/i, alias: "auto" },
  ],
  antigravity: [
    { match: /flash.*low|low.*flash|flash.*medium|medium.*flash/i, alias: "gemini-3.5-flash-low" },
    { match: /flash.*agent|agent.*flash|flash/i,                   alias: "gemini-3-flash-agent" },
    { match: /pro.*low|low.*pro/i,                                 alias: "gemini-3.1-pro-low" },
    { match: /gemini.*pro|pro.*gemini/i,                           alias: "gemini-pro-agent" },
    { match: /opus/i,                                              alias: "claude-opus-4-6-thinking" },
    { match: /sonnet|claude/i,                                     alias: "claude-sonnet-4-6" },
    { match: /gpt.*oss|oss/i,                                      alias: "gpt-oss-120b-medium" },
  ],
};

// URL substrings whose request/response should NOT be dumped to file (telemetry, polling, empty)
const LOG_BLACKLIST_URL_PARTS = [
  "recordCodeAssistMetrics",
  "recordTrajectoryAnalytics",
  "fetchAdminControls",
  "listExperiments",
  "fetchUserInfo",
];

function getToolForHost(host) {
  const h = (host || "").split(":")[0];
  if (h === "api.individual.githubcopilot.com") return "copilot";
  if (h === "daily-cloudcode-pa.googleapis.com" || h === "cloudcode-pa.googleapis.com") return "antigravity";
  if (isKiroMitmHost(h)) return "kiro";
  if (h === "api2.cursor.sh") return "cursor";
  return null;
}

module.exports = { IS_DEV, LSOF_BIN, TARGET_HOSTS, URL_PATTERNS, MODEL_SYNONYMS, MODEL_PATTERNS, LOG_BLACKLIST_URL_PARTS, getToolForHost };
