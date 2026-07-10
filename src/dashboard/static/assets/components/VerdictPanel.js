import { html, useState } from "../vendor/preact-htm.js";
import { postJSON } from "../lib/api.js";
import { adjustmentsFromEvidence, verdictLabel, verdictPillClass } from "../lib/review-bridge.js";
import { fmtTime } from "../lib/format.js";

/**
 * The trusted receiver on the shell side of the postMessage bridge (design/
 * review-architecture-decision.md "what lives where": verdict state is
 * assembled ONLY here, never inside the untrusted iframe). Pass/Fail are the
 * reviewer's explicit calls; touching the interactive part of the 3D scene
 * (e.g. dragging a landmark) auto-flips the pill to "corrected" via
 * useReviewBridge (owned by the parent, ReviewsView — see that file for why:
 * it also owns the <iframe> the bridge listens through) — that flip is
 * untrusted evidence, never the committable verdict (see
 * lib/review-bridge.js).
 *
 * Closes the loop (this task's addition over the vanilla shell): "Finish
 * review" POSTs the pinned contract body to `/api/tasks/:id/review/finish`
 * and, on success, asks the parent to re-fetch the task (`onFinished`) so
 * the chain view can read the persisted verdict back — the
 * reload-survivable half of the demo loop.
 *
 * `verdict`/`setVerdict` come from the parent's useReviewBridge() so the
 * iframe (ReviewsView) and this panel share one bridge instance.
 */
export function VerdictPanel({ taskId, phase, verdict, setVerdict, onFinished }) {
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [finishError, setFinishError] = useState(null);
  const [result, setResult] = useState(null);

  const label = verdictLabel(verdict);
  const canFinish = verdict.status != null && !submitting && !result;
  const adjustments = adjustmentsFromEvidence(verdict.evidence);

  async function handleFinish() {
    if (!verdict.status || submitting) return;
    setSubmitting(true);
    setFinishError(null);
    const body = {
      phase,
      human_verdict: verdict.status,
      corrected: verdict.corrected,
      notes,
      adjustments,
    };
    try {
      const res = await postJSON(
        `/api/tasks/${encodeURIComponent(taskId)}/review/finish`,
        body,
      );
      setResult(res ?? {});
      if (onFinished) onFinished();
    } catch (err) {
      setFinishError(err && err.message ? err.message : "Failed to save the review.");
    } finally {
      setSubmitting(false);
    }
  }

  return html`
    <div class="verdict-panel">
      <div class="verdict-panel-head">
        <span class="section-label">Reviewer verdict</span>
        <span class="pill ${verdictPillClass(label)}">${label}</span>
      </div>
      <p class="verdict-hint">
        Adjusting the 3D scene (e.g. dragging a landmark) auto-flips this to
        "corrected". Pick an explicit Pass/Fail, then Finish review to write
        it to the task tree.
      </p>
      <div class="verdict-actions">
        <button
          type="button"
          class="btn ${verdict.status === "pass" ? "btn-selected" : ""}"
          disabled=${!!result}
          onClick=${() => setVerdict("pass")}
        >
          Mark pass
        </button>
        <button
          type="button"
          class="btn ${verdict.status === "fail" ? "btn-selected" : ""}"
          disabled=${!!result}
          onClick=${() => setVerdict("fail")}
        >
          Mark fail
        </button>
      </div>
      ${adjustments.length > 0
        ? html`
            <div class="verdict-adjustments">
              <span class="section-label">Adjusted (${adjustments.length})</span>
              <div class="verdict-adjustments-chips">
                ${adjustments.map((a) => html`<code class="chip" key=${a.id}>${a.id}</code>`)}
              </div>
            </div>
          `
        : null}
      <label class="verdict-note-label" for="verdict-note">Notes</label>
      <textarea
        id="verdict-note"
        placeholder="Describe what you confirmed, adjusted, or rejected…"
        disabled=${!!result}
        value=${notes}
        onInput=${(e) => setNotes(e.currentTarget.value)}
      ></textarea>
      <div class="verdict-log">
        ${[...verdict.log].reverse().map(
          (line, i) => html`
            <div class="verdict-log-line" key=${verdict.log.length - i}>
              <span class="verdict-log-time">${fmtTime(line.at)}</span>${line.text}
            </div>
          `,
        )}
      </div>
      <div class="verdict-finish-row">
        ${finishError ? html`<span class="verdict-finish-error">${finishError}</span>` : null}
        ${result
          ? html`<span class="verdict-finish-done">Review finished — verdict saved.</span>`
          : html`
              <button
                type="button"
                class="btn btn-primary"
                disabled=${!canFinish}
                onClick=${handleFinish}
              >
                ${submitting ? "Saving…" : "Finish review"}
              </button>
            `}
      </div>
    </div>
  `;
}
