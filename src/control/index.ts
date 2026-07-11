import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  validateWatcherControlFile,
  validateWatcherStatusFile,
  type ValidationResult,
  type WatcherControlFile,
  type WatcherFolderCounts,
  type WatcherStatusFile,
} from "../schema/index.js";
import { atomicWriteJson } from "../util/atomic-write.js";

/**
 * Watcher control-plane disk contract. Like `util/atomic-write`, this lives
 * outside both processes: the dashboard (Process B) writes desired state that
 * the supervisor (Process A side) trusts, and vice versa for status — so the
 * path resolution and read/write pairing are owned by neither.
 *
 * Control files live at `<tasksDir>/../control/` — one well-defined
 * project-root location, a SIBLING of `tasks/`, shared by every process that
 * resolves its tasks dir to the same project root (the dashboard's
 * `TASKS_DIR`, the harness's `<cwd>/tasks` default).
 */

export const WATCHER_CONTROL_FILE = "watcher.json";
export const WATCHER_STATUS_FILE = "watcher-status.json";
export const WATCHER_LOCK_FILE = "watcher.lock";

/** Fixed allowlist (contract R11): the control resolver only ever hands out
 * these names — no traversal to guard because nothing else resolves. */
const CONTROL_FILE_NAMES: ReadonlySet<string> = new Set([
  WATCHER_CONTROL_FILE,
  WATCHER_STATUS_FILE,
  WATCHER_LOCK_FILE,
]);

/** The four per-protocol state folders under a watchRoot. The folders ARE the
 * queue: `incoming → in-progress → done | failed`, moved by atomic rename. */
export const WATCH_STATE_DIRS = ["incoming", "in-progress", "done", "failed"] as const;
export type WatchStateDir = (typeof WATCH_STATE_DIRS)[number];

/** Suffix of the structured failure records written next to failed drops
 * (contract R10); excluded from folder counts so a sidecar is not a "drop". */
export const FAILURE_RECORD_SUFFIX = ".error.json";

export function controlDir(tasksDir: string): string {
  return path.resolve(tasksDir, "..", "control");
}

/** The one shared control-path resolver (R11). Mirrors `resolveTaskFile`'s
 * fail-closed posture but against a fixed filename allowlist, and is
 * deliberately write-safe: it never realpaths a not-yet-existent target.
 * Returns null for any name outside the allowlist. */
export function resolveControlFile(tasksDir: string, name: string): string | null {
  if (!CONTROL_FILE_NAMES.has(name)) return null;
  return path.join(controlDir(tasksDir), name);
}

async function readValidated<T>(
  file: string,
  validate: (value: unknown) => ValidationResult<T>,
): Promise<ValidationResult<T> | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null; // Absent — a normal state, distinct from invalid.
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, errors: [{ path: "$", message: "malformed JSON" }] };
  }
  return validate(parsed);
}

/** Read `control/watcher.json`. `null` = absent; a failed ValidationResult =
 * present but invalid (callers must FAIL CLOSED on it — no new claims — and
 * surface it, never treat it as absent). */
export async function readWatcherControl(
  tasksDir: string,
): Promise<ValidationResult<WatcherControlFile> | null> {
  const file = resolveControlFile(tasksDir, WATCHER_CONTROL_FILE)!;
  return readValidated(file, validateWatcherControlFile);
}

export async function writeWatcherControl(
  tasksDir: string,
  control: WatcherControlFile,
): Promise<void> {
  await atomicWriteJson(resolveControlFile(tasksDir, WATCHER_CONTROL_FILE)!, control);
}

/** Read `control/watcher-status.json`; `null` = absent, failed result = invalid. */
export async function readWatcherStatus(
  tasksDir: string,
): Promise<ValidationResult<WatcherStatusFile> | null> {
  const file = resolveControlFile(tasksDir, WATCHER_STATUS_FILE)!;
  return readValidated(file, validateWatcherStatusFile);
}

export async function writeWatcherStatus(
  tasksDir: string,
  status: WatcherStatusFile,
): Promise<void> {
  await atomicWriteJson(resolveControlFile(tasksDir, WATCHER_STATUS_FILE)!, status);
}

/** Per-state entry counts under a watchRoot. SUPERVISOR-owned (contract R7):
 * only the lease holder computes these into the status heartbeat — the
 * dashboard never traverses watchRoot paths. Failure-record sidecars and
 * dotfiles are not drops and are excluded. */
export async function countStateDirs(watchRoot: string): Promise<WatcherFolderCounts> {
  const count = async (dir: WatchStateDir): Promise<number> => {
    try {
      const entries = await readdir(path.join(watchRoot, dir));
      return entries.filter(
        (name) => !name.startsWith(".") && !name.endsWith(FAILURE_RECORD_SUFFIX),
      ).length;
    } catch {
      return 0;
    }
  };
  const [incoming, inProgress, done, failed] = await Promise.all([
    count("incoming"),
    count("in-progress"),
    count("done"),
    count("failed"),
  ]);
  return { incoming, inProgress, done, failed };
}

/** `control/watcher.lock` payload — the single-supervisor lease (R2). */
export type WatcherLease = {
  readonly uuid: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly heartbeat: string;
};

async function readLease(file: string): Promise<WatcherLease | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (parsed === null || typeof parsed !== "object") return null;
    const rec = parsed as Record<string, unknown>;
    if (typeof rec["uuid"] !== "string" || typeof rec["heartbeat"] !== "string") {
      return null;
    }
    return rec as unknown as WatcherLease;
  } catch {
    return null;
  }
}

/**
 * Acquire or refresh the exclusive supervisor lease (contract R2). Exactly
 * one process may claim/drain/write status at a time:
 *
 * - no lock (or unreadable lock)      → exclusive create (`wx` — the atomic
 *   acquisition; a concurrent creator wins and we return false);
 * - lock with our uuid                → refresh the heartbeat (we own it);
 * - lock with a FRESH foreign uuid    → false (someone else supervises);
 * - lock with a STALE foreign uuid    → takeover: remove + exclusive create.
 *
 * Staleness = heartbeat older than `staleMs` (callers use N× poll interval).
 */
export async function acquireOrRefreshLease(
  tasksDir: string,
  uuid: string,
  staleMs: number,
): Promise<boolean> {
  const file = resolveControlFile(tasksDir, WATCHER_LOCK_FILE)!;
  await mkdir(controlDir(tasksDir), { recursive: true });

  const existing = await readLease(file);
  const now = new Date().toISOString();

  if (existing?.uuid === uuid) {
    // We own it — plain overwrite is safe (only the owner writes).
    await writeFile(
      file,
      JSON.stringify({ ...existing, pid: process.pid, heartbeat: now }),
    );
    return true;
  }

  if (existing !== null) {
    const age = Date.now() - Date.parse(existing.heartbeat);
    if (!Number.isFinite(age) || age <= staleMs) return false;
    await rm(file, { force: true }); // Stale holder — take over.
  }

  const lease: WatcherLease = { uuid, pid: process.pid, startedAt: now, heartbeat: now };
  try {
    await writeFile(file, JSON.stringify(lease), { flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/** Release the lease iff we still own it. */
export async function releaseLease(tasksDir: string, uuid: string): Promise<void> {
  const file = resolveControlFile(tasksDir, WATCHER_LOCK_FILE)!;
  const existing = await readLease(file);
  if (existing?.uuid === uuid) {
    await rm(file, { force: true });
  }
}
