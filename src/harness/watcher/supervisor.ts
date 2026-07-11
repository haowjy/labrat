import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { LabratConfig } from "../../config/index.js";
import {
  acquireOrRefreshLease,
  countStateDirs,
  FAILURE_RECORD_SUFFIX,
  readWatcherControl,
  readWatcherStatus,
  releaseLease,
  WATCH_STATE_DIRS,
  writeWatcherStatus,
} from "../../control/index.js";
import type {
  TaskState,
  WatcherActiveDrop,
  WatcherDropRef,
  WatcherFailureRecord,
  WatcherProtocolStatus,
  WatcherStatusFile,
} from "../../schema/index.js";
import { atomicWriteJson } from "../../util/atomic-write.js";
import { COMPLETE_SENTINEL_SUFFIX, createSettleTracker, signatureOf, type SettleTracker } from "./index.js";

/**
 * Folder-watch supervisor: the reconcile loop behind `labrat watch`
 * (contract rev v2).
 *
 * Desired state comes from `control/watcher.json` (dashboard-written);
 * heartbeat goes to `control/watcher-status.json`. The per-protocol state
 * folders ARE the queue — every transition is an atomic rename:
 *
 *   settle → rename(incoming/x → in-progress/<ts>-<intakeId>-x)  ← the CLAIM
 *          → enqueueAndRun(...)                     ← one-slot background run
 *          → rename(in-progress/… → done/|failed/)  ← the OUTCOME
 *
 * Key invariants:
 * - R2: only the holder of the `control/watcher.lock` lease claims, drains,
 *   or writes status; `reconcileOnce` is also re-entrancy-guarded in-process.
 * - R4: the control loop never awaits a run. Each tick harvests the finished
 *   run, publishes a fresh heartbeat, and — when the one slot is free and
 *   desired=running — claims ONE drop and launches it in the background.
 *   Stop is graceful: the active run finishes, nothing new is claimed.
 * - R1: pre-existing `in-progress/` entries at startup are QUARANTINED to
 *   `failed/` (`enqueueAndRun` always allocates a NEW task, so re-enqueueing
 *   would duplicate a scientific run), with a structured reason record.
 * - R6: terminal names are unique (`<claimTs>-<intakeId>-<name>`); an
 *   existing destination is a surfaced invariant failure, never an overwrite.
 * - R10: one bad drop or protocol never aborts the tick or its siblings;
 *   failures persist as `failed/<storedName>.error.json` records.
 * - R11: a malformed control file FAILS CLOSED — no new claims, the error is
 *   carried in the status heartbeat.
 */

export type EnqueueResult = {
  readonly taskId: string;
  readonly state: TaskState;
};

/** Injection seam for tests: the default wraps the orchestrator's
 * `enqueueAndRun` (imported lazily so tests never load the agent stack). */
export type EnqueueFn = (inputAbs: string, protocol: string) => Promise<EnqueueResult>;

export type SupervisorOptions = {
  readonly config: LabratConfig;
  /** Tasks root; `control/` resolves to its sibling. Defaults to
   * `<cwd>/tasks`, matching `enqueueAndRun`. */
  readonly tasksRoot?: string;
  /** Drop is settled after this long with no change. Default 3000ms. */
  readonly debounceMs?: number;
  /** Control-loop tick interval. Default 1000ms. Lease staleness and reader
   * health derive from it (stale = older than 5×). */
  readonly pollIntervalMs?: number;
  readonly enqueue?: EnqueueFn;
  readonly log?: (message: string) => void;
};

export type ReconcileResult = {
  /** False when another supervisor holds the lease — this tick did nothing. */
  readonly leaseHeld: boolean;
  /** True when the tick was skipped (overlapping `reconcileOnce` call). */
  readonly skipped: boolean;
  /** The heartbeat written this tick (null when not lease holder/skipped). */
  readonly status: WatcherStatusFile | null;
};

export type Supervisor = {
  /** One control-loop tick — the entire loop body, so tests never spin the
   * infinite loop. Never awaits the protocol run (R4). */
  readonly reconcileOnce: () => Promise<ReconcileResult>;
  /** Resolves when the one-slot background run (if any) has finished and its
   * drop has been moved to its terminal folder. */
  readonly waitForIdle: () => Promise<void>;
  /** The daemon loop: tick, sleep, repeat until the signal aborts; then
   * gracefully finish the active run, write a final stopped heartbeat, and
   * release the lease. */
  readonly run: (signal?: AbortSignal) => Promise<void>;
};

/** Multiplier on pollIntervalMs after which a lease/heartbeat is stale. */
export const STALE_HEARTBEAT_FACTOR = 5;

/**
 * Atomic-rename claim. Exactly one claimant wins `incoming/x`; the loser's
 * rename throws ENOENT and we report "lost the race" instead of erroring.
 */
export async function claimDrop(fromPath: string, toPath: string): Promise<boolean> {
  try {
    await rename(fromPath, toPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function listDrops(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir))
      .filter((n) => !n.startsWith(".") && !n.endsWith(FAILURE_RECORD_SUFFIX))
      .sort();
  } catch {
    return [];
  }
}

/** Validate a protocol's watchRoot per R8/R9: create the four state dirs,
 * require every dir (and the root) to be a REAL directory — not a symlink —
 * and require all five to sit on the SAME filesystem so the atomic-rename
 * claim can never degrade to copy-and-delete. Returns an error string
 * (fail closed for this protocol) or null. */
async function validateWatchRoot(watchRoot: string): Promise<string | null> {
  try {
    for (const dir of WATCH_STATE_DIRS) {
      await mkdir(join(watchRoot, dir), { recursive: true });
    }
    const devs = new Set<number>();
    for (const p of [watchRoot, ...WATCH_STATE_DIRS.map((d) => join(watchRoot, d))]) {
      const st = await lstat(p);
      if (!st.isDirectory()) {
        return `${p} is not a real directory (symlinked or non-directory state paths are rejected)`;
      }
      devs.add(st.dev);
    }
    if (devs.size > 1) {
      return `state dirs under ${watchRoot} span multiple filesystems (device ids ${[...devs].join(", ")}); atomic rename requires one`;
    }
    return null;
  } catch (err) {
    return `watchRoot ${watchRoot} is unusable: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function defaultEnqueue(
  inputAbs: string,
  protocol: string,
  tasksRoot: string,
  config: LabratConfig,
): Promise<EnqueueResult> {
  const { enqueueAndRun } = await import("../orchestrator/index.js");
  const result = await enqueueAndRun(inputAbs, protocol, tasksRoot, config);
  return { taskId: result.taskId, state: result.task.state };
}

type ActiveRun = {
  readonly protocol: string;
  readonly watchRoot: string;
  /** Original display name (R6/R11 — status shows this, not storedName). */
  readonly name: string;
  readonly storedName: string;
  readonly intakeId: string;
  readonly claimedAt: string;
  taskId: string | null;
  finished: boolean;
  promise: Promise<void>;
};

export function createSupervisor(options: SupervisorOptions): Supervisor {
  const {
    config,
    tasksRoot = join(resolve(process.cwd()), "tasks"),
    debounceMs = 3000,
    pollIntervalMs = 1000,
    log = () => {},
  } = options;
  const enqueue: EnqueueFn =
    options.enqueue ?? ((inputAbs, protocol) => defaultEnqueue(inputAbs, protocol, tasksRoot, config));

  const leaseUuid = randomUUID();
  const leaseStaleMs = pollIntervalMs * STALE_HEARTBEAT_FACTOR;
  const since = new Date().toISOString();

  const trackers = new Map<string, SettleTracker>();
  const lastDrops = new Map<string, WatcherDropRef>();
  const protocolErrors = new Map<string, string>();
  const quarantined = new Set<string>();
  let activeRun: ActiveRun | null = null;
  let ticking = false;
  let seededFromDisk = false;

  function trackerFor(protocol: string): SettleTracker {
    let tracker = trackers.get(protocol);
    if (!tracker) {
      tracker = createSettleTracker(debounceMs);
      trackers.set(protocol, tracker);
    }
    return tracker;
  }

  /** Carry lastDrop across restarts so the panel doesn't blank on a bounce. */
  async function seedLastDrops(): Promise<void> {
    seededFromDisk = true;
    const prior = await readWatcherStatus(tasksRoot);
    if (prior === null || !prior.ok) return;
    for (const [protocol, status] of Object.entries(prior.value.protocols)) {
      if (status.lastDrop) lastDrops.set(protocol, status.lastDrop);
    }
  }

  /** Merged protocol → watchRoot map (R5): the config seam is the validated
   * baseline, the dashboard-written control file is the persisted runtime
   * override, per protocol. */
  function effectiveProtocols(
    controlProtocols: Readonly<Record<string, { readonly watchRoot: string }>>,
  ): Record<string, string> {
    const merged: Record<string, string> = { ...config.watchRoots };
    for (const [protocol, entry] of Object.entries(controlProtocols)) {
      merged[protocol] = entry.watchRoot;
    }
    return merged;
  }

  async function writeFailureRecord(record: WatcherFailureRecord, failedDir: string): Promise<void> {
    try {
      await atomicWriteJson(
        join(failedDir, `${record.storedName}${FAILURE_RECORD_SUFFIX}`),
        record,
      );
    } catch (err) {
      // The record is best-effort context; losing it must not lose the drop.
      log(`could not write failure record for ${record.storedName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** No-clobber terminal move (R6). Unique stored names make a collision an
   * invariant violation: surface it and leave the drop where it is (a
   * restart quarantines it) rather than overwrite history. */
  async function moveToTerminal(
    fromPath: string,
    watchRoot: string,
    outcome: "done" | "failed",
    storedName: string,
  ): Promise<boolean> {
    const dest = join(watchRoot, outcome, storedName);
    if (await exists(dest)) {
      log(`INVARIANT: terminal destination ${dest} already exists; refusing to overwrite`);
      return false;
    }
    await rename(fromPath, dest);
    return true;
  }

  /** R1: startup quarantine. Anything already in `in-progress/` when this
   * supervisor first sees a protocol is a crashed run whose execution state
   * is unknown — move it to `failed/` with a reason record; NEVER re-enqueue
   * (that would allocate a duplicate task for the same scan). */
  async function quarantineStranded(protocol: string, watchRoot: string): Promise<void> {
    const inProgressDir = join(watchRoot, "in-progress");
    for (const name of await listDrops(inProgressDir)) {
      const intakeId = randomUUID().slice(0, 8);
      const storedName = `${Date.now()}-${intakeId}-${name}`;
      const moved = await moveToTerminal(
        join(inProgressDir, name),
        watchRoot,
        "failed",
        storedName,
      );
      if (!moved) continue;
      log(`quarantined stranded ${join(inProgressDir, name)} → failed/${storedName}`);
      await writeFailureRecord(
        {
          intakeId,
          protocol,
          sourceName: name,
          storedName,
          error: "supervisor-restart; execution state unknown",
          taskId: null,
          at: new Date().toISOString(),
        },
        join(watchRoot, "failed"),
      );
    }
  }

  /** Launch the one-slot background run for a claimed drop (R4). The control
   * loop keeps ticking while this promise runs; failures are surfaced via
   * the log, the failed/ move, and a structured record (R10). */
  function launchRun(
    protocol: string,
    watchRoot: string,
    name: string,
    storedName: string,
    intakeId: string,
  ): void {
    const claimedAt = new Date().toISOString();
    const inProgressPath = join(watchRoot, "in-progress", storedName);
    lastDrops.set(protocol, { name, state: "in-progress", taskId: null, at: claimedAt });

    const run: ActiveRun = {
      protocol,
      watchRoot,
      name,
      storedName,
      intakeId,
      claimedAt,
      taskId: null,
      finished: false,
      promise: Promise.resolve(),
    };
    run.promise = (async () => {
        let outcome: "done" | "failed";
        let errorMessage: string | null = null;
        try {
          const result = await enqueue(inProgressPath, protocol);
          run.taskId = result.taskId;
          outcome = result.state === "failed" ? "failed" : "done";
          if (outcome === "failed") errorMessage = `task ${result.taskId} ended in state=failed`;
          log(`run finished for ${name}: task=${result.taskId} state=${result.state} → ${outcome}/`);
        } catch (err) {
          outcome = "failed";
          errorMessage = err instanceof Error ? err.message : String(err);
          log(`enqueue FAILED for ${inProgressPath}: ${errorMessage} → failed/`);
        }
        try {
          const moved = await moveToTerminal(inProgressPath, watchRoot, outcome, storedName);
          if (moved && outcome === "failed") {
            await writeFailureRecord(
              {
                intakeId,
                protocol,
                sourceName: name,
                storedName,
                error: errorMessage ?? "unknown failure",
                taskId: run.taskId,
                at: new Date().toISOString(),
              },
              join(watchRoot, "failed"),
            );
          }
          lastDrops.set(protocol, {
            name,
            state: outcome,
            taskId: run.taskId,
            at: new Date().toISOString(),
          });
        } catch (err) {
          // Preserve BOTH the run error and the move error (R10).
          log(
            `terminal move FAILED for ${inProgressPath} (outcome=${outcome}${errorMessage ? `, run error: ${errorMessage}` : ""}): ${err instanceof Error ? err.message : String(err)}`,
          );
        } finally {
          run.finished = true;
        }
      })();
    activeRun = run;
    log(`launched run for ${name} (protocol=${protocol}, intake=${intakeId})`);
  }

  /** Try to claim exactly one settled drop for this protocol. Returns true
   * when the slot was filled. */
  async function claimOne(protocol: string, watchRoot: string): Promise<boolean> {
    const incomingDir = join(watchRoot, "incoming");
    for (const drop of trackerFor(protocol).poll(incomingDir)) {
      const intakeId = randomUUID().slice(0, 8);
      const storedName = `${Date.now()}-${intakeId}-${drop.name}`;
      const fromPath = join(incomingDir, drop.name);
      const toPath = join(watchRoot, "in-progress", storedName);
      const claimed = await claimDrop(fromPath, toPath);
      if (!claimed) {
        log(`lost claim race for ${fromPath}; skipping`);
        continue;
      }

      // R3: re-signature after the claim — if the drop changed between the
      // settle observation and the rename, it wasn't finished; put it back.
      const now = signatureOf(toPath);
      if (now !== drop.signature) {
        log(`${drop.name} changed between settle and claim; returning to incoming/`);
        await rename(toPath, fromPath);
        continue;
      }

      // Consume the producer's sentinel so it doesn't dangle in incoming/.
      if (drop.sentinel) {
        await rm(join(incomingDir, `${drop.name}${COMPLETE_SENTINEL_SUFFIX}`), { force: true });
      }

      log(`claimed ${drop.name} → in-progress/${storedName}`);
      launchRun(protocol, watchRoot, drop.name, storedName, intakeId);
      return true;
    }
    return false;
  }

  async function buildStatus(
    desired: WatcherStatusFile["desired"],
    state: WatcherStatusFile["state"],
    protocols: Record<string, string>,
    configError: string | null,
  ): Promise<WatcherStatusFile> {
    const protocolStatuses: Record<string, WatcherProtocolStatus> = {};
    for (const [protocol, watchRoot] of Object.entries(protocols)) {
      protocolStatuses[protocol] = {
        watchRoot,
        counts: await countStateDirs(watchRoot),
        lastDrop: lastDrops.get(protocol) ?? null,
        error: protocolErrors.get(protocol) ?? null,
      };
    }
    const active: WatcherActiveDrop | null = activeRun
      ? {
          protocol: activeRun.protocol,
          name: activeRun.name,
          intakeId: activeRun.intakeId,
          taskId: activeRun.taskId,
          claimedAt: activeRun.claimedAt,
        }
      : null;
    return {
      desired,
      state,
      pid: process.pid,
      since,
      lastHeartbeat: new Date().toISOString(),
      pollIntervalMs,
      activeDrop: active,
      configError,
      protocols: protocolStatuses,
    };
  }

  async function reconcileOnce(): Promise<ReconcileResult> {
    // Re-entrancy guard (R2): overlapping ticks in one process skip, they
    // never double-claim.
    if (ticking) return { leaseHeld: true, skipped: true, status: null };
    ticking = true;
    try {
      // R2: everything below — claims, drains, status writes — is lease-
      // holder-only. Losing the lease means another supervisor owns the
      // project; do nothing at all.
      const leaseHeld = await acquireOrRefreshLease(tasksRoot, leaseUuid, leaseStaleMs);
      if (!leaseHeld) {
        log("another supervisor holds control/watcher.lock; idling");
        return { leaseHeld: false, skipped: false, status: null };
      }

      if (!seededFromDisk) await seedLastDrops();

      // Harvest the finished background run before anything else so its
      // terminal counts and lastDrop appear in this tick's heartbeat.
      if (activeRun?.finished) activeRun = null;

      const control = await readWatcherControl(tasksRoot);
      let configError: string | null = null;
      let desired: WatcherStatusFile["desired"] = "stopped";
      let controlProtocols: Readonly<Record<string, { readonly watchRoot: string }>> = {};
      if (control === null) {
        // Absent control file = fail closed to stopped (nothing to ingest
        // until the dashboard/CLI writes a desired state).
        desired = "stopped";
      } else if (!control.ok) {
        // R11: malformed control file → fail closed, surface in status.
        configError = `control/watcher.json is invalid: ${control.errors
          .map((e) => `${e.path} ${e.message}`)
          .join("; ")}`;
        log(configError);
        desired = "stopped";
      } else {
        desired = control.value.desired;
        controlProtocols = control.value.protocols;
      }

      const protocols = effectiveProtocols(controlProtocols);

      if (desired === "running") {
        for (const [protocol, watchRoot] of Object.entries(protocols)) {
          // R10: one protocol's problem never aborts the others.
          try {
            const invalid = await validateWatchRoot(watchRoot);
            if (invalid !== null) {
              if (protocolErrors.get(protocol) !== invalid) log(`protocol ${protocol}: ${invalid}`);
              protocolErrors.set(protocol, invalid);
              continue;
            }
            protocolErrors.delete(protocol);

            if (!quarantined.has(protocol)) {
              await quarantineStranded(protocol, watchRoot);
              quarantined.add(protocol);
            }

            // One-slot worker (R4): claim only when idle.
            if (activeRun === null) {
              await claimOne(protocol, watchRoot);
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            protocolErrors.set(protocol, message);
            log(`protocol ${protocol} tick failed: ${message}`);
          }
        }
      }

      const state: WatcherStatusFile["state"] =
        desired === "running" ? "running" : activeRun !== null ? "stopping" : "stopped";

      const status = await buildStatus(desired, state, protocols, configError);
      await writeWatcherStatus(tasksRoot, status);
      return { leaseHeld: true, skipped: false, status };
    } finally {
      ticking = false;
    }
  }

  async function waitForIdle(): Promise<void> {
    while (activeRun !== null && !activeRun.finished) {
      await activeRun.promise;
    }
  }

  async function run(signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      try {
        await reconcileOnce();
      } catch (err) {
        // A tick failing (e.g. control dir unwritable) must not kill the
        // daemon — log and retry next interval.
        log(`reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (signal?.aborted) break;
      await new Promise<void>((resolveSleep) => {
        const timer = setTimeout(resolveSleep, pollIntervalMs);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolveSleep();
          },
          { once: true },
        );
      });
    }
    // Graceful stop (R4): finish the active run, claim nothing new, then
    // write the final stopped heartbeat and hand back the lease.
    await waitForIdle();
    if (activeRun?.finished) activeRun = null;
    try {
      const control = await readWatcherControl(tasksRoot);
      const protocols = effectiveProtocols(
        control !== null && control.ok ? control.value.protocols : {},
      );
      const status = await buildStatus(
        control !== null && control.ok ? control.value.desired : "stopped",
        "stopped",
        protocols,
        null,
      );
      await writeWatcherStatus(tasksRoot, status);
    } finally {
      await releaseLease(tasksRoot, leaseUuid);
    }
  }

  return { reconcileOnce, waitForIdle, run };
}
