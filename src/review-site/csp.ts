/**
 * The canonical review-site Content-Security-Policy — the SINGLE source of
 * truth for both the served route (`dashboard/server.ts`) and the gate that
 * confirms it (`review-site/check.ts`, plumbed by
 * `harness/orchestrator/review-artifact-check.ts`).
 *
 * Before F4 the CSP string lived only in the server route, so the G5 gate
 * "downgrade a `connect-src`-owned sink to a warning ONLY when the served
 * policy is exactly `connect-src 'none'`" precondition could not be verified —
 * the gate never saw the served policy. Now both sides call `buildReviewSiteCsp`
 * and the gate calls `cspConfirmsNoConnect` on the effective policy, so the two
 * cannot drift: weakening the policy weakens what the gate confirms, and the
 * gate FAILS CLOSED (treats the downgrade as unavailable) when the policy is
 * missing, malformed, or anything other than an exact `connect-src 'none'`.
 */

/**
 * Build the review-site CSP (design C5/R2). Quarantines a served review page to
 * its own bytes + any allow-listed CDNs:
 *   - `connect-src 'none'` blocks fetch/XHR/beacon/WebSocket/EventSource back to
 *     the dashboard APIs (the class the G5 gate is allowed to downgrade);
 *   - `webrtc 'block'` (CSP3) blocks RTCPeerConnection, which `connect-src` does
 *     NOT own — defense-in-depth alongside the G5 WebRTC hard-fail;
 *   - `frame-ancestors 'self'` stops third-party framing; `base-uri 'none'`
 *     blocks `<base>` rewriting; `form-action 'none'` blocks form POSTs;
 *     `object-src 'none'` blocks `<object>`/`<embed>`.
 * `'unsafe-inline'` on script-src is LOAD-BEARING (R4): the inlined single-
 * document site renders blank in an opaque-origin sandbox without it. Empty
 * tokens are filtered so an empty allowlist yields exactly
 * `script-src 'self' 'unsafe-inline'` (no trailing space).
 */
export function buildReviewSiteCsp(cdnAllowlist: readonly string[] = []): string {
  const scriptSrc = ["'self'", "'unsafe-inline'", ...cdnAllowlist]
    .filter((t) => t !== "")
    .join(" ");
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'none'",
    "webrtc 'block'",
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join("; ");
}

/** The whitespace-separated token list of a named directive, or null if absent. */
function directiveTokens(policy: string, name: string): readonly string[] | null {
  for (const raw of policy.split(";")) {
    const parts = raw.trim().split(/\s+/).filter((t) => t.length > 0);
    if (parts.length > 0 && parts[0]?.toLowerCase() === name) return parts.slice(1);
  }
  return null;
}

/**
 * Fail-closed confirmation that the effective policy blocks network reach-back:
 * true ONLY when an explicit `connect-src 'none'` directive is present. A
 * missing directive is NOT sufficient — `connect-src` would fall back to
 * `default-src 'self'`, which permits same-origin connections. Any weaker or
 * malformed value (missing, extra sources, wildcard, undefined policy) returns
 * false, so the gate keeps the `connect-src`-owned sinks as hard-fails.
 */
export function cspConfirmsNoConnect(policy: string | undefined): boolean {
  if (policy === undefined || policy === "") return false;
  const tokens = directiveTokens(policy, "connect-src");
  return tokens !== null && tokens.length === 1 && tokens[0] === "'none'";
}
