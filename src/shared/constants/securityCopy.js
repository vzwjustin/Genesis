/** Shared security copy for dashboard UI — keep wording consistent across pages. */

export const SECURITY_COPY = {
  requireLoginHelp:
    "When ON, you must enter a password to open the dashboard. When OFF, the dashboard opens without a login on this machine. Either way, management APIs still need a session and the AI (LLM) endpoints still use API keys.",

  requireApiKeyHelp:
    "When ON, all /v1 and /api/v1 routes require a valid API key. Recommended before exposing a tunnel or Tailscale URL.",

  requireLoginOff:
    "Dashboard pages are open without login on this machine. Management APIs are available from loopback without a session; remote access still requires login.",

  defaultPassword:
    "No custom password is set. The default password (123456) is active until you set one in Profile.",

  preEnableLoginOff:
    "Require login is off — the dashboard UI will be open to anyone who can reach your tunnel URL. Enable login and set a password first.",

  preEnableDefaultPassword:
    "The dashboard still uses the default password (123456). Set a custom password in Profile before exposing a tunnel.",

  tunnelLoginOff:
    "Require login is off — tunnel visitors can open dashboard pages without signing in. Management APIs still require a session; LLM routes use API keys.",

  tunnelDefaultPassword:
    "Dashboard still uses the default password (123456) — change it in Profile before sharing your tunnel URL.",

  requireApiKeyOff:
    "Require API key is disabled — your LLM endpoint is publicly accessible without authentication.",

  tunnelDashboardAccessHelp:
    "When enabled, the dashboard can be opened through your tunnel or Tailscale URL — a login is still required if \"Require login\" is ON. When disabled, the dashboard can only be opened on this machine.",

  loginDefaultPassword:
    "First-time setup uses the default password (123456). Change it in Profile → Security after signing in.",

  apiKeysMasked:
    "Keys are masked in the list. Use Show to reveal briefly, or copy right after creating a new key.",
};
