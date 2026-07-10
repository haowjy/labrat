import { html } from "../vendor/preact-htm.js";
import { useReviewBridge } from "./useReviewBridge.js";
import { VerdictOverlay } from "./VerdictOverlay.js";

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
 * This component OWNS the postMessage bridge (useReviewBridge) because it
 * owns the <iframe> the bridge listens through; VerdictOverlay/VerdictPanel
 * are a pure display of whatever verdict/setVerdict they're handed (design/
 * review-architecture-decision.md "what lives where" — the verdict is
 * shell-state, assembled once, not duplicated per component).
 *
 * Renamed from the old three-tab shell's ReviewsView.js (review-site.test.ts
 * greps this file by name for the trust-boundary regression guard — kept in
 * sync there): this is no longer a standalone top-level tab, just the
 * per-phase embed PhaseReviewView.js mounts for whichever phase is selected
 * and has a review site. Same iframe, same bridge — only the caller and the
 * VerdictPanel's container changed (floated overlay, see VerdictOverlay.js,
 * instead of a bar in normal flow below the frame).
 */

/** GET /api/tasks/:id/review-site/index.html for this task — task-scoped,
 * not phase-scoped (scope guard: no per-phase review-site routing). Caller
 * (PhaseReviewView.js) only mounts this for a phase whose timeline entry
 * has `hasReviewSite: true`, so `phase` here is always the one the site
 * actually describes. */
export function ReviewEmbed({ taskId, phase, onFinished }) {
  const { verdict, bindIframe, setVerdict } = useReviewBridge();
  const src = window.reviewSiteSrc(taskId);

  return html`
    <div class="review-embed">
      <div class="review-embed-head">
        <span class="section-label">Review site — ${phase}</span>
        <span class="quarantine-note"
          >Sandboxed frame — isolated from the dashboard, no shared login or storage</span
        >
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
        <${VerdictOverlay}
          taskId=${taskId}
          phase=${phase}
          verdict=${verdict}
          setVerdict=${setVerdict}
          onFinished=${onFinished}
        />
      </div>
    </div>
  `;
}
