import { html, useEffect, useState } from "../vendor/preact-htm.js";
import { getJSON } from "../lib/api.js";
import { phasePill } from "../lib/format.js";

/** Unchanged from the old ReviewChainView.js, just relocated: Overview is
 * now the task-level "index" page ReviewChainView used to be, and this
 * form doesn't belong to any one phase's detail, so it lives here rather
 * than in Phase review. Logic untouched. */
function SuggestionBox({ taskId, phases }) {
  const [suggestions, setSuggestions] = useState([]);
  const [phase, setPhase] = useState(phases[0] ?? "");
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

  return html`
    <div class="suggestion-box">
      <h3>Suggestions for the protocol author</h3>
      <div class="suggestion-list">
        ${suggestions.length === 0
          ? html`<div class="note">No suggestions yet.</div>`
          : suggestions.map(
              (s) => html`
                <div class="suggestion-item" key=${s.id}>
                  ${s.text}
                  <div class="meta">${s.phase} · ${s.author} · ${s.id}</div>
                </div>
              `,
            )}
      </div>
      <div class="form-row">
        <label>Phase</label>
        <select value=${phase} onChange=${(e) => setPhase(e.currentTarget.value)}>
          ${phases.map((p) => html`<option key=${p} value=${p}>${p}</option>`)}
        </select>
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

/** One row of the phase index — a name, its status/gate pill, whether it's
 * been human-reviewed, and whether it has an interactive review site to
 * open. Deliberately NOT the old PhaseRow.js: this is an index, not a
 * detail view — measurements/subphases/evidence/verification prose have no
 * home in the minimal shell (goal doc: "the rich UI lives inside the
 * LLM-generated iframe, not here"); that detail now lives in the per-phase
 * review site itself. Every phase is clickable, including ones with no
 * review site yet — Phase review shows a plain placeholder for those
 * rather than special-casing which rows respond to a click. */
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

/**
 * Overview mode: a compact, clickable index of the selected task's phases
 * (goal doc mockup) — status/gate pill each, click one to open Phase review
 * for it — plus the suggestions box moved down from the old chain view.
 * Reads the SAME `taskDetail.timeline` every view reads (App.js's one
 * shared `GET /api/tasks/:id` fetch); no separate fetch of its own.
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

      ${timeline.length === 0
        ? html`<div class="empty">No phases yet.</div>`
        : html`
            <div class="phase-index">
              ${timeline.map(
                (entry) => html`<${PhaseIndexRow} key=${entry.phase} entry=${entry} onSelect=${onSelectPhase} />`,
              )}
            </div>
          `}

      <${SuggestionBox} taskId=${taskId} phases=${timeline.map((e) => e.phase)} />
    </div>
  `;
}
