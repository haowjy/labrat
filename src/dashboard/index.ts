/**
 * Dashboard public surface (Process B, design §4).
 *
 * The harness never calls into the dashboard directly: it appends SSE events
 * to each task's `events/events.jsonl` and POSTs a wake hint to
 * `/internal/events` (review-provenance §3B). The disk broker here replays
 * and tails those logs; nothing in the dashboard depends on a live harness.
 */
export { createApp, startServer } from "./server.js";
export { loadConfig, type DashboardConfig } from "./config.js";

// Disk-backed SSE broker (see sse/index.ts for the contract).
export { createSseBroker, type SseBroker, type SseBrokerOptions } from "./sse/index.js";

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
