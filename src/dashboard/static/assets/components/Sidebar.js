import { html } from "../vendor/preact-htm.js";
import { statePill } from "../lib/format.js";
import { usePulseOnChange } from "./usePulseOnChange.js";

function TaskCard({ task, active, onSelect }) {
  const [pc, pl] = statePill(task.state);
  const sub =
    task.state === "running" && task.currentPhase
      ? task.currentPhase
      : task.reason
        ? task.reason
        : `${task.phasesComplete.length} phase${task.phasesComplete.length === 1 ? "" : "s"}`;
  const pulsing = usePulseOnChange(`${task.state}|${task.currentPhase ?? ""}|${task.reason ?? ""}`);

  return html`
    <div
      class="task-item ${active ? "active" : ""} ${pulsing ? "task-item-pulse" : ""}"
      onClick=${() => onSelect(task.id)}
    >
      <div class="task-id">${task.id}</div>
      <div class="task-protocol">${task.protocol}</div>
      <div class="task-meta">
        <span class="pill ${pc}">${pl}</span>
        <span class="task-sub">${sub}</span>
      </div>
    </div>
  `;
}

/**
 * Sidebar: the shell's one persistent navigation surface (desktop: an
 * always-visible column; mobile: the MobileDrawer's off-canvas content —
 * see that file). Owns both levels of the two-level shell: a "Dashboard"
 * entry back to the level-1 fleet board, and the sample list below it
 * (unchanged "streaming cards" — SSE notification -> GET /api/tasks
 * re-fetch, componentized with a brief update pulse). Selecting a sample
 * opens Phase review directly — there is no intermediate per-sample index
 * anymore — and re-selecting the already-open sample re-lands it on that
 * sample's default phase (App.js's `selectSample`); its `.active` row stays
 * highlighted the whole time it's open.
 *
 * Active states need nothing beyond `currentId`: App.js clears it to null
 * whenever it navigates to the dashboard, so "no sample open" IS "the
 * Dashboard entry is the current level".
 */
export function Sidebar({ tasks, currentId, onSelect, onGoDashboard }) {
  return html`
    <aside class="sidebar">
      <div class="sidebar-header">
        <span class="logo">LabRat</span>
        <span class="badge">${tasks.length} sample${tasks.length === 1 ? "" : "s"}</span>
      </div>
      <nav class="sidebar-nav">
        <button
          type="button"
          class="sidebar-nav-item ${currentId === null ? "active" : ""}"
          onClick=${onGoDashboard}
        >
          <span class="sidebar-nav-icon" aria-hidden="true">⌂</span>
          Dashboard
        </button>
      </nav>
      <div class="task-list">
        ${tasks.map(
          (t) => html`
            <${TaskCard} key=${t.id} task=${t} active=${t.id === currentId} onSelect=${onSelect} />
          `,
        )}
      </div>
    </aside>
  `;
}
