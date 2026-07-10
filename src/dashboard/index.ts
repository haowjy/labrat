/**
 * Dashboard public surface (Process B, design §4).
 *
 * The harness wires to exactly one thing here — the SSE publish seam
 * {@link publishEvent} — to announce that disk changed. Everything else reads
 * disk directly; nothing in the dashboard depends on the harness.
 */
export { createApp, startServer } from "./server.js";
export { loadConfig, type DashboardConfig } from "./config.js";

// SSE publish seam for the harness (see sse/index.ts for the contract).
export { publishEvent, handleSse, subscriberCount } from "./sse/index.js";

// Disk-reading API (also usable directly in tests).
export {
  listTasks,
  getTask,
  getPhase,
  getManifest,
  getSuggestions,
  type TaskSummary,
  type TaskDetail,
  type TimelineEntry,
  type PhaseDetail,
} from "./api/index.js";
export { appendSuggestion, type NewSuggestion } from "./suggestions/index.js";
export { STATIC_ROOT } from "./static/index.js";
