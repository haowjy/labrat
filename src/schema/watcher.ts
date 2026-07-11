import { isAbsolute } from "node:path";
import {
  expectEnum,
  expectIsoDateTime,
  expectNonEmptyString,
  expectNumber,
  expectOptional,
  expectRecord,
  singleError,
  success,
  type ValidationResult,
} from "./validation.js";

/**
 * Folder-watch control-plane shapes (watcher-control-panel contract, rev v2).
 *
 * Three files at the project-root `control/` dir (a sibling of `tasks/`):
 *   - `watcher.json`        — DESIRED state: dashboard writes, supervisor reads.
 *   - `watcher-status.json` — STATUS/heartbeat: supervisor writes, dashboard reads.
 *   - `watcher.lock`        — single-supervisor lease (contract R2).
 *
 * The per-protocol state folders under each `watchRoot`
 * (`incoming/ → in-progress/ → done/ | failed/`) ARE the durable queue; these
 * files only carry desired state and a heartbeat, never queue entries.
 *
 * NOTE (R4): writing `desired: "running"` does not launch a daemon — a file
 * cannot start a process. `labrat watch` must already be running; the desired
 * flag ENABLES/DISABLES ingestion, and readers must treat a stale
 * `lastHeartbeat` as "daemon offline", never as running.
 */

export const WATCHER_DESIRED_STATES = ["running", "stopped"] as const;
export type WatcherDesiredState = (typeof WATCHER_DESIRED_STATES)[number];

/** Supervisor run state: `stopping` = desired stopped but the active run is
 * being finished gracefully (contract R4). */
export const WATCHER_RUN_STATES = ["running", "stopping", "stopped"] as const;
export type WatcherRunState = (typeof WATCHER_RUN_STATES)[number];

export const WATCHER_DROP_STATES = ["in-progress", "done", "failed"] as const;
export type WatcherDropState = (typeof WATCHER_DROP_STATES)[number];

/** `control/watcher.json` — desired state, written by the dashboard. */
export type WatcherControlFile = {
  readonly desired: WatcherDesiredState;
  readonly protocols: Readonly<Record<string, { readonly watchRoot: string }>>;
};

/** `POST /api/watcher` body — a partial merge onto {@link WatcherControlFile}. */
export type WatcherControlPatch = {
  readonly desired?: WatcherDesiredState;
  readonly protocols?: Readonly<Record<string, { readonly watchRoot: string }>>;
};

/** The latest CLAIMED drop for a protocol (contract R11); `taskId` is
 * populated once known, `name` is the original display name (R6). */
export type WatcherDropRef = {
  readonly name: string;
  readonly state: WatcherDropState;
  readonly taskId: string | null;
  readonly at: string;
};

export type WatcherFolderCounts = {
  readonly incoming: number;
  readonly inProgress: number;
  readonly done: number;
  readonly failed: number;
};

export type WatcherProtocolStatus = {
  readonly watchRoot: string;
  readonly counts: WatcherFolderCounts;
  readonly lastDrop: WatcherDropRef | null;
  /** Per-protocol config/validation error (R9/R10) — e.g. state dirs on
   * different filesystems. null = healthy. */
  readonly error: string | null;
};

/** The drop currently being run by the one-slot worker (contract R4). */
export type WatcherActiveDrop = {
  readonly protocol: string;
  readonly name: string;
  readonly intakeId: string;
  readonly taskId: string | null;
  readonly claimedAt: string;
};

/** `control/watcher-status.json` — heartbeat, written by the supervisor.
 * Freshness is `lastHeartbeat` against `pollIntervalMs` (readers derive
 * health; a stale file reads as offline, not running — R10). */
export type WatcherStatusFile = {
  readonly desired: WatcherDesiredState;
  readonly state: WatcherRunState;
  readonly pid: number;
  readonly since: string;
  readonly lastHeartbeat: string;
  readonly pollIntervalMs: number;
  readonly activeDrop: WatcherActiveDrop | null;
  /** Top-level control-file problem (malformed watcher.json → fail closed, R11). */
  readonly configError: string | null;
  readonly protocols: Readonly<Record<string, WatcherProtocolStatus>>;
};

/** Structured failure record persisted next to a quarantined/failed drop
 * (`failed/<storedName>.error.json`, contract R10). */
export type WatcherFailureRecord = {
  readonly intakeId: string;
  readonly protocol: string;
  readonly sourceName: string;
  readonly storedName: string;
  readonly error: string;
  readonly taskId: string | null;
  readonly at: string;
};

/** Validate a `{ <protocol>: { watchRoot } }` map. Rejects empty or
 * non-absolute watchRoots — a relative root would silently anchor to whatever
 * cwd the supervisor happens to run from. */
function validateProtocolsMap(
  value: unknown,
  path: string,
): ValidationResult<Record<string, { readonly watchRoot: string }>> {
  const rec = expectRecord(value, path);
  if (!rec.ok) return rec;
  const out: Record<string, { watchRoot: string }> = {};
  for (const [id, entry] of Object.entries(rec.value)) {
    const entryRec = expectRecord(entry, `${path}.${id}`);
    if (!entryRec.ok) return entryRec;
    const watchRoot = expectNonEmptyString(
      entryRec.value["watchRoot"],
      `${path}.${id}.watchRoot`,
    );
    if (!watchRoot.ok) return watchRoot;
    if (!isAbsolute(watchRoot.value)) {
      return singleError(
        `${path}.${id}.watchRoot`,
        "expected an absolute path",
      );
    }
    out[id] = { watchRoot: watchRoot.value };
  }
  return success(out);
}

export function validateWatcherControlFile(
  value: unknown,
): ValidationResult<WatcherControlFile> {
  const rec = expectRecord(value, "$");
  if (!rec.ok) return rec;

  const desired = expectEnum(rec.value["desired"], "$.desired", WATCHER_DESIRED_STATES);
  if (!desired.ok) return desired;

  const protocols = validateProtocolsMap(rec.value["protocols"], "$.protocols");
  if (!protocols.ok) return protocols;

  return success({ desired: desired.value, protocols: protocols.value });
}

/** Validate the `POST /api/watcher` body — both keys optional, same rules. */
export function validateWatcherControlPatch(
  value: unknown,
): ValidationResult<WatcherControlPatch> {
  const rec = expectRecord(value, "$");
  if (!rec.ok) return rec;

  const desired = expectOptional(rec.value["desired"], "$.desired", (v, p) =>
    expectEnum(v, p, WATCHER_DESIRED_STATES),
  );
  if (!desired.ok) return desired;

  const protocols = expectOptional(rec.value["protocols"], "$.protocols", (v, p) =>
    validateProtocolsMap(v, p),
  );
  if (!protocols.ok) return protocols;

  if (desired.value === undefined && protocols.value === undefined) {
    return singleError("$", "expected at least one of desired, protocols");
  }

  return success({
    ...(desired.value !== undefined ? { desired: desired.value } : {}),
    ...(protocols.value !== undefined ? { protocols: protocols.value } : {}),
  });
}

function validateDropRef(
  value: unknown,
  path: string,
): ValidationResult<WatcherDropRef> {
  const rec = expectRecord(value, path);
  if (!rec.ok) return rec;
  const name = expectNonEmptyString(rec.value["name"], `${path}.name`);
  if (!name.ok) return name;
  const state = expectEnum(rec.value["state"], `${path}.state`, WATCHER_DROP_STATES);
  if (!state.ok) return state;
  const taskId = expectNullableString(rec.value["taskId"], `${path}.taskId`);
  if (!taskId.ok) return taskId;
  const at = expectIsoDateTime(rec.value["at"], `${path}.at`);
  if (!at.ok) return at;
  return success({ name: name.value, state: state.value, taskId: taskId.value, at: at.value });
}

function expectNullableString(
  value: unknown,
  path: string,
): ValidationResult<string | null> {
  if (value === null || value === undefined) return success(null);
  return expectNonEmptyString(value, path);
}

function validateActiveDrop(
  value: unknown,
  path: string,
): ValidationResult<WatcherActiveDrop> {
  const rec = expectRecord(value, path);
  if (!rec.ok) return rec;
  const protocol = expectNonEmptyString(rec.value["protocol"], `${path}.protocol`);
  if (!protocol.ok) return protocol;
  const name = expectNonEmptyString(rec.value["name"], `${path}.name`);
  if (!name.ok) return name;
  const intakeId = expectNonEmptyString(rec.value["intakeId"], `${path}.intakeId`);
  if (!intakeId.ok) return intakeId;
  const taskId = expectNullableString(rec.value["taskId"], `${path}.taskId`);
  if (!taskId.ok) return taskId;
  const claimedAt = expectIsoDateTime(rec.value["claimedAt"], `${path}.claimedAt`);
  if (!claimedAt.ok) return claimedAt;
  return success({
    protocol: protocol.value,
    name: name.value,
    intakeId: intakeId.value,
    taskId: taskId.value,
    claimedAt: claimedAt.value,
  });
}

export function validateWatcherStatusFile(
  value: unknown,
): ValidationResult<WatcherStatusFile> {
  const rec = expectRecord(value, "$");
  if (!rec.ok) return rec;

  const desired = expectEnum(rec.value["desired"], "$.desired", WATCHER_DESIRED_STATES);
  if (!desired.ok) return desired;

  const state = expectEnum(rec.value["state"], "$.state", WATCHER_RUN_STATES);
  if (!state.ok) return state;

  const pid = expectNumber(rec.value["pid"], "$.pid");
  if (!pid.ok) return pid;

  const since = expectIsoDateTime(rec.value["since"], "$.since");
  if (!since.ok) return since;

  const lastHeartbeat = expectIsoDateTime(rec.value["lastHeartbeat"], "$.lastHeartbeat");
  if (!lastHeartbeat.ok) return lastHeartbeat;

  const pollIntervalMs = expectNumber(rec.value["pollIntervalMs"], "$.pollIntervalMs");
  if (!pollIntervalMs.ok) return pollIntervalMs;

  let activeDrop: WatcherActiveDrop | null = null;
  if (rec.value["activeDrop"] !== null && rec.value["activeDrop"] !== undefined) {
    const drop = validateActiveDrop(rec.value["activeDrop"], "$.activeDrop");
    if (!drop.ok) return drop;
    activeDrop = drop.value;
  }

  const configError = expectNullableString(rec.value["configError"], "$.configError");
  if (!configError.ok) return configError;

  const protocolsRec = expectRecord(rec.value["protocols"], "$.protocols");
  if (!protocolsRec.ok) return protocolsRec;
  const protocols: Record<string, WatcherProtocolStatus> = {};
  for (const [id, entry] of Object.entries(protocolsRec.value)) {
    const path = `$.protocols.${id}`;
    const entryRec = expectRecord(entry, path);
    if (!entryRec.ok) return entryRec;
    const watchRoot = expectNonEmptyString(entryRec.value["watchRoot"], `${path}.watchRoot`);
    if (!watchRoot.ok) return watchRoot;
    const countsRec = expectRecord(entryRec.value["counts"], `${path}.counts`);
    if (!countsRec.ok) return countsRec;
    const counts: Partial<Record<keyof WatcherFolderCounts, number>> = {};
    for (const key of ["incoming", "inProgress", "done", "failed"] as const) {
      const n = expectNumber(countsRec.value[key], `${path}.counts.${key}`);
      if (!n.ok) return n;
      counts[key] = n.value;
    }
    let lastDrop: WatcherDropRef | null = null;
    if (entryRec.value["lastDrop"] !== null && entryRec.value["lastDrop"] !== undefined) {
      const drop = validateDropRef(entryRec.value["lastDrop"], `${path}.lastDrop`);
      if (!drop.ok) return drop;
      lastDrop = drop.value;
    }
    const error = expectNullableString(entryRec.value["error"], `${path}.error`);
    if (!error.ok) return error;
    protocols[id] = {
      watchRoot: watchRoot.value,
      counts: counts as WatcherFolderCounts,
      lastDrop,
      error: error.value,
    };
  }

  return success({
    desired: desired.value,
    state: state.value,
    pid: pid.value,
    since: since.value,
    lastHeartbeat: lastHeartbeat.value,
    pollIntervalMs: pollIntervalMs.value,
    activeDrop,
    configError: configError.value,
    protocols,
  });
}
