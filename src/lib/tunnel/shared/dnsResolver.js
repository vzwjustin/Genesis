import dns from "dns";

// Force public DNS to bypass OS negative cache (mDNSResponder holds NXDOMAIN)
const resolver = new dns.promises.Resolver();
resolver.setServers(["1.1.1.1", "1.0.0.1", "8.8.8.8"]);

/** Host suffixes where public DNS may not resolve — allow OS resolver as last resort. */
const TUNNEL_DNS_SUFFIXES = [".ts.net", ".tailscale"];

// Try public DNS first; fall back to OS resolver only for known tunnel suffixes.
export async function resolveDns(hostname, timeoutMs) {
  const tryResolver = (fn) => Promise.race([
    fn(),
    new Promise((_, rej) => setTimeout(() => rej(new Error("dns timeout")), timeoutMs)),
  ]).then(() => true).catch(() => false);

  if (await tryResolver(() => resolver.resolve4(hostname))) return true;
  const allowSystemFallback = TUNNEL_DNS_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
  if (!allowSystemFallback) return false;
  return tryResolver(() => dns.promises.resolve4(hostname));
}
