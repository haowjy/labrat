import { html } from "../vendor/preact-htm.js";
import { phasePill } from "../lib/format.js";

/** One row of the phase index — a name, its status/gate pill, whether it's
 * been human-reviewed, and whether it has an interactive review site to
 * open. Deliberately NOT the old PhaseRow.js: this is an index, not a
 * detail view — the decisive evidence and the review artifact live in the
 * per-phase review layer (ReviewLayer.js), not here. Every phase is
 * clickable, including ones with no review site yet — Phase review shows a
 * plain placeholder for those rather than special-casing which rows respond
 * to a click. */
function PhaseIndexRow({ entry, onSelect }) {
  const [pc, pl] = phasePill(entry);
  return html`
    <button type="button" class="phase-index-row" onClick=${() => onSelect(entry.phase)}>
      <span class="phase-index-name">
        ${entry.phase}
        ${entry.attempt && entry.attempt > 1 ? html`<span class="attempt">attempt ${entry.attempt}</span>` : null}
      </span>
      <span class="phase-index-pills">
        ${entry.hasReviewSite
          ? html`<span class="phase-tab-review-mark" title="has an interactive review site">◆</span>`
          : null}
        ${entry.humanVerdict
          ? html`<span class="pill ${entry.humanVerdict.human_verdict === "pass" ? "pill-pass" : "pill-fail"}"
              >reviewed: ${entry.humanVerdict.human_verdict}</span
            >`
          : null}
        <span class="pill ${pc}">${pl}</span>
      </span>
    </button>
  `;
}

/** A one-line aggregate of the phase index (F4): count phases by their
 * status/gate pill and show one pill per distinct outcome, e.g.
 * [3 pass] [1 concerns] [1 running]. Uses the SAME `phasePill` precedence
 * each row uses (gate decision wins, else the phase's own status), so the
 * tally can't disagree with the rows it summarizes. Counts accumulate in
 * timeline order and render first-seen, so completed outcomes lead and the
 * in-flight phase trails — the same order as the index below. */
function PhaseSummary({ timeline }) {
  const counts = [];
  for (const entry of timeline) {
    const [cls, label] = phasePill(entry);
    const found = counts.find((c) => c.label === label);
    if (found) found.n += 1;
    else counts.push({ cls, label, n: 1 });
  }
  return html`
    <div class="phase-summary">
      ${counts.map((c) => html`<span class="pill ${c.cls}" key=${c.label}>${c.n} ${c.label}</span>`)}
    </div>
  `;
}

/**
 * Overview mode: a compact, clickable index of the selected task's phases
 * (goal doc mockup) — status/gate pill each, click one to open the per-phase
 * review layer. Reads the SAME `taskDetail.timeline` every view reads
 * (App.js's one shared `GET /api/tasks/:id` fetch); no separate fetch of its
 * own. The per-phase evidence, verdict, feedback, and sign-off actions all
 * live in the review layer a row opens, so this stays a pure index.
 */
export function PhaseOverview({ taskId, taskDetail, onSelectPhase }) {
  if (!taskDetail) return html`<div class="empty">Loading…</div>`;
  const { task, timeline } = taskDetail;

  return html`
    <div>
      ${task.state === "paused" || task.state === "failed"
        ? html`
            <div class="banner ${task.state === "paused" ? "banner-paused" : "banner-failed"}">
              ${task.state}${task.reason ? `: ${task.reason}` : ""}
            </div>
          `
        : null}

      ${timeline.length > 0 ? html`<${PhaseSummary} timeline=${timeline} />` : null}

      ${timeline.length === 0
        ? html`<div class="empty">No phases yet.</div>`
        : html`
            <div class="phase-index">
              ${timeline.map(
                (entry) => html`<${PhaseIndexRow} key=${entry.phase} entry=${entry} onSelect=${onSelectPhase} />`,
              )}
            </div>
          `}
    </div>
  `;
}
