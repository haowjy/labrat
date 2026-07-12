import { html } from "../vendor/preact-htm.js";
import { dotClass } from "../lib/format.js";
import { ReviewLayer } from "./ReviewLayer.js";

/**
 * Mutually-exclusive phase selector for Phase review mode — the same
 * pill-tab strip (`.phase-tabs`/`.phase-tab*` CSS, dot-per-decision via
 * `dotClass`, review-site diamond marker) used as the ONLY phase navigation
 * in the review layer: Phase review shows exactly one phase at a time, so
 * this strip is the switcher between them. It sits OUTSIDE the keyed
 * ReviewLayer below so clicking a tab re-keys and remounts that layer (fresh
 * verdict bridge, fresh evidence) for the newly selected phase.
 */
function PhaseSelector({ timeline, activePhase, onSelect }) {
  if (timeline.length === 0) return null;
  return html`
    <div class="phase-tabs" role="tablist" aria-label="Phases">
      ${timeline.map(
        (entry) => html`
          <button
            key=${entry.phase}
            type="button"
            role="tab"
            aria-selected=${entry.phase === activePhase}
            class="phase-tab ${entry.phase === activePhase ? "phase-tab-active" : ""}"
            onClick=${() => onSelect(entry.phase)}
          >
            <span class="phase-tab-dot ${dotClass(entry)}"></span>
            ${entry.phase}
            ${entry.reviewArtifact &&
            (entry.reviewArtifact.status === "published" || entry.reviewArtifact.status === "legacy")
              ? html`<span class="phase-tab-review-mark" title="has an interactive review site">◆</span>`
              : null}
          </button>
        `,
      )}
    </div>
  `;
}

/**
 * Resolve which phase Phase review displays: the caller's explicit selection
 * (App.js's `selectedPhase`, set by an Overview row or a tab click) if it
 * still names a phase in THIS task's timeline, else the phase with a review
 * site (the one worth landing on), else the first phase — so the entry is
 * never a dead click and a stale selection from a previously-viewed task
 * never leaks in. Pure/derived from props every render, so switching tasks
 * self-heals for free.
 */
function resolveActivePhase(timeline, selectedPhase) {
  if (selectedPhase && timeline.some((e) => e.phase === selectedPhase)) return selectedPhase;
  const withReviewSite = timeline.find(
    (e) =>
      e.reviewArtifact &&
      (e.reviewArtifact.status === "published" || e.reviewArtifact.status === "legacy"),
  );
  if (withReviewSite) return withReviewSite.phase;
  return timeline[0]?.phase ?? null;
}

/**
 * Phase review — the generic trusted review layer for one phase. This shell
 * holds only the phase-navigation chrome (the paused/failed banner and the
 * selector); everything a reviewer reads and records — evidence, the
 * sandboxed artifact with its full-screen toggle, the verdict controls,
 * per-phase feedback, sign-off — lives in ReviewLayer, mounted below under
 * `key=${taskId}:${activePhase}`.
 *
 * That key is what forces a fresh verdict bridge (fresh useReviewBridge
 * state, held inside ReviewLayer now, not the artifact) on every task or
 * phase switch, while a data-only SSE refresh — which changes `taskDetail`
 * but not the key — leaves an in-progress verdict and any full-screen
 * corrections untouched.
 */
export function PhaseReviewView({ taskId, taskDetail, selectedPhase, onSelectPhase, onVerdictFinished }) {
  if (!taskDetail) return html`<div class="empty">Loading…</div>`;
  const { task, timeline, taskDir } = taskDetail;
  const activePhase = resolveActivePhase(timeline, selectedPhase);
  const entry = timeline.find((e) => e.phase === activePhase) ?? null;

  return html`
    <div class="phase-review">
      ${task.state === "paused" || task.state === "failed"
        ? html`
            <div class="banner ${task.state === "paused" ? "banner-paused" : "banner-failed"}">
              ${task.state}${task.reason ? `: ${task.reason.length > 120 ? task.reason.slice(0, 117) + "…" : task.reason}` : ""}
            </div>
          `
        : null}
      <${PhaseSelector} timeline=${timeline} activePhase=${activePhase} onSelect=${onSelectPhase} />
      ${!activePhase
        ? html`<div class="empty">No phases yet.</div>`
        : html`<${ReviewLayer}
            key=${`${taskId}:${activePhase}`}
            taskId=${taskId}
            phase=${activePhase}
            entry=${entry}
            taskDir=${taskDir}
            onVerdictFinished=${onVerdictFinished}
          />`}
    </div>
  `;
}
