/**
 * Env hardening shared by EVERY harness-spawned session (worker, monitor,
 * feedback-router): keep progressive tool disclosure OFF. Tool search can
 * defer in-process MCP tools (record_phase / submit_gate_decision /
 * submit_monitor_verdict / submit_feedback_route) and then drop them from the
 * searchable registry after a long turn + continue:true, which mis-reports a
 * completed phase as a stall. Every per-session tool set is small, so loading
 * everything upfront is the right trade. (Claude Code ENABLE_TOOL_SEARCH.)
 *
 * Spread/assign this wherever a session env is built — a new session builder
 * that forgets it silently re-exposes the deferred-tool bug.
 */
export const SESSION_ENV_HARDENING = {
  ENABLE_TOOL_SEARCH: "false",
} as const;
