import https from "https";
import pkg from "../../../../package.json" with { type: "json" };

const NPM_PACKAGE_NAME = "9router";

// Fetch latest version from npm registry
function fetchLatestVersion() {
  return new Promise((resolve) => {
    const req = https.get(
      `https://registry.npmjs.org/${NPM_PACKAGE_NAME}/latest`,
      { timeout: 4000 },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data).version || null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

function compareVersions(a, b) {
  // Strip any pre-release/build suffix (e.g. "0.4.66-beta.1") and coerce each
  // numeric segment, defaulting missing/non-numeric parts to 0 so versions with
  // differing segment counts still compare correctly.
  const parse = (v) =>
    String(v)
      .split("-")[0]
      .split(".")
      .map((n) => {
        const num = parseInt(n, 10);
        return Number.isFinite(num) ? num : 0;
      });
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

export async function GET() {
  const latestVersion = await fetchLatestVersion();
  const currentVersion = pkg.version;
  const hasUpdate = latestVersion ? compareVersions(latestVersion, currentVersion) > 0 : false;

  return Response.json({ currentVersion, latestVersion, hasUpdate });
}
