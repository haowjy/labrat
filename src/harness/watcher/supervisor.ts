import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { LabratConfig } from "../../config/index.js";
import {
  acquireOrRefreshLease,
  controlDir,
  countStateDirs,
  FAILURE_RECORD_SUFFIX,
  holdsLease,
  readWatcherControl,
  readWatcherStatus,
  releaseLease,
  WATCH_STATE_DIRS,
  writeWatcherStatus,
} from "../../control/index.js";
import {
  watchRootPathError,
  type TaskState,
  type WatcherActiveDrop,
  type WatcherDropRef,
  type WatcherFailureRecord,
  type WatcherProtocolStatus,
  type WatcherStatusFile,
} from "../../schema/index.js";
import { atomicWriteJson } from "../../util/atomic-write.js";
import {
  COMPLETE_SENTINEL_SUFFIX,
  createSettleTracker,
  DEFAULT_DEBOUNCE_MS,
  signatureOf,
  type SettleTracker,
} from "./index.js";

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
  /** Drop is settled after this long with no change. Default
   * {@link DEFAULT_DEBOUNCE_MS} — deliberately conservative; producers
   * should stage-then-atomically-rename into `incoming/` (or write a
   * `.complete` sentinel) rather than rely on the debounce. */
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

/**
 * Roll a claimed-but-not-complete drop back to `incoming/` under its UNIQUE
 * stored name — never the original basename: a new same-basename arrival
 * may already be landing there, and a plain rename-back would overwrite it
 * (or strand that arrival's `.complete` sentinel against the wrong bytes).
 * The uniquely named drop simply re-enters settle detection.
 */
export async function returnToIncoming(
  claimedPath: string,
  incomingDir: string,
  storedName: string,
): Promise<void> {
  await rename(claimedPath, join(incomingDir, storedName));
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
  } catch (err) {
    // A missing dir has nothing to list; any OTHER readdir failure must
    // SURFACE (the caller retries next tick) — converting it to "empty"
    // would let startup mark a protocol quarantine-scanned without ever
    // scanning it, stranding in-progress/ entries forever.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** True when one path equals or contains the other (after resolution). */
function pathsOverlap(a: string, b: string): boolean {
  const ra = resolve(a);
  const rb = resolve(b);
  return ra === rb || ra.startsWith(rb + sep) || rb.startsWith(ra + sep);
}

/** Validate a protocol's watchRoot: the shared shape rule (absolute +
 * nonempty — the same `watchRootPathError` every config layer applies), no
 * overlap with the harness's own trees (tasks/control/scienceHome), then
 * R8/R9: create the four state dirs, require every dir (and the root) to be
 * a REAL directory — not a symlink — and require all five to sit on the
 * SAME filesystem so the atomic-rename claim can never degrade to
 * copy-and-delete. Returns an error string (fail closed for this protocol)
 * or null. */
async function validateWatchRoot(
  watchRoot: string,
  reserved: ReadonlyArray<{ readonly label: string; readonly path: string }>,
): Promise<string | null> {
  const shapeError = watchRootPathError(watchRoot);
  if (shapeError !== null) return shapeError;
  for (const { label, path } of reserved) {
    if (pathsOverlap(watchRoot, path)) {
      return `watchRoot ${watchRoot} overlaps the ${label} (${path}); choose a directory outside the harness's own trees`;
    }
  }
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
    debounceMs = DEFAULT_DEBOUNCE_MS,
    pollIntervalMs = 1000,
    log = () => {},
  } = options;
  const enqueue: EnqueueFn =
    options.enqueue ?? ((inputAbs, protocol) => defaultEnqueue(inputAbs, protocol, tasksRoot, config));

  const leaseUuid = randomUUID();
  const leaseStaleMs = pollIntervalMs * STALE_HEARTBEAT_FACTOR;
  const since = new Date().toISOString();

  /** The harness's own trees — a watchRoot must never overlap these. */
  const reservedPaths = [
    { label: "tasks dir", path: tasksRoot },
    { label: "control dir", path: controlDir(tasksRoot) },
    { label: "science home", path: config.scienceHome },
  ] as const;

  const trackers = new Map<string, SettleTracker>();
  const lastDrops = new Map<string, WatcherDropRef>();
  const protocolErrors = new Map<string, string>();
  /** Durable terminal-move failures (F3/R6/R10): a drop whose run finished
   * but whose rename to done/|failed/ failed is STRANDED in in-progress/ —
   * the error stays surfaced until a supervisor restart quarantines it
   * (R1); it is never auto-cleared by a later healthy validation pass. */
  const moveErrors = new Map<string, string>();
  // DEFERRED (multi-supervisor): key quarantine init by resolved root
  // identity (dev:ino), not protocol name, so switching a protocol's
  // watchRoot re-quarantines the new root's stranded entries.
  const quarantined = new Set<string>();
  let activeRun: ActiveRun | null = null;
  let ticking = false;
  let seededFromDisk = false;
  /** Graceful-shutdown mode (R4/F2): claim nothing new, but keep the
   * control loop heartbeating — the lease must stay fresh while the active
   * run finishes. */
  let shuttingDown = false;

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
   * invariant violation: it THROWS (like any other move failure) so the
   * caller records it durably and leaves the drop where it is (a restart
   * quarantines it) rather than publish a terminal state that contradicts
   * disk. NOTE: exists+rename is not atomic — node has no no-replace
   * rename; the unique `<ts>-<intakeId>-` names make a lost race
   * astronomically unlikely, and full atomicity is part of the deferred
   * multi-supervisor fencing work. */
  async function moveToTerminal(
    fromPath: string,
    watchRoot: string,
    outcome: "done" | "failed",
    storedName: string,
  ): Promise<void> {
    const dest = join(watchRoot, outcome, storedName);
    if (await exists(dest)) {
      throw new Error(
        `INVARIANT: terminal destination ${dest} already exists; refusing to overwrite`,
      );
    }
    await rename(fromPath, dest);
  }

  /** R1: startup quarantine. Anything already in `in-progress/` when this
   * supervisor first sees a protocol is a crashed run whose execution state
   * is unknown — move it to `failed/` with a reason record; NEVER re-enqueue
   * (that would allocate a duplicate task for the same scan). */
  async function quarantineStranded(protocol: string, watchRoot: string): Promise<void> {
    const inProgressDir = join(watchRoot, "in-progress");
    // NOTE: a listDrops failure here THROWS — the caller must not mark the
    // protocol quarantine-scanned on an unscanned directory (F7).
    for (const name of await listDrops(inProgressDir)) {
      const intakeId = randomUUID().slice(0, 8);
      const storedName = `${Date.now()}-${intakeId}-${name}`;
      try {
        await moveToTerminal(join(inProgressDir, name), watchRoot, "failed", storedName);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        moveErrors.set(protocol, `quarantine of stranded ${name} failed: ${message}`);
        log(`quarantine of stranded ${join(inProgressDir, name)} FAILED: ${message}`);
        continue; // Isolate: the other stranded entries still quarantine.
      }
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
          // DEFERRED (multi-supervisor/F8): an allocate/run split in the
          // orchestrator would let taskId populate here BEFORE the run
          // completes, so activeDrop.taskId shows mid-run.
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
          await moveToTerminal(inProgressPath, watchRoot, outcome, storedName);
          if (outcome === "failed") {
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
          // Terminal state is published ONLY here, after the disk move
          // succeeded (F3): status must never say done/failed while the
          // input still sits in in-progress/.
          lastDrops.set(protocol, {
            name,
            state: outcome,
            taskId: run.taskId,
            at: new Date().toISOString(),
          });
        } catch (err) {
          // The drop is stranded in in-progress/. Do NOT publish a terminal
          // state; preserve BOTH the run error and the move error (R10) —
          // durably in the status (moveErrors) and as a sidecar record next
          // to the stranded drop. Recovery = the next supervisor start
          // quarantines it (R1).
          const moveMessage = err instanceof Error ? err.message : String(err);
          const combined = `terminal move to ${outcome}/ failed: ${moveMessage}${
            errorMessage ? `; run error: ${errorMessage}` : ` (run outcome was ${outcome})`
          }`;
          moveErrors.set(protocol, `${storedName}: ${combined}`);
          log(`terminal move FAILED for ${inProgressPath}: ${combined}`);
          await writeFailureRecord(
            {
              intakeId,
              protocol,
              sourceName: name,
              storedName,
              error: combined,
              taskId: run.taskId,
              at: new Date().toISOString(),
            },
            join(watchRoot, "in-progress"),
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

      // R3/R8: re-check AFTER the claim — both completeness (signature) and
      // content (a non-regular entry injected between the settle observation
      // and the rename must still be rejected).
      const now = signatureOf(toPath);
      if (now === null) {
        log(`${drop.name} vanished between settle and claim; skipping`);
        continue;
      }
      if (now.nonRegular !== null) {
        // Tainted after settle: quarantine to failed/ with a record — it can
        // never become eligible, so returning it to incoming/ would loop.
        log(`${drop.name} contains non-regular entry ${now.nonRegular}; quarantining`);
        try {
          await moveToTerminal(toPath, watchRoot, "failed", storedName);
          await writeFailureRecord(
            {
              intakeId,
              protocol,
              sourceName: drop.name,
              storedName,
              error: `rejected: contains non-regular entry ${now.nonRegular}`,
              taskId: null,
              at: new Date().toISOString(),
            },
            join(watchRoot, "failed"),
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          moveErrors.set(protocol, `quarantine of ${storedName} failed: ${message}`);
          log(`quarantine of ${toPath} FAILED: ${message}`);
        }
        continue;
      }
      if (now.signature !== drop.signature) {
        // Changed between settle and claim — the producer wasn't finished.
        // Return it to incoming/ under its UNIQUE stored name (F5):
        // restoring the original basename could overwrite a new same-name
        // arrival (or orphan that arrival's .complete sentinel).
        log(
          `${drop.name} changed between settle and claim; returning to incoming/${storedName}`,
        );
        await returnToIncoming(toPath, incomingDir, storedName);
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
        // moveErrors are durable invariant failures (stranded drops) — they
        // outlive a later healthy validation pass, unlike protocolErrors.
        error: protocolErrors.get(protocol) ?? moveErrors.get(protocol) ?? null,
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

      // Graceful shutdown (F2): keep heartbeating (below) but claim
      // nothing new — the loop exists only to keep the lease fresh and the
      // `stopping` state visible while the active run finishes.
      if (desired === "running" && !shuttingDown) {
        for (const [protocol, watchRoot] of Object.entries(protocols)) {
          // R10: one protocol's problem never aborts the others.
          try {
            const invalid = await validateWatchRoot(watchRoot, reservedPaths);
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
        desired === "running" && !shuttingDown
          ? "running"
          : activeRun !== null
            ? "stopping"
            : "stopped";

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
    // Graceful stop (R4/F2): claim nothing new, but KEEP the control loop
    // alive — refreshing the lease and publishing `stopping` heartbeats —
    // until the active run finishes. A long run must never read as a
    // stale/abandoned daemon (which would invite a takeover that
    // quarantines the still-active input).
    shuttingDown = true;
    while (true) {
      // Snapshot: the awaited reconcileOnce() below can null out the
      // closure's activeRun, so re-reading it after the await would race.
      const run = activeRun;
      if (run === null || run.finished) break;
      try {
        await reconcileOnce();
      } catch (err) {
        log(`shutdown tick failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      await Promise.race([
        run.promise,
        new Promise<void>((r) => setTimeout(r, pollIntervalMs)),
      ]);
    }
    if (activeRun?.finished) activeRun = null;
    // Final stopped write + lease release are OWNERSHIP-VERIFIED (F2): if
    // another supervisor took the lease meanwhile, its status and lease are
    // not ours to overwrite or delete.
    if (!(await holdsLease(tasksRoot, leaseUuid))) {
      log("lease not held at shutdown; skipping final status write");
      return;
    }
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
