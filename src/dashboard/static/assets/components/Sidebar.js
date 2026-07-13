import { html } from "../vendor/preact-htm.js";
import { statePill } from "../lib/format.js";
import { usePulseOnChange } from "./usePulseOnChange.js";

function TaskCard({ task, active, onSelect }) {
  const [pc, pl] = statePill(task.state);
  const reasonBrief = task.reason
    ? task.reason.length > 60
      ? task.reason.slice(0, 57) + "…"
      : task.reason
    : null;
  const sub =
    task.state === "running" && task.currentPhase
      ? task.currentPhase
      : reasonBrief
        ? reasonBrief
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
 * see that file). Owns BOTH levels of cross-sample navigation now: a
 * "Dashboard" entry back to the level-1 fleet board, and the level-2 sample
 * list below it (unchanged "streaming cards" — SSE notification -> GET
 * /api/tasks re-fetch, componentized with a brief update pulse). Phase
 * review (level 3) has no entry of its own here — a reviewer reaches it
 * from a sample's phase index, and gets back to level 2 by re-selecting
 * that same sample from this same list (its `.active` row is still
 * highlighted the whole time they're anywhere inside it, review included).
 *
 * `active` never needs to also check `screen`: App.js clears `currentId` to
 * null whenever it navigates to the dashboard, so no task's id can equal it
 * while the Dashboard entry itself is the one that should be highlighted.
 */
export function Sidebar({ tasks, currentId, screen, onSelect, onGoDashboard, onGoSubmit, onGoWatch, onGoSkills }) {
  return html`
    <aside class="sidebar">
      <div class="sidebar-header">
        <span class="logo">LabRat</span>
        <span class="badge">${tasks.length} sample${tasks.length === 1 ? "" : "s"}</span>
      </div>
      <nav class="sidebar-nav">
        <button
          type="button"
          class="sidebar-nav-item ${screen === "dashboard" ? "active" : ""}"
          onClick=${onGoDashboard}
        >
          <span class="sidebar-nav-icon" aria-hidden="true">⌂</span>
          Dashboard
        </button>
        <button
          type="button"
          class="sidebar-nav-item ${screen === "submit" ? "active" : ""}"
          onClick=${onGoSubmit}
        >
          <span class="sidebar-nav-icon" aria-hidden="true">＋</span>
          Submit a sample
        </button>
        <button
          type="button"
          class="sidebar-nav-item ${screen === "watch" ? "active" : ""}"
          onClick=${onGoWatch}
        >
          <span class="sidebar-nav-icon" aria-hidden="true">◉</span>
          Watch folders
        </button>
        <button
          type="button"
          class="sidebar-nav-item ${screen === "skills" ? "active" : ""}"
          onClick=${onGoSkills}
        >
          <span class="sidebar-nav-icon" aria-hidden="true">⚯</span>
          Claude Science
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
