/**
 * Runs once per Next.js server instance — before requests are accepted.
 * Layout import also calls bootstrap, but API-only traffic never loads layout.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "edge") return;
  await import("@/shared/services/bootstrap.js");
}
