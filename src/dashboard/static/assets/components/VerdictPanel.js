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
 *
 * Stateful flow (p80 finding 6: "three plausible places for the same action"
 * collapsed to one). Two primary choices lead: **Pass** and **Request
 * revision**. Choosing "Request revision" reveals a REQUIRED "What should the
 * worker change?" field and one primary action, "Send back for revision"
 * (the on-disk `changes_requested` mark `labrat rerun` reads). "Fail
 * permanently" is demoted to a secondary destructive action. The
 * protocol-author suggestion box is a DIFFERENT surface (specimen correction
 * vs. protocol feedback) and lives separately in ReviewLayer.
 *
 * Touching the interactive 3D scene (e.g. dragging a landmark) still
 * auto-flips the pill to "corrected" via useReviewBridge (owned by the parent
 * ReviewLayer). That "corrected" flip is untrusted evidence, never the
 * committable verdict: `human_verdict` is set only by these explicit buttons.
 *
 * `verdict`/`setVerdict` come from ReviewLayer's useReviewBridge() so the
 * iframe and this panel share one bridge instance.
 */
export function VerdictPanel({ taskId, phase, verdict, setVerdict, onFinished }) {
  // The reviewer's explicit path through the flow: null (undecided), "pass",
  // "revision" (send back), or "fail" (permanent). Distinct from the bridge's
  // `verdict.status` — "revision" is a send-back, not a committable status.
  const [choice, setChoice] = useState(null);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [finishError, setFinishError] = useState(null);
  const [result, setResult] = useState(null);
  // The chained re-run action after a send-back: null → offered, "starting"
  // while the POST is in flight, "started" once the detached rerun launched.
  const [rerunState, setRerunState] = useState(null);
  const [rerunError, setRerunError] = useState(null);

  const label = verdictLabel(verdict);
  const adjustments = adjustmentsFromEvidence(verdict.evidence);
  const locked = !!result;

  function pick(next) {
    if (locked) return;
    setChoice(next);
    setFinishError(null);
    // Pass/Fail are bridge statuses (they drive the pill + the committed
    // human_verdict); "revision" is a send-back, so it never touches status.
    if (next === "pass") setVerdict("pass");
    else if (next === "fail") setVerdict("fail");
  }

  // Commit a terminal verdict (pass or fail). `human_verdict` comes from the
  // bridge status the button set — never from a raw iframe message.
  async function commitVerdict() {
    if (!verdict.status || submitting) return;
    await post({
      phase,
      human_verdict: verdict.status,
      corrected: verdict.corrected,
      notes,
      adjustments,
    }, "Failed to save the review.");
  }

  // "Send back": writes a `changes_requested` verdict through the SAME trusted
  // route — the on-disk mark `labrat rerun <task>` reads to invalidate + re-run
  // this phase with the note threaded into the worker's prompt. Requires the
  // note: the send-back IS the correction the worker must act on.
  async function sendBack() {
    if (submitting || !notes.trim()) return;
    await post({
      phase,
      human_verdict: "changes_requested",
      corrected: verdict.corrected,
      notes,
      adjustments,
    }, "Failed to send the phase back.");
  }

  // "Re-run this phase": offered right after a send-back lands on disk, so
  // the whole loop (verdict → mark → re-run) is one in-dashboard action.
  // POST /api/tasks/:id/rerun launches the existing `labrat rerun` as a
  // detached child; the phase restart then surfaces through SSE — this
  // button only kicks it off, it never tracks the run.
  async function rerunPhase() {
    if (rerunState) return;
    setRerunState("starting");
    setRerunError(null);
    try {
      await postJSON(`/api/tasks/${encodeURIComponent(taskId)}/rerun`, {});
      setRerunState("started");
    } catch (err) {
      setRerunState(null);
      setRerunError(err && err.message ? err.message : "Failed to start the re-run.");
    }
  }

  async function post(body, failMsg) {
    setSubmitting(true);
    setFinishError(null);
    try {
      const res = await postJSON(`/api/tasks/${encodeURIComponent(taskId)}/review/finish`, body);
      setResult(res ?? {});
      if (onFinished) onFinished();
    } catch (err) {
      setFinishError(err && err.message ? err.message : failMsg);
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

      ${result
        ? choice === "revision"
          ? html`
              <div class="verdict-finish-done">
                Sent back. The changes_requested verdict is on disk.
                <div class="verdict-step-actions">
                  ${rerunError
                    ? html`<span class="verdict-finish-error">${rerunError}</span>`
                    : null}
                  ${rerunState === "started"
                    ? html`<span>Re-running — the phase will restart shortly.</span>`
                    : html`
                        <button
                          type="button"
                          class="btn btn-primary"
                          disabled=${rerunState === "starting"}
                          onClick=${rerunPhase}
                        >
                          ${rerunState === "starting" ? "Re-running…" : "Re-run this phase"}
                        </button>
                      `}
                </div>
              </div>
            `
          : html`<div class="verdict-finish-done">Review saved. This phase's verdict is on disk.</div>`
        : html`
            <div class="verdict-choice-row">
              <button
                type="button"
                class="btn ${choice === "pass" ? "btn-primary" : ""}"
                onClick=${() => pick("pass")}
              >
                Pass
              </button>
              <button
                type="button"
                class="btn ${choice === "revision" ? "btn-selected" : ""}"
                onClick=${() => pick("revision")}
              >
                Request revision
              </button>
            </div>

            ${choice === "pass"
              ? html`
                  <div class="verdict-step">
                    <label class="verdict-note-label" for="verdict-note">
                      Notes (optional)
                    </label>
                    <textarea
                      id="verdict-note"
                      placeholder="What you confirmed…"
                      value=${notes}
                      onInput=${(e) => setNotes(e.currentTarget.value)}
                    ></textarea>
                    <div class="verdict-step-actions">
                      ${finishError
                        ? html`<span class="verdict-finish-error">${finishError}</span>`
                        : null}
                      <button
                        type="button"
                        class="btn btn-primary"
                        disabled=${!verdict.status || submitting}
                        onClick=${commitVerdict}
                      >
                        ${submitting ? "Saving…" : "Finish review"}
                      </button>
                    </div>
                  </div>
                `
              : null}

            ${choice === "revision"
              ? html`
                  <div class="verdict-step verdict-step-revision">
                    <label class="verdict-note-label verdict-note-required" for="verdict-note">
                      What should the worker change?
                    </label>
                    <textarea
                      id="verdict-note"
                      placeholder="e.g. the trochlear groove landmark sits at the condylar merge — replace it one slice proximal."
                      value=${notes}
                      onInput=${(e) => setNotes(e.currentTarget.value)}
                    ></textarea>
                    <div class="verdict-step-actions">
                      ${finishError
                        ? html`<span class="verdict-finish-error">${finishError}</span>`
                        : null}
                      <button
                        type="button"
                        class="btn btn-primary"
                        disabled=${!notes.trim() || submitting}
                        title=${notes.trim() ? "" : "Describe the change first"}
                        onClick=${sendBack}
                      >
                        ${submitting ? "Sending…" : "Send back for revision"}
                      </button>
                    </div>
                  </div>
                `
              : null}

            ${choice === "fail"
              ? html`
                  <div class="verdict-step verdict-step-fail">
                    <p class="verdict-fail-warn">
                      This permanently fails the phase with no re-run. Use "Request revision" to
                      send it back instead.
                    </p>
                    <textarea
                      id="verdict-note"
                      placeholder="Why this phase cannot be salvaged…"
                      value=${notes}
                      onInput=${(e) => setNotes(e.currentTarget.value)}
                    ></textarea>
                    <div class="verdict-step-actions">
                      ${finishError
                        ? html`<span class="verdict-finish-error">${finishError}</span>`
                        : null}
                      <button
                        type="button"
                        class="btn btn-danger"
                        disabled=${!verdict.status || submitting}
                        onClick=${commitVerdict}
                      >
                        ${submitting ? "Saving…" : "Fail permanently"}
                      </button>
                    </div>
                  </div>
                `
              : null}

            <details class="verdict-more">
              <summary class="verdict-more-summary">Bridge activity and adjustments</summary>
              <p class="verdict-hint">
                Adjusting the 3D scene (e.g. dragging a landmark) flags this "corrected" for your
                attention. It never commits a verdict; an explicit choice above does.
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
              <div class="verdict-log">
                ${[...verdict.log].reverse().map(
                  (line, i) => html`
                    <div class="verdict-log-line" key=${verdict.log.length - i}>
                      <span class="verdict-log-time">${fmtTime(line.at)}</span>${line.text}
                    </div>
                  `,
                )}
              </div>
              ${choice !== "fail"
                ? html`
                    <button type="button" class="verdict-fail-link" onClick=${() => pick("fail")}>
                      Fail permanently instead
                    </button>
                  `
                : null}
            </details>
          `}
    </div>
  `;
}
