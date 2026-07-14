import { html, useEffect, useState } from "../vendor/preact-htm.js";
import { getJSON } from "../lib/api.js";
import { useReviewBridge } from "./useReviewBridge.js";
import { EvidencePanel } from "./EvidencePanel.js";
import { ReviewChainCard } from "./ReviewChainCard.js";
import { ReviewEmbed } from "./ReviewEmbed.js";
import { VerdictPanel } from "./VerdictPanel.js";

/**
 * Sign-off actions: download the review chain and copy the task's folder
 * path. Export is a plain download anchor — the endpoint sets
 * Content-Disposition, so the browser saves the bundle with no JS. Copy
 * folder path writes the server-provided absolute `taskDir` (from the shared
 * task detail) to the clipboard so a scientist can paste the tree into Claude
 * Science to improve the protocol — the demo's closing beat.
 */
function SignOffActions({ taskId, taskDir }) {
  const [copied, setCopied] = useState(false);

  async function copyPath() {
    try {
      await navigator.clipboard.writeText(taskDir);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return html`
    <div class="signoff-actions">
      <a class="btn" href=${`/api/tasks/${encodeURIComponent(taskId)}/export`} download>
        Export review chain
      </a>
      <button type="button" class="btn" title=${taskDir ?? ""} onClick=${copyPath}>
        ${copied ? "Copied path" : "Copy folder path"}
      </button>
    </div>
  `;
}

/**
 * The generic review layer for ONE phase — the default landing when a phase
 * is opened (design/review-architecture-decision.md: a trusted shell that
 * holds everything the reviewer reads and records, OUTSIDE the untrusted
 * artifact). It OWNS the postMessage bridge (useReviewBridge) because it owns
 * both the artifact iframe (through `bindIframe`) AND the trusted
 * VerdictPanel — so landmark corrections a reviewer makes full-screen live in
 * this component's state and are still there for the verdict controls after
 * they exit.
 *
 * Mounted by PhaseReviewView under `key=${taskId}:${phase}`, so switching
 * phase gives a genuinely fresh bridge + fresh full-screen state + a fresh
 * getPhase fetch — matching the old ReviewEmbed remount — while a data-only
 * SSE refresh (which never changes that key) leaves an in-progress verdict
 * untouched.
 *
 * Layout (top to bottom): the ReviewChainCard pins the three-agent chain
 * (worker vs. reviewer + audit + provenance); the decisive Evidence panel
 * follows with the full measurement table + gate prose; then the
 * sandboxed artifact with its full-screen toggle (full-screen is a CSS-only
 * promotion of the SAME iframe element, so the bridge survives enter/exit);
 * then the trusted verdict controls in normal flow (never floated on the
 * iframe); then the task-level sign-off actions.
 */
export function ReviewLayer({ taskId, phase, entry, taskDir, onVerdictFinished }) {
  const { verdict, bindIframe, setVerdict } = useReviewBridge();
  const [fullScreen, setFullScreen] = useState(false);
  const [phaseDetail, setPhaseDetail] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getJSON(`/api/tasks/${encodeURIComponent(taskId)}/phases/${encodeURIComponent(phase)}`)
      .then((d) => {
        if (!cancelled) setPhaseDetail(d);
      })
      .catch(() => {
        if (!cancelled) setPhaseDetail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, phase]);

  // Per-phase review-artifact descriptor (review-provenance §3.D "Dashboard
  // seams"): `published` embeds the phase-scoped site, `legacy` embeds the
  // worker-authored single site, `none` renders the exact clean empty state,
  // and `failed`/`authoring` render a DISTINCT "artifact unavailable"
  // diagnostic — never the `none` message.
  const artifact = (entry && entry.reviewArtifact) || { status: "none", type: null };
  const embeddable = artifact.status === "published" || artifact.status === "legacy";

  return html`
    <div class="review-layer">
      ${embeddable
        ? html`<${ReviewEmbed}
            taskId=${taskId}
            phase=${phase}
            legacy=${artifact.status === "legacy"}
            bindIframe=${bindIframe}
            fullScreen=${fullScreen}
            onToggleFullScreen=${setFullScreen}
          />`
        : artifact.status === "none"
          ? html`
              <div class="review-stage review-stage-empty">
                <div class="empty">No interactive review artifact for this phase.</div>
              </div>
            `
          : html`
              <div class="review-stage review-stage-empty">
                <div class="empty review-artifact-unavailable">
                  Review artifact unavailable — the artifact author
                  ${artifact.status === "failed"
                    ? "failed its deterministic checks; the verified science is unaffected. Resume the task to retry authoring."
                    : "has not finished authoring this phase's artifact yet."}
                </div>
              </div>
            `}

      <${VerdictPanel}
        taskId=${taskId}
        phase=${phase}
        verdict=${verdict}
        setVerdict=${setVerdict}
        onFinished=${onVerdictFinished}
      />

      <details class="review-section">
        <summary class="review-section-summary">Review chain</summary>
        <${ReviewChainCard} phaseDetail=${phaseDetail} />
      </details>

      <details class="review-section">
        <summary class="review-section-summary">Decisive evidence</summary>
        <${EvidencePanel} phaseDetail=${phaseDetail} />
      </details>

      <${SignOffActions} taskId=${taskId} taskDir=${taskDir} />
    </div>
  `;
}
