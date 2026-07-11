/**
 * Trust-boundary enforcement for the gate reviewer (design §10).
 *
 * The reviewer's independence is not just a prompt instruction — the harness
 * hashes everything the reviewer must not touch (`artifacts/`, ALL of
 * `phases/`, `task.json`, `review/gates/`, `review/verdict/`,
 * `review/monitor/`, `provenance/manifest.yaml`)
 * before the reviewer session and verifies nothing changed after. The
 * reviewer may only write under `review/verification/{phase}/`, which is
 * deliberately excluded from the snapshot.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

export type FileHashMap = ReadonlyMap<string, string>;

export function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/** Hash a single file, or return undefined if it doesn't exist (yet). */
async function hashFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await hashFile(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

async function walk(
  dir: string,
  base: string,
  out: Map<string, string>,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw err;
  }

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, base, out);
    } else if (entry.isFile()) {
      const rel = relative(base, full);
      out.set(rel, await hashFile(full));
    }
  }
}

/** Recursively hash every file under `dir`, keyed by path relative to `dir`. */
export async function hashDirectory(dir: string): Promise<FileHashMap> {
  const out = new Map<string, string>();
  await walk(dir, dir, out);
  return out;
}

export type TrustBoundarySnapshot = {
  readonly artifacts: FileHashMap;
  /** ALL of phases/ — every phase dir, not just the one under gate. */
  readonly phases: FileHashMap;
  readonly reviewGates: FileHashMap;
  /** `review/verdict/` — human verdicts; a reviewer writing one forges a human decision. */
  readonly reviewVerdict: FileHashMap;
  readonly reviewMonitor: FileHashMap;
  readonly taskJson: string | undefined;
  readonly provenanceManifest: string | undefined;
};

/**
 * Snapshot everything the reviewer must not touch, immediately before a
 * reviewer session: `artifacts/`, ALL of `phases/`, `review/gates/`,
 * `review/verdict/`, `review/monitor/`, `task.json`,
 * `provenance/manifest.yaml`. Deliberately excludes
 * `review/verification/{phase}/`, the reviewer's one legal write area.
 */
export async function snapshotTrustBoundary(
  taskDir: string,
): Promise<TrustBoundarySnapshot> {
  const [artifacts, phases, reviewGates, reviewVerdict, reviewMonitor, taskJson, provenanceManifest] =
    await Promise.all([
      hashDirectory(join(taskDir, "artifacts")),
      hashDirectory(join(taskDir, "phases")),
      hashDirectory(join(taskDir, "review", "gates")),
      hashDirectory(join(taskDir, "review", "verdict")),
      hashDirectory(join(taskDir, "review", "monitor")),
      hashFileIfExists(join(taskDir, "task.json")),
      hashFileIfExists(join(taskDir, "provenance", "manifest.yaml")),
    ]);
  return { artifacts, phases, reviewGates, reviewVerdict, reviewMonitor, taskJson, provenanceManifest };
}

export type TrustBoundaryViolation = {
  readonly area:
    | "artifacts"
    | "phases"
    | "review-gates"
    | "review-verdict"
    | "review-monitor"
    | "task-json"
    | "provenance-manifest";
  readonly path: string;
  readonly kind: "added" | "removed" | "modified";
};

export type TrustBoundaryResult = {
  readonly ok: boolean;
  readonly violations: readonly TrustBoundaryViolation[];
  readonly checkedAt: string;
};

function diffMaps(
  area: TrustBoundaryViolation["area"],
  before: FileHashMap,
  after: FileHashMap,
  out: TrustBoundaryViolation[],
): void {
  for (const [path, hash] of before) {
    const nowHash = after.get(path);
    if (nowHash === undefined) {
      out.push({ area, path, kind: "removed" });
    } else if (nowHash !== hash) {
      out.push({ area, path, kind: "modified" });
    }
  }
  for (const path of after.keys()) {
    if (!before.has(path)) {
      out.push({ area, path, kind: "added" });
    }
  }
}

function diffSingleFile(
  area: TrustBoundaryViolation["area"],
  path: string,
  before: string | undefined,
  after: string | undefined,
  out: TrustBoundaryViolation[],
): void {
  if (before === after) return;
  if (before === undefined) {
    out.push({ area, path, kind: "added" });
  } else if (after === undefined) {
    out.push({ area, path, kind: "removed" });
  } else {
    out.push({ area, path, kind: "modified" });
  }
}

/** Compare pre/post snapshots — any diff outside review/verification/{phase}/ is a violation. */
export function diffTrustBoundary(
  before: TrustBoundarySnapshot,
  after: TrustBoundarySnapshot,
): TrustBoundaryResult {
  const violations: TrustBoundaryViolation[] = [];
  diffMaps("artifacts", before.artifacts, after.artifacts, violations);
  diffMaps("phases", before.phases, after.phases, violations);
  diffMaps("review-gates", before.reviewGates, after.reviewGates, violations);
  diffMaps("review-verdict", before.reviewVerdict, after.reviewVerdict, violations);
  diffMaps("review-monitor", before.reviewMonitor, after.reviewMonitor, violations);
  diffSingleFile("task-json", "task.json", before.taskJson, after.taskJson, violations);
  diffSingleFile(
    "provenance-manifest",
    "provenance/manifest.yaml",
    before.provenanceManifest,
    after.provenanceManifest,
    violations,
  );
  return {
    ok: violations.length === 0,
    violations,
    checkedAt: new Date().toISOString(),
  };
}

/** Snapshot both boundaries, run `fn`, then diff — the single entry point runGate uses. */
export async function enforceTrustBoundary<T>(
  taskDir: string,
  fn: () => Promise<T>,
): Promise<{ readonly result: T; readonly trustBoundary: TrustBoundaryResult }> {
  const before = await snapshotTrustBoundary(taskDir);
  const result = await fn();
  const after = await snapshotTrustBoundary(taskDir);
  return { result, trustBoundary: diffTrustBoundary(before, after) };
}
