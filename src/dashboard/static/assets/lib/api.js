/*
 * Fetch wrappers for the dashboard's disk-read REST loaders. This is the
 * ONLY place that calls fetch() for JSON/text GETs — components import these
 * rather than calling fetch() directly, matching the existing app.js pattern
 * (design §3, §13: every view reads disk through the HTTP API; SSE is
 * notification-only and never a data source).
 */

export async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

export async function getText(url) {
  const r = await fetch(url);
  return r.ok ? r.text() : "";
}

/**
 * POST a JSON body, returning the parsed JSON response. Throws on a non-2xx
 * status with the response body (if any) attached as `.body`, so callers can
 * show a useful error instead of a bare "500".
 */
export async function postJSON(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let parsed = null;
  try {
    parsed = await r.json();
  } catch {
    /* no/invalid JSON body — fall through with parsed = null */
  }
  if (!r.ok) {
    const err = new Error(
      (parsed && parsed.error) || `${r.status} ${r.statusText || ""} ${url}`.trim(),
    );
    err.status = r.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}
