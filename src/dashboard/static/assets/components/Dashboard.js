import { html } from "../vendor/preact-htm.js";
import { statePill, taskGroup, TASK_GROUPS } from "../lib/format.js";
import { usePulseOnChange } from "./usePulseOnChange.js";

/** "complete" once the task itself is done; otherwise the phase actually in
 * flight, falling back to the last completed one for the rare transitional
 * state where the harness hasn't set `currentPhase` yet (all phases already
 * in `phasesComplete` but `state` not yet flipped to "done" — seen on the
 * task-008 fixture); "not started" only when neither exists. */
function currentPhaseLabel(task) {
  if (task.state === "done") return "complete";
  return task.currentPhase ?? task.phasesComplete[task.phasesComplete.length - 1] ?? null;
}

/** phase.state -> the .phase-tab-dot modifier class (same small dot
 * primitive the Phase-review selector uses — see PhaseReviewView.js). */
function dotClassForState(state) {
  if (state === "running") return "running";
  if (state === "paused") return "paused";
  if (state === "failed") return "fail";
  return "";
}

/**
 * Compact per-sample progress strip built ONLY from `TaskSummary` (no
 * backend change, no per-phase gate fetch for every card on the board): one
 * dot per completed phase, plus one more for the phase in flight if the
 * task isn't done. `phasesComplete` alone doesn't say whether a phase's
 * gate was a clean "pass" or "pass-with-concerns" (that detail lives in the
 * per-task GET, read once a sample is actually opened — see PhaseOverview),
 * so every completed dot renders the same "done" color; the board's job is
 * a fleet-wide glance, not a gate audit.
 */
function ProgressDots({ task }) {
  const dots = task.phasesComplete.map(
    (p) => html`<span class="phase-tab-dot pass" key=${p} title="${p} — complete"></span>`,
  );
  if (task.state !== "done" && task.currentPhase) {
    dots.push(html`<span
      class="phase-tab-dot ${dotClassForState(task.state)}"
      key="current"
      title="${task.currentPhase} — ${task.state}"
    ></span>`);
  }
  if (dots.length === 0) return html`<span class="sample-card-no-phases">no phases yet</span>`;
  return html`<div class="sample-card-progress">${dots}</div>`;
}

function SampleCard({ task, onSelect }) {
  const [pc, pl] = statePill(task.state);
  const phase = currentPhaseLabel(task);
  const pulsing = usePulseOnChange(`${task.state}|${task.currentPhase ?? ""}|${task.phasesComplete.length}`);

  return html`
    <button
      type="button"
      class="sample-card ${pulsing ? "sample-card-pulse" : ""}"
      onClick=${() => onSelect(task.id)}
    >
      <div class="sample-card-head">
        <span class="sample-card-id">${task.id}</span>
        <span class="pill ${pc}">${pl}</span>
      </div>
      <div class="sample-card-protocol">${task.protocol}</div>
      <div class="sample-card-phase-label">
        ${phase ? html`current: <b>${phase}</b>` : "not started"}
      </div>
      <${ProgressDots} task=${task} />
      ${task.reason ? html`<div class="sample-card-reason">${task.reason}</div>` : null}
    </button>
  `;
}

/**
 * Level 1 — the actual "dashboard": a fleet board of every sample and the
 * phase each is currently on, not any one sample's detail (that's level 2,
 * PhaseOverview.js). The landing view and what "Dashboard" in the drawer
 * returns to (App.js).
 *
 * Reads the SAME `tasks` list (`GET /api/tasks` -> `TaskSummary[]`) the
 * Sidebar already renders — no new fetch, no backend change; a sample IS a
 * task, this is just a second, larger-scale view of the identical list.
 */
export function Dashboard({ tasks, onSelectSample }) {
  if (tasks.length === 0) {
    return html`<div class="empty">No samples yet.</div>`;
  }
  // `tasks` arrives already urgency-sorted (App.js). Split it into the board's
  // three sections and drop the empty ones: when nothing is stuck there is no
  // "Needs attention" header at all, so the reviewer's eye lands on the first
  // section that actually has cards. The alert tint on that one header is the
  // board's "look here first" — it's the whole point of level 1.
  const groups = TASK_GROUPS.map((name) => [name, tasks.filter((t) => taskGroup(t) === name)]).filter(
    ([, items]) => items.length > 0,
  );
  return html`
    <div class="sample-groups">
      ${groups.map(
        ([name, items]) => html`
          <section class="sample-group" key=${name}>
            <div class="section-label ${name === TASK_GROUPS[0] ? "section-label-alert" : ""}">
              ${name} · ${items.length}
            </div>
            <div class="sample-board">
              ${items.map(
                (t) => html`<${SampleCard} key=${t.id} task=${t} onSelect=${onSelectSample} />`,
              )}
            </div>
          </section>
        `,
      )}
    </div>
  `;
}
