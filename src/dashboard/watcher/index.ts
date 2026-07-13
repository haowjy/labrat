import {
  readWatcherControl,
  readWatcherStatus,
  writeWatcherControl,
} from "../../control/index.js";
import { listClaudeScienceSkills } from "../../harness/claude-science/registry.js";
import {
  validateWatcherControlPatch,
  type WatcherControlFile,
  type WatcherStatusFile,
} from "../../schema/index.js";

/**
 * Dashboard side of the watcher control panel (contract rev v2: routes
 * `GET /api/watcher/status` + `POST /api/watcher`). Mirrors
 * `dashboard/review`'s split: validation + disk I/O here, the route maps the
 * `{ok,...}` result straight to the HTTP response.
 *
 * ARCHITECTURE NOTE (contract R7): this is the one explicit control-plane
 * exception to Process B's "read only disk under tasksDir" rule — the two
 * control files live at `<tasksDir>/../control/`, resolved through the shared
 * `src/control` seam (no harness imports). The dashboard NEVER traverses
 * external `watchRoot` paths: the SUPERVISOR owns folder counts and writes
 * them into the status heartbeat; this side only reads that file.
 */

/** Heartbeats older than this many × the supervisor's own pollIntervalMs
 * read as offline — a stale "running" status must never render as running. */
const STALE_HEARTBEAT_FACTOR = 5;
/** Floor so a very fast poll interval can't mark a healthy daemon stale on
 * ordinary scheduling jitter. */
const MIN_STALE_MS = 10_000;

export type WatcherStatusView =
  | (WatcherStatusFile & { readonly healthy: boolean })
  | { readonly state: "stopped"; readonly protocols: Record<string, never> };

/**
 * Status for the panel: the supervisor's heartbeat verbatim, plus derived
 * `healthy` (R10 — freshness = `lastHeartbeat` against a documented
 * staleness threshold). Absent or unreadable heartbeat → a synthesized
 * stopped view; the UI shows "daemon offline" when `healthy` is false.
 */
export async function getWatcherStatus(tasksDir: string): Promise<WatcherStatusView> {
  const status = await readWatcherStatus(tasksDir);
  if (status === null || !status.ok) {
    return { state: "stopped", protocols: {} };
  }
  const ageMs = Date.now() - Date.parse(status.value.lastHeartbeat);
  const staleMs = Math.max(
    status.value.pollIntervalMs * STALE_HEARTBEAT_FACTOR,
    MIN_STALE_MS,
  );
  return { ...status.value, healthy: Number.isFinite(ageMs) && ageMs <= staleMs };
}

export type UpdateWatcherControlResult =
  | { readonly ok: true; readonly value: WatcherControlFile }
  | { readonly ok: false; readonly status: 400; readonly error: string };

/**
 * `POST /api/watcher` write path: validate the raw body (unknown `desired`
 * and empty/relative watchRoots are rejected in the schema; protocol ids
 * must name a RUNNABLE protocol in the Claude Science registry — the same
 * allowlist `startManualRun` enforces on /api/enqueue, so a typo'd id fails
 * loudly here instead of sitting inert in the control file forever), merge
 * onto the existing `control/watcher.json`, write atomically, return the new
 * desired state. NOTE: writing `desired: "running"` enables ingestion in an
 * already-running `labrat watch` daemon — a file cannot start a process.
 */
export async function updateWatcherControl(
  tasksDir: string,
  scienceHome: string,
  body: unknown,
): Promise<UpdateWatcherControlResult> {
  const patch = validateWatcherControlPatch(body);
  if (!patch.ok) {
    return {
      ok: false,
      status: 400,
      error: patch.errors.map((e) => `${e.path}: ${e.message}`).join("; "),
    };
  }

  const patchedIds = Object.keys(patch.value.protocols ?? {});
  if (patchedIds.length > 0) {
    const skills = await listClaudeScienceSkills(scienceHome, { includeBuiltins: true });
    const known = skills.filter((s) => s.runnable).map((s) => s.name);
    const unknown = patchedIds.find((id) => !known.includes(id));
    if (unknown !== undefined) {
      return {
        ok: false,
        status: 400,
        error:
          `protocol "${unknown}" is not a runnable protocol in the Claude Science ` +
          `registry${known.length > 0 ? ` (known: ${known.join(", ")})` : ""}`,
      };
    }
  }

  const existing = await readWatcherControl(tasksDir);
  // An invalid existing file is dashboard-owned state — replace it rather
  // than 500 the panel into a corner it cannot edit its way out of.
  const base: WatcherControlFile =
    existing !== null && existing.ok
      ? existing.value
      : { desired: "stopped", protocols: {} };

  const merged: WatcherControlFile = {
    desired: patch.value.desired ?? base.desired,
    protocols: { ...base.protocols, ...patch.value.protocols },
  };
  await writeWatcherControl(tasksDir, merged);
  return { ok: true, value: merged };
}
