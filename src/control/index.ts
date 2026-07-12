import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
  } catch (err) {
    // Only ENOENT is "absent — a normal state". Any other read failure
    // (permissions, I/O) must surface as a failed result so callers fail
    // closed AND diagnose it, instead of treating it as a missing file.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return {
      ok: false,
      errors: [
        {
          path: "$",
          message: `unreadable: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
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

/** How a lease read resolved. `absent` and `valid` are the normal states;
 * `malformed` (unparseable / wrong shape — e.g. a crashed writer left a
 * partial file) must be RECOVERABLE by the next daemon, never a permanent
 * EEXIST; `unreadable` (a non-ENOENT I/O failure) fails closed. */
type LeaseRead =
  | { readonly kind: "absent" }
  | { readonly kind: "valid"; readonly lease: WatcherLease; readonly raw: string }
  | { readonly kind: "malformed"; readonly raw: string }
  | { readonly kind: "unreadable" };

async function readLeaseFile(file: string): Promise<LeaseRead> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable" };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object") {
      const rec = parsed as Record<string, unknown>;
      if (typeof rec["uuid"] === "string" && typeof rec["heartbeat"] === "string") {
        return { kind: "valid", lease: rec as unknown as WatcherLease, raw };
      }
    }
  } catch {
    // fall through — malformed
  }
  return { kind: "malformed", raw };
}

/**
 * Atomically steal the lock file for inspection, then replace it with our
 * lease. `rename` is atomic, so of N concurrent stealers exactly one wins
 * and the losers get ENOENT — unlike `rm + create`, a loser can never
 * delete the winner's fresh lease. After stealing we verify the content is
 * still the `expectedRaw` our takeover decision was based on; if a new
 * holder slipped in between read and steal, we restore their lease and back
 * off.
 *
 * DEFERRED (multi-supervisor): the restore path can itself race a third
 * contender's `wx` create in the steal window. Full protection needs a
 * fencing-generation protocol across all mutations (tracked follow-up); a
 * single daemon recovering a stale/malformed lock (crash → restart) has no
 * contention and is fully covered here.
 */
async function stealAndReplaceLease(
  file: string,
  expectedRaw: string,
  lease: WatcherLease,
): Promise<boolean> {
  const tomb = `${file}.takeover-${lease.uuid}`;
  try {
    await rename(file, tomb);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false; // lost the steal race
    throw err;
  }
  let stolenRaw: string | null = null;
  try {
    stolenRaw = await readFile(tomb, "utf8");
  } catch {
    stolenRaw = null;
  }
  if (stolenRaw !== expectedRaw) {
    // Someone replaced the lease between our read and the steal — restore.
    try {
      await rename(tomb, file);
    } catch {
      await rm(tomb, { force: true });
    }
    return false;
  }
  await rm(tomb, { force: true });
  try {
    await writeFile(file, JSON.stringify(lease), { flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/**
 * Acquire or refresh the exclusive supervisor lease (contract R2). Exactly
 * one process may claim/drain/write status at a time:
 *
 * - no lock                            → exclusive create (`wx` — the atomic
 *   acquisition; a concurrent creator wins and we return false);
 * - lock with our uuid                 → refresh the heartbeat (we own it);
 * - lock with a FRESH foreign uuid     → false (someone else supervises);
 * - lock with a STALE foreign uuid     → identity-verified takeover
 *   (a heartbeat that does not parse counts as stale);
 * - MALFORMED lock (partial/garbage)   → identity-verified takeover — a
 *   crashed writer's residue must be recoverable, never a permanent EEXIST;
 * - unreadable lock (I/O failure)      → false (fail closed).
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

  const read = await readLeaseFile(file);
  const now = new Date().toISOString();
  const fresh: WatcherLease = { uuid, pid: process.pid, startedAt: now, heartbeat: now };

  switch (read.kind) {
    case "unreadable":
      return false; // Can't determine ownership — fail closed.
    case "valid": {
      if (read.lease.uuid === uuid) {
        // We own it — refresh, preserving startedAt.
        // DEFERRED (multi-supervisor): a fencing generation would prevent
        // this overwrite from clobbering a successor that took over our
        // stale lease between the read and this write.
        await writeFile(
          file,
          JSON.stringify({ ...read.lease, pid: process.pid, heartbeat: now }),
        );
        return true;
      }
      const age = Date.now() - Date.parse(read.lease.heartbeat);
      // Non-finite = the heartbeat doesn't parse — as stale as ancient.
      if (Number.isFinite(age) && age <= staleMs) return false;
      return stealAndReplaceLease(file, read.raw, fresh);
    }
    case "malformed":
      return stealAndReplaceLease(file, read.raw, fresh);
    case "absent": {
      try {
        await writeFile(file, JSON.stringify(fresh), { flag: "wx" });
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw err;
      }
    }
  }
}

/** Does `uuid` currently hold the lease? Ownership check for final status
 * writes at shutdown — a former holder must not overwrite a successor's
 * status (contract R2/R4). */
export async function holdsLease(tasksDir: string, uuid: string): Promise<boolean> {
  const file = resolveControlFile(tasksDir, WATCHER_LOCK_FILE)!;
  const read = await readLeaseFile(file);
  return read.kind === "valid" && read.lease.uuid === uuid;
}

/** Release the lease iff we still own it. Uses the same atomic
 * steal-then-verify as takeover: renaming before deleting means we can
 * inspect exactly what we removed and restore a successor's lease instead
 * of deleting it (a plain read-then-rm could delete a lease written between
 * the two calls). */
export async function releaseLease(tasksDir: string, uuid: string): Promise<void> {
  const file = resolveControlFile(tasksDir, WATCHER_LOCK_FILE)!;
  const read = await readLeaseFile(file);
  if (read.kind !== "valid" || read.lease.uuid !== uuid) return;
  const tomb = `${file}.release-${uuid}`;
  try {
    await rename(file, tomb);
  } catch {
    return; // Already gone or stolen — nothing of ours left to release.
  }
  const stolen = await readLeaseFile(tomb);
  if (stolen.kind === "valid" && stolen.lease.uuid === uuid) {
    await rm(tomb, { force: true });
  } else {
    // Not ours anymore — a successor took over in the window; put it back.
    try {
      await rename(tomb, file);
    } catch {
      await rm(tomb, { force: true });
    }
  }
}
