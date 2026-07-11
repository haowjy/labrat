/*
 * Presentation-only pure helpers, ported from the vanilla app.js. No DOM, no
 * Preact — plain functions so they're trivial to reuse across components and
 * to eyeball-verify. Deliberately do NOT include an HTML-escape helper: Preact
 * sets text via textContent/DOM properties (never innerHTML) for every value
 * these feed into `html` templates, so manual escaping is both unnecessary
 * and (per the old app.js's own decisionPill-style call sites) an easy spot
 * to forget — removing it removes the failure mode, not just the code.
 */

/** decision -> [pill CSS class, label]. */
export function decisionPill(decision) {
  switch (decision) {
    case "pass":
      return ["pill-pass", "pass"];
    case "pass-with-concerns":
      return ["pill-warn", "concerns"];
    case "fail":
      return ["pill-fail", "fail"];
    case "fail-upstream":
      return ["pill-fail", "fail-upstream"];
    default:
      return ["pill-skip", decision];
  }
}

/** task state -> [pill CSS class, label]. */
export function statePill(s) {
  switch (s) {
    case "done":
      return ["pill-pass", "done"];
    case "running":
      return ["pill-running", "running"];
    case "paused":
      return ["pill-paused", "paused"];
    case "failed":
      return ["pill-fail", "failed"];
    default:
      return ["pill-skip", s];
  }
}

/**
 * Triage rank for a `TaskSummary` — lower means a human is needed sooner.
 * Derived ONLY from summary fields (the fleet board never fetches per-task
 * detail): `failed`/`paused` runs sit stopped with a `reason` a human must
 * clear; `running` then `queued` are the pipeline working on its own; `done`
 * asks for nothing. "Awaiting human review" is deliberately NOT its own rank:
 * the summary carries no gate/human-verdict fields, and the one shape that
 * looks like a wait (`running` + `currentPhase: null` with phases complete)
 * is actually the automated gate reviewing a just-finished phase — flagging
 * it would cry wolf on every healthy phase boundary.
 */
export function taskUrgency(task) {
  switch (task.state) {
    case "failed":
    case "paused":
      return 0;
    case "done":
      return 3;
    case "queued":
      return 2;
    default:
      return 1; // running (and anything unrecognized: treat as in flight)
  }
}

/** The fleet board's section headers, in display order (Dashboard.js). */
export const TASK_GROUPS = ["Needs attention", "In progress", "Complete"];

/** TaskSummary -> which board section it belongs to (always a TASK_GROUPS
 * member): rank 0 needs a human, rank 3 is finished, everything between is
 * the pipeline doing its own work. */
export function taskGroup(task) {
  const rank = taskUrgency(task);
  if (rank === 0) return TASK_GROUPS[0];
  if (rank === 3) return TASK_GROUPS[2];
  return TASK_GROUPS[1];
}

/** Urgency-sorted copy of a TaskSummary list — attention-needing samples
 * first, done last. Array.prototype.sort is stable, so the API's id order is
 * preserved within a rank (cards don't shuffle on every SSE re-fetch; they
 * move only when their state actually changes). App.js applies this ONCE to
 * the shared list so the Dashboard board and the Sidebar read one order. */
export function sortTasksByUrgency(tasks) {
  return [...tasks].sort((a, b) => taskUrgency(a) - taskUrgency(b));
}

/** timeline entry -> phase-dot CSS state. */
export function dotClass(entry) {
  if (entry.gate) {
    const d = entry.gate.decision;
    if (d === "pass") return "pass";
    if (d === "pass-with-concerns") return "concerns";
    return "fail";
  }
  if (entry.status === "running") return "running";
  if (entry.status === "paused") return "paused";
  if (entry.status === "failed") return "fail";
  return "pending";
}

export function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function duration(a, b) {
  if (!a || !b) return "";
  const s = Math.round((new Date(b) - new Date(a)) / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

/** The 7 state-carrying SSE event types (design §13) — "log" is separate
 * (ephemeral, not state) and handled by its own listener. */
export const STATE_EVENTS = [
  "task-started",
  "phase-started",
  "phase-complete",
  "gate-result",
  "task-done",
  "task-failed",
  "task-paused",
];

/** One-line human description of an SSE state event, for the live ticker.
 * Leads with the task id (every state event carries one — schema/sse.ts): the
 * strip renders on the fleet board, where "which sample?" is the whole
 * question, and even inside a sample the last event may be about a DIFFERENT
 * one (App.js sets it for every event, not just the open sample's). The
 * description is built once at event time and cached in state, so it can't
 * consult the current screen later — always naming the sample is both simpler
 * and more correct than a screen-conditional label. */
export function describeEvent(ev) {
  const subject = ev.taskId ?? "task";
  switch (ev.type) {
    case "gate-result":
      return `${subject} · ${ev.phase}: gate ${ev.decision}`;
    case "phase-started":
      return `${subject} · ${ev.phase}: started`;
    case "phase-complete":
      return `${subject} · ${ev.phase}: complete`;
    case "task-started":
      return `${subject} started (${ev.protocol})`;
    case "task-done":
      return `${subject} done`;
    case "task-failed":
      return `${subject} failed: ${ev.reason}`;
    case "task-paused":
      return `${subject} paused: ${ev.reason}`;
    default:
      return ev.type;
  }
}
