import { html, useEffect, useRef, useState } from "../vendor/preact-htm.js";
import { statePill } from "../lib/format.js";

const PULSE_MS = 900;

/** True for ~PULSE_MS right after `value` changes — drives the brief
 * highlight on a task card when its live status changes. Purely a CSS
 * transition trigger; the data itself still only ever changes via the
 * existing SSE-notification -> re-fetch pattern (design §13) — this hook
 * doesn't add a new data source, just reacts to the value already changing. */
function usePulseOnChange(value) {
  const [pulsing, setPulsing] = useState(false);
  const prev = useRef(value);
  useEffect(() => {
    if (prev.current === value) return;
    prev.current = value;
    setPulsing(true);
    const t = setTimeout(() => setPulsing(false), PULSE_MS);
    return () => clearTimeout(t);
  }, [value]);
  return pulsing;
}

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

/** Sidebar task list, rendered as live-updating "streaming cards" — same
 * data/refresh pattern as the vanilla shell's task list (SSE notification ->
 * GET /api/tasks re-fetch), just componentized with a brief update pulse. */
export function Sidebar({ tasks, currentId, onSelect }) {
  return html`
    <aside class="sidebar">
      <div class="sidebar-header">
        <span class="logo">LabRat</span>
        <span class="badge">${tasks.length} task${tasks.length === 1 ? "" : "s"}</span>
      </div>
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
