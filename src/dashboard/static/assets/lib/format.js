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

/** timeline entry -> [pill CSS class, label], same precedence as dotClass
 * (gate decision wins, else the phase's own status) but as a labeled pill
 * instead of a bare colored dot — what the Overview index's compact
 * "status/gate pill" per phase renders. */
export function phasePill(entry) {
  if (entry.gate) return decisionPill(entry.gate.decision);
  switch (entry.status) {
    case "running":
      return ["pill-running", "running"];
    case "paused":
      return ["pill-paused", "paused"];
    case "failed":
      return ["pill-fail", "failed"];
    case "complete":
      return ["pill-pass", "complete"];
    default:
      return ["pill-skip", "pending"];
  }
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

/** One-line human description of an SSE state event, for the live ticker. */
export function describeEvent(ev) {
  switch (ev.type) {
    case "gate-result":
      return `${ev.phase}: gate ${ev.decision}`;
    case "phase-started":
      return `${ev.phase}: started`;
    case "phase-complete":
      return `${ev.phase}: complete`;
    case "task-started":
      return `task started (${ev.protocol})`;
    case "task-done":
      return "task done";
    case "task-failed":
      return `task failed: ${ev.reason}`;
    case "task-paused":
      return `task paused: ${ev.reason}`;
    default:
      return ev.type;
  }
}
