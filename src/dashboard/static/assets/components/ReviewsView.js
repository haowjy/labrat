import { html } from "../vendor/preact-htm.js";
import { useReviewBridge } from "./useReviewBridge.js";
import { VerdictPanel } from "./VerdictPanel.js";

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
 * owns the <iframe> the bridge listens through; VerdictPanel is a pure
 * display of whatever verdict/setVerdict it's handed (design/
 * review-architecture-decision.md "what lives where" — the verdict is
 * shell-state, assembled once, not duplicated per component).
 */

/** The one phase in this task's timeline whose recorded outputs include a
 * review site (getTask's hasReviewSite — src/dashboard/api/index.ts). Scope
 * note: this task's protocol produces exactly one; if a future protocol
 * produces more than one, this picks the first and the others simply don't
 * get a "Finish review" surface yet (multi-phase review sites are explicitly
 * out of this slice's scope — see the Lane B report). */
function findReviewPhase(timeline) {
  const entry = (timeline ?? []).find((e) => e.hasReviewSite);
  return entry ? entry.phase : null;
}

export function ReviewsView({ taskId, taskDetail, onVerdictFinished }) {
  const { verdict, bindIframe, setVerdict } = useReviewBridge();
  const reviewPhase = findReviewPhase(taskDetail && taskDetail.timeline);
  const src = window.reviewSiteSrc(taskId);

  return html`
    <div class="review-embed">
      <div class="review-embed-head">
        <span class="section-label">Review site</span>
        <span class="quarantine-note"
          >Sandboxed frame — isolated from the dashboard, no shared login or storage</span
        >
      </div>
      <iframe
        class="review-frame"
        key=${src}
        ref=${bindIframe}
        src=${src}
        sandbox=${window.REVIEW_SANDBOX}
        title="Review site for ${taskId} (sandboxed)"
        loading="lazy"
      ></iframe>
      <${VerdictPanel}
        taskId=${taskId}
        phase=${reviewPhase}
        verdict=${verdict}
        setVerdict=${setVerdict}
        onFinished=${onVerdictFinished}
      />
    </div>
  `;
}
