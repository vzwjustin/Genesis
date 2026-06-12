/** Normalize CLI tool status API responses for dashboard cards. */

export async function fetchCliToolStatus(endpoint) {
  const res = await fetch(endpoint, { cache: "no-store", credentials: "same-origin" });
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }

  if (!res.ok) {
    return {
      installed: false,
      fetchFailed: true,
      error: data?.error || `HTTP ${res.status}`,
    };
  }

  return data;
}
