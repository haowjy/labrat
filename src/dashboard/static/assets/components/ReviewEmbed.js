import { html } from "../vendor/preact-htm.js";

/*
 * The review site is quarantined content (design/review-template.md §3
 * point 3): it runs in a sandboxed iframe with NO allow-same-origin, so it
 * is an opaque origin that cannot read the dashboard's cookies/storage/DOM
 * or call /api/*. REVIEW_SANDBOX / reviewSiteSrc live in review-site.js
 * (a plain classic script, loaded by index.html before this module — see
 * that file for why the trust-boundary-critical constant has exactly one
 * definition, still directly unit-tested by review-site.test.ts) — read off
 * `window` here rather than redeclared, so this module has zero chance of
 * drifting from that constant.
 *
 * This component is now ONLY the untrusted artifact surface: the sandboxed
 * <iframe> plus its full-screen chrome. The postMessage bridge (verdict
 * state) was lifted OUT to the parent ReviewLayer, which owns BOTH this
 * iframe (via the `bindIframe` ref it passes down) and the trusted
 * VerdictPanel in the generic review layer — so a reviewer's landmark
 * corrections, captured while full-screen, survive the exit back to the
 * verdict controls (they live in the parent's state, not here).
 *
 * Full-screen is a pure LAYOUT toggle, never a remount: `fullScreen` only
 * swaps a CSS class on the same `.review-embed` element and the iframe keeps
 * its stable `key=${src}`, so its nested browsing context — and every
 * message the bridge has already accepted from it — is preserved across
 * enter/exit. (An SSE tick likewise never remounts it; the parent's key is
 * `taskId:phase`, unchanged by a data refresh.)
 *
 * Renamed from the old three-tab shell's ReviewsView.js — review-site.test.ts
 * greps this file by name and asserts the <iframe> sets `sandbox` from
 * `window.REVIEW_SANDBOX` and `src` from the review-site.js URL builders
 * (`window.reviewSiteSrc` / `window.reviewSiteSrcForPhase`), the
 * trust-boundary regression guard; keep those bindings verbatim.
 */
export function ReviewEmbed({ taskId, phase, legacy, bindIframe, fullScreen, onToggleFullScreen }) {
  // Published author artifacts live at the phase-scoped route; `legacy`
  // worker-authored sites keep the original single-site URL. Both builders
  // live in review-site.js (trust-boundary constants) and are read off
  // `window` so this module cannot drift from the pinned URL shapes.
  const src = legacy
    ? window.reviewSiteSrc(taskId)
    : window.reviewSiteSrcForPhase(taskId, phase);

  return html`
    <div class="review-embed ${fullScreen ? "review-embed-fullscreen" : ""}">
      <div class="review-embed-head">
        <span class="section-label">Review artifact — ${phase}</span>
        <div class="review-embed-head-right">
          <span class="quarantine-note"
            >Sandboxed frame — isolated from the dashboard, no shared login or storage</span
          >
          <button
            type="button"
            class="btn"
            aria-pressed=${fullScreen}
            onClick=${() => onToggleFullScreen(!fullScreen)}
          >
            ${fullScreen ? "Exit full-screen" : "Open full-screen review"}
          </button>
        </div>
      </div>
      <div class="review-stage">
        <iframe
          class="review-frame"
          key=${src}
          ref=${bindIframe}
          src=${src}
          sandbox=${window.REVIEW_SANDBOX}
          title="Review site for ${taskId} (sandboxed)"
          loading="lazy"
        ></iframe>
      </div>
    </div>
  `;
}
