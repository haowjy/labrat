import { html, useEffect, useState } from "../vendor/preact-htm.js";
import { getJSON } from "../lib/api.js";
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
 * wasn't. This strip is now the ONLY phase navigation in the shell: the
 * per-sample phase index (PhaseOverview.js) that used to sit between the
 * Dashboard and this view duplicated exactly this list, so it was deleted
 * and selecting a sample lands straight here.
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
 * selection (App.js's `selectedPhase`, set by a tab click and reset to null
 * whenever a sample is selected) if it still names a phase in THIS task's
 * timeline, else the phase with a review site (the one actually worth
 * landing on), else the first phase. Since selecting a sample now lands
 * directly in Phase review, this doubles as the landing-phase chooser —
 * and a stale selection from a previously-viewed task can never leak in.
 * Pure/derived every call rather than stored+reset-by-effect state, so
 * switching tasks self-heals for free. Exported so App.js can resolve once
 * and show the same phase in the breadcrumb this view displays.
 */
export function resolveActivePhase(timeline, selectedPhase) {
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
 * Scoped to ONE phase now: this box came from the deleted PhaseOverview.js,
 * where it was task-level with a phase-picker dropdown. The phase the
 * reviewer is looking at IS the context, so the dropdown is gone — it lists
 * only the active phase's suggestions and posts new ones under that phase.
 * Mounted under key `taskId:phase` (below) so a half-typed draft can't
 * survive a phase switch and get filed under the wrong phase. Suggestions
 * have their own endpoint (they're not part of the shared task detail), so
 * the fetch stays here, keyed on the task like before.
 */
function SuggestionBox({ taskId, phase }) {
  const [suggestions, setSuggestions] = useState([]);
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getJSON(`/api/tasks/${encodeURIComponent(taskId)}/suggestions`)
      .then((s) => {
        if (!cancelled) setSuggestions(s);
      })
      .catch(() => {
        if (!cancelled) setSuggestions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  async function submit() {
    const trimmed = text.trim();
    if (!trimmed) {
      setNote("Enter a suggestion first.");
      return;
    }
    setSubmitting(true);
    try {
      const r = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/suggestions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phase, text: trimmed }),
      });
      if (!r.ok) throw new Error(await r.text());
      const entry = await r.json();
      setSuggestions((prev) => [...prev, entry]);
      setText("");
      setNote("Saved.");
    } catch {
      setNote("Failed to save.");
    } finally {
      setSubmitting(false);
    }
  }

  const visible = suggestions.filter((s) => s.phase === phase);

  return html`
    <div class="suggestion-box">
      <h3>Suggestions for the protocol author · ${phase}</h3>
      <div class="suggestion-list">
        ${visible.length === 0
          ? html`<div class="note">No suggestions for this phase yet.</div>`
          : visible.map(
              (s) => html`
                <div class="suggestion-item" key=${s.id}>
                  ${s.text}
                  <div class="meta">${s.author} · ${s.id}</div>
                </div>
              `,
            )}
      </div>
      <textarea
        placeholder="e.g., add a largest-connected-component filter to the segmentation skill so femur speckle is cleaned before handoff."
        value=${text}
        onInput=${(e) => setText(e.currentTarget.value)}
      ></textarea>
      <div class="actions">
        <span class="note">${note}</span>
        <button class="btn btn-primary" disabled=${submitting} onClick=${submit}>
          Submit suggestion
        </button>
      </div>
    </div>
  `;
}

/**
 * Phase review mode — where selecting a sample lands, now that the
 * intermediate per-sample index is gone: the task-level paused/failed
 * banner (kept from the deleted PhaseOverview.js), the selector, then
 * either the active phase's sandboxed review site (ReviewEmbed.js — iframe
 * + floated VerdictPanel) or a plain placeholder when that phase produced
 * no review site (scope guard: no per-phase review-site routing, so a phase
 * without one just says so — the rich UI lives inside the LLM-generated
 * iframe, not here). `activePhase` arrives already resolved by App.js (via
 * resolveActivePhase above) so the breadcrumb and this view can't disagree.
 *
 * The per-phase SuggestionBox renders as a SIBLING below the
 * `.phase-review` column, which keeps its exactly-one-viewport height
 * (styles.css: `flex-basis:100%`): the review stage still fills the screen
 * and the box sits below the fold, reached by scrolling `.main` — depth on
 * demand rather than stealing iframe height.
 *
 * `key=${taskId + ":" + activePhase}` on ReviewEmbed forces a fresh mount
 * (fresh useReviewBridge state) on every task or phase switch, matching the
 * old ReviewsView's `key=${src}` on its <iframe> — src alone can't do that
 * job here since reviewSiteSrc() is task-scoped, not phase-scoped (a
 * conscious scope choice, not an oversight: see ReviewEmbed.js). Switching
 * to the Dashboard unmounts this whole view, which also resets the bridge —
 * the exact same behavior the old three-tab shell had switching away from
 * its "Reviews" tab and back.
 */
export function PhaseReviewView({ taskId, taskDetail, activePhase, onSelectPhase, onVerdictFinished }) {
  if (!taskDetail) return html`<div class="empty">Loading…</div>`;
  const { task, timeline } = taskDetail;
  const entry = timeline.find((e) => e.phase === activePhase) ?? null;

  return html`
    <div class="phase-review">
      ${task.state === "paused" || task.state === "failed"
        ? html`
            <div class="banner ${task.state === "paused" ? "banner-paused" : "banner-failed"}">
              ${task.state}${task.reason ? `: ${task.reason}` : ""}
            </div>
          `
        : null}
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
    ${activePhase
      ? html`<${SuggestionBox} key=${`${taskId}:${activePhase}`} taskId=${taskId} phase=${activePhase} />`
      : null}
  `;
}
