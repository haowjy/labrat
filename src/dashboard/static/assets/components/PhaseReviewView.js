import { html } from "../vendor/preact-htm.js";
import { dotClass, decisionPill } from "../lib/format.js";
import { ReviewEmbed } from "./ReviewEmbed.js";

/**
 * Mutually-exclusive phase selector for Phase review mode — visually the
 * same pill-tab strip as the old chain view's PhaseTabs.js (same
 * `.phase-tabs`/`.phase-tab*` CSS, same dot-per-decision via `dotClass`,
 * same review-site diamond marker), but a genuinely different interaction:
 * PhaseTabs.js was deliberately NOT a panel switcher (it jump-scrolled a
 * long single-column timeline). There is no long timeline to scroll here —
 * Phase review shows exactly one phase's content at a time — so this one
 * IS the mutually-exclusive switcher PhaseTabs.js's own docblock said it
 * wasn't. That old component had no remaining use once the chain view it
 * jump-navigated was replaced by the compact Overview index, so it was
 * deleted rather than bent to a second, incompatible job.
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
            ${entry.hasReviewSite
              ? html`<span class="phase-tab-review-mark" title="has an interactive review site">◆</span>`
              : null}
          </button>
        `,
      )}
    </div>
  `;
}

/**
 * Resolve which phase Phase review displays: the caller's explicit
 * selection (App.js's `selectedPhase`, set by an Overview row or a tab
 * click) if it still names a phase in THIS task's timeline, else the phase
 * with a review site (the one actually worth landing on), else the first
 * phase — so the top switch's "Phase review" button is never a dead click
 * and a stale selection from a previously-viewed task never leaks in.
 * Pure/derived from props every render rather than stored+reset-by-effect
 * state, so switching tasks self-heals for free.
 */
function resolveActivePhase(timeline, selectedPhase) {
  if (selectedPhase && timeline.some((e) => e.phase === selectedPhase)) return selectedPhase;
  const withReviewSite = timeline.find((e) => e.hasReviewSite);
  if (withReviewSite) return withReviewSite.phase;
  return timeline[0]?.phase ?? null;
}

/**
 * The automated gate's own verdict for the phase under review (F2). At level 3
 * the human commits a Pass/Fail; without this they'd never see WHY the gate
 * passed or failed. Summary judgment only — the decision pill plus the gate's
 * short feedback, both already on the timeline entry (api/index.ts's
 * GateSummary carries `feedback`); the full provenance dump stays in the
 * review site. Renders nothing until a gate exists, so the in-flight phase
 * (no gate yet) shows no empty band. `dotClass` tints the border to the same
 * pass/concerns/fail color the selector dot uses, so the two never disagree.
 */
function GateReasoning({ entry }) {
  if (!entry || !entry.gate) return null;
  const [pc, pl] = decisionPill(entry.gate.decision);
  return html`
    <div class="gate-note gate-note-${dotClass(entry)}">
      <div class="gate-note-head">
        <span class="section-label">Automated gate</span>
        <span class="pill ${pc}">${pl}</span>
      </div>
      ${entry.gate.feedback
        ? html`<p class="gate-note-body">${entry.gate.feedback}</p>`
        : html`<p class="gate-note-body gate-note-empty">No feedback recorded.</p>`}
    </div>
  `;
}

/**
 * Phase review mode: the selector above, then either the selected phase's
 * sandboxed review site (ReviewEmbed.js — iframe + floated VerdictPanel) or
 * a plain placeholder when that phase produced no review site (scope guard:
 * no per-phase review-site routing, so a phase without one just says so —
 * the rich UI lives inside the LLM-generated iframe, not here).
 *
 * `key=${taskId + ":" + activePhase}` on ReviewEmbed forces a fresh mount
 * (fresh useReviewBridge state) on every task or phase switch, matching the
 * old ReviewsView's `key=${src}` on its <iframe> — src alone can't do that
 * job here since reviewSiteSrc() is task-scoped, not phase-scoped (a
 * conscious scope choice, not an oversight: see ReviewEmbed.js). Switching
 * to Overview unmounts this whole view, which also resets the bridge — the
 * exact same behavior the old three-tab shell had switching away from its
 * "Reviews" tab and back.
 */
export function PhaseReviewView({ taskId, taskDetail, selectedPhase, onSelectPhase, onVerdictFinished }) {
  if (!taskDetail) return html`<div class="empty">Loading…</div>`;
  const { timeline } = taskDetail;
  const activePhase = resolveActivePhase(timeline, selectedPhase);
  const entry = timeline.find((e) => e.phase === activePhase) ?? null;

  return html`
    <div class="phase-review">
      <${PhaseSelector} timeline=${timeline} activePhase=${activePhase} onSelect=${onSelectPhase} />
      <${GateReasoning} entry=${entry} />
      ${!entry
        ? html`<div class="empty">No phases yet.</div>`
        : entry.hasReviewSite
          ? html`<${ReviewEmbed}
              key=${`${taskId}:${activePhase}`}
              taskId=${taskId}
              phase=${activePhase}
              onFinished=${onVerdictFinished}
            />`
          : html`
              <div class="review-stage review-stage-empty">
                <div class="empty">No interactive review for this phase.</div>
              </div>
            `}
    </div>
  `;
}
