/**
 * Progress/quiescence-based worker stall detection (modeled on meridian-cli's
 * Pi harness `is_quiescent()`): never run a stall clock while the worker is
 * observably producing; only evaluate on idle returns; bound by wall-clock
 * time and *consecutive no-progress* turns, not by a re-invocation ceiling.
 *
 * The pure decision lives in `classifyTurnOutcome` (unit-tested exhaustively);
 * all IO — running the query, snapshotting phases/<phase>/, checking
 * `isPhaseRecordable` — stays in the worker loop (functional core /
 * imperative shell).
 */

import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export type StallExhaustedReason =
  | "stall"              // Consecutive idle turns with no on-disk progress and no record_phase
  | "background-grace"   // Background work ran too long without record_phase
  | "time-budget"        // Phase exceeded the wall-clock budget
  | "iteration-cap";     // Absolute safety cap on query() re-invocations

/** Absolute safety cap on query() re-invocations per phase — a backstop
 * against a pathological tight loop, NOT a progress bound (a worker that
 * keeps producing on-disk progress is allowed to run right up to it). */
export const WORKER_ITERATION_CAP = 200;

export type TurnLimits = {
  /** Max consecutive no-progress idle turns before failing as a stall. */
  readonly workerStall: number;
  /** Max continuations while background tasks are still running. */
  readonly backgroundGraceRetries: number;
  /** Wall-clock budget for the whole phase (all query() continuations). */
  readonly wallClockMs: number;
  /** Absolute cap on query() re-invocations (see WORKER_ITERATION_CAP). */
  readonly iterationCap: number;
};

export type TurnInput = {
  /** Worker called the blocked tool this turn. */
  readonly blocked: boolean;
  /** Worker called record_phase this turn (explicit completion). */
  readonly phaseComplete: boolean;
  /** record_phase's acceptance check would pass right now (completion
   * fallback — the work is done even without the explicit tool call). */
  readonly recordable: boolean;
  readonly hasActiveBackgroundTasks: boolean;
  /** phases/<phase>/ changed since the prior turn's snapshot. */
  readonly progressed: boolean;
  /** Consecutive no-progress idle turns BEFORE this turn. */
  readonly noProgressCount: number;
  /** Background-grace continuations BEFORE this turn. */
  readonly bgGraceCount: number;
  readonly elapsedMs: number;
  /** 1-based ordinal of the query() that just returned. */
  readonly iteration: number;
  readonly limits: TurnLimits;
};

export type TurnDecision =
  | { readonly action: "return-blocked" }
  | {
      readonly action: "return-complete";
      readonly completedVia: "record_phase" | "outputs-present";
    }
  | {
      readonly action: "grace-continue";
      readonly bgGraceCount: number;
      /** Always 0: a background-grace period grants a fresh stall budget
       * afterward — waiting on observable work must not erode the
       * no-progress clock (progress-based intent, review finding 4). */
      readonly noProgressCount: number;
    }
  | { readonly action: "reminder-continue"; readonly noProgressCount: number }
  | { readonly action: "fail"; readonly reason: StallExhaustedReason };

/**
 * Pure per-turn decision, evaluated after each query() returns. Continuation
 * decisions carry the updated counter so the loop stays a dumb shell.
 */
export function classifyTurnOutcome(input: TurnInput): TurnDecision {
  if (input.blocked) {
    return { action: "return-blocked" };
  }
  if (input.phaseComplete) {
    return { action: "return-complete", completedVia: "record_phase" };
  }
  if (input.recordable) {
    return { action: "return-complete", completedVia: "outputs-present" };
  }

  // Backstops (replace the old maxTotalTurns ceiling): generous bounds that
  // only trip when something is genuinely wrong — completion above always wins.
  if (input.elapsedMs > input.limits.wallClockMs) {
    return { action: "fail", reason: "time-budget" };
  }
  if (input.iteration >= input.limits.iterationCap) {
    return { action: "fail", reason: "iteration-cap" };
  }

  // Observable outstanding work keeps the phase alive (bounded grace).
  if (input.hasActiveBackgroundTasks) {
    const next = input.bgGraceCount + 1;
    if (next > input.limits.backgroundGraceRetries) {
      return { action: "fail", reason: "background-grace" };
    }
    return { action: "grace-continue", bgGraceCount: next, noProgressCount: 0 };
  }

  // On-disk progress resets the stall clock — no ceiling while progressing.
  if (input.progressed) {
    return { action: "reminder-continue", noProgressCount: 0 };
  }

  const next = input.noProgressCount + 1;
  if (next > input.limits.workerStall) {
    return { action: "fail", reason: "stall" };
  }
  return { action: "reminder-continue", noProgressCount: next };
}

/** Map of file path (relative to phases/<phase>/) → `${size}:${mtimeMs}`. */
export type PhaseDirSnapshot = Readonly<Record<string, string>>;

/**
 * Recursive snapshot of phases/<phase>/ used as the progress signal between
 * idle turns. A missing phase dir yields an empty snapshot (turn 1 before the
 * worker writes anything); files that vanish mid-walk are skipped.
 */
export async function snapshotPhaseDir(
  taskDir: string,
  phaseId: string,
): Promise<PhaseDirSnapshot> {
  const root = path.join(taskDir, "phases", phaseId);
  let entries;
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true });
  } catch {
    return {};
  }

  const snapshot: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const fullPath = path.join(entry.parentPath, entry.name);
    try {
      const info = await stat(fullPath);
      snapshot[path.relative(root, fullPath)] = `${info.size}:${info.mtimeMs}`;
    } catch {
      // File removed between readdir and stat — treat as absent.
    }
  }
  return snapshot;
}

export function snapshotsEqual(
  a: PhaseDirSnapshot,
  b: PhaseDirSnapshot,
): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) {
    return false;
  }
  return aKeys.every((key) => a[key] === b[key]);
}
