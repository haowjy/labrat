import { html, useState } from "../vendor/preact-htm.js";
import { postJSON } from "../lib/api.js";
import { adjustmentsFromEvidence, verdictLabel, verdictPillClass } from "../lib/review-bridge.js";
import { fmtTime } from "../lib/format.js";

/**
 * The trusted verdict controls on the shell side of the postMessage bridge
 * (design/review-architecture-decision.md "what lives where": verdict state
 * is assembled ONLY in the trusted shell, never inside the untrusted iframe).
 * Rendered in normal flow in the generic review layer — NOT floated on the
 * artifact — so a reviewer records the verdict OUTSIDE the sandboxed frame.
 * Pass/Fail are the reviewer's explicit calls; touching the interactive part
 * of the 3D scene (e.g. dragging a landmark) auto-flips the pill to
 * "corrected" via useReviewBridge (owned by the parent ReviewLayer, which
 * also owns the <iframe> the bridge listens through). Because the bridge
 * lives in ReviewLayer, a correction made while the artifact is full-screen
 * is still reflected here after the reviewer exits — that "corrected" flip is
 * untrusted evidence, never the committable verdict (see lib/review-bridge.js).
 *
 * Closes the loop: "Finish review" POSTs the pinned contract body to
 * `/api/tasks/:id/review/finish` and, on success, asks the parent to re-fetch
 * the task (`onFinished`) so the persisted verdict reads back on reload.
 *
 * `verdict`/`setVerdict` come from ReviewLayer's useReviewBridge() so the
 * iframe and this panel share one bridge instance.
 *
 * Progressive disclosure (F3): the verdict pill, Mark pass/fail, and Finish
 * review stay visible; the guidance, adjustments, notes field, and log fold
 * into a <details> a reviewer opens when they reach for them. Pass/Fail sit
 * OUTSIDE the disclosure on purpose — "mark pass/fail visible immediately".
 */
export function VerdictPanel({ taskId, phase, verdict, setVerdict, onFinished }) {
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [finishError, setFinishError] = useState(null);
  const [result, setResult] = useState(null);

  const label = verdictLabel(verdict);
  const canFinish = phase != null && verdict.status != null && !submitting && !result;
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

  // "Send back": the human-initiated re-run trigger. Writes a
  // `changes_requested` human verdict (review/verdict/{phase}.json) through
  // the SAME trusted `/review/finish` route — the on-disk mark an operator's
  // `labrat rerun <task>` then reads to invalidate + re-run this phase with
  // the note threaded into the worker's prompt. Requires a note: the whole
  // point of a send-back is the correction the worker must act on.
  async function handleSendBack() {
    if (submitting || !notes.trim()) return;
    setSubmitting(true);
    setFinishError(null);
    const body = {
      phase,
      human_verdict: "changes_requested",
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
      setFinishError(err && err.message ? err.message : "Failed to send the phase back.");
    } finally {
      setSubmitting(false);
    }
  }

  const canSendBack = phase != null && notes.trim() !== "" && !submitting && !result;

  return html`
    <div class="verdict-panel">
      <div class="verdict-panel-head">
        <span class="section-label">Reviewer verdict</span>
        <span class="pill ${verdictPillClass(label)}">${label}</span>
      </div>
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
      <details class="verdict-more">
        <summary class="verdict-more-summary">Notes, log, and guidance</summary>
        <p class="verdict-hint">
          Adjusting the 3D scene (e.g. dragging a landmark) auto-flips this to
          "corrected". Pick an explicit Pass/Fail, then Finish review to write
          it to the task tree.
        </p>
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
      </details>
      <div class="verdict-finish-row">
        ${finishError ? html`<span class="verdict-finish-error">${finishError}</span>` : null}
        ${result
          ? html`<span class="verdict-finish-done">Review finished — verdict saved.</span>`
          : html`
              <button
                type="button"
                class="btn"
                disabled=${!canSendBack}
                title="Reject this phase and re-run it with your note (add a note first)"
                onClick=${handleSendBack}
              >
                ${submitting ? "Sending…" : "Send back"}
              </button>
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
