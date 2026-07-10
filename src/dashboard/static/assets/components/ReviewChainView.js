import { html, useEffect, useState } from "../vendor/preact-htm.js";
import { getJSON } from "../lib/api.js";
import { Lightbox } from "./Lightbox.js";
import { PhaseRow } from "./PhaseRow.js";
import { PhaseTabs } from "./PhaseTabs.js";

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

/**
 * The review-chain view: phase tabs + the per-phase timeline (ported from
 * app.js's renderChain — skeleton renders synchronously from the already-
 * fetched `taskDetail`, each PhaseRow independently fetches its own detail,
 * same progressive-reveal UX as the vanilla shell's
 * fillPhaseSkeleton/fillPhaseDetail split) + the suggestions box.
 */
export function ReviewChainView({ taskId, taskDetail, refreshTick, onOpenReviews }) {
  const [lightbox, setLightbox] = useState(null);

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

      <${PhaseTabs} timeline=${timeline} />

      <div class="timeline">
        ${timeline.map(
          (entry, i) => html`
            <${PhaseRow}
              key=${entry.phase}
              taskId=${taskId}
              entry=${entry}
              last=${i === timeline.length - 1}
              refreshTick=${refreshTick}
              onOpenLightbox=${(src, cap) => setLightbox({ src, cap })}
              onOpenReviews=${onOpenReviews}
            />
          `,
        )}
      </div>

      <${SuggestionBox} taskId=${taskId} phases=${timeline.map((e) => e.phase)} />
      <${Lightbox} open=${lightbox} onClose=${() => setLightbox(null)} />
    </div>
  `;
}
