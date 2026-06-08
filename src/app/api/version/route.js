import pkg from "../../../../package.json" with { type: "json" };
import { GITHUB_CONFIG } from "@/shared/constants/config";

function normalizeVersion(tagName) {
  const version = String(tagName || "").trim().replace(/^v/i, "");
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ? version : null;
}

async function fetchLatestReleaseVersion() {
  try {
    const response = await fetch(GITHUB_CONFIG.releasesApiUrl, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "9Router",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return null;

    const releases = await response.json();
    for (const release of releases) {
      if (release?.draft) continue;
      const version = normalizeVersion(release.tag_name);
      if (version) return version;
    }
    return null;
  } catch {
    return null;
  }
}

function compareVersions(a, b) {
  // Split into numeric core segments and an optional pre-release tag
  // (e.g. "0.4.66-beta.1" -> { parts: [0,4,66], pre: "beta.1" }). Missing or
  // non-numeric segments default to 0 so versions with differing segment counts
  // still compare correctly.
  const parse = (v) => {
    const [main, pre] = String(v).split("-");
    const parts = main.split(".").map((n) => {
      const num = parseInt(n, 10);
      return Number.isFinite(num) ? num : 0;
    });
    return { parts, pre };
  };

  const pa = parse(a);
  const pb = parse(b);

  const maxLen = Math.max(pa.parts.length, pb.parts.length);
  for (let i = 0; i < maxLen; i++) {
    const x = pa.parts[i] || 0;
    const y = pb.parts[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }

  // Equal numeric cores: a stable release outranks a pre-release of the same
  // core (semver: 0.4.66 > 0.4.66-beta).
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && pb.pre) {
    if (pa.pre > pb.pre) return 1;
    if (pa.pre < pb.pre) return -1;
  }

  return 0;
}

export async function GET() {
  const latestVersion = await fetchLatestReleaseVersion();
  const currentVersion = pkg.version;
  const hasUpdate = latestVersion ? compareVersions(latestVersion, currentVersion) > 0 : false;

  return Response.json({ currentVersion, latestVersion, hasUpdate });
}
