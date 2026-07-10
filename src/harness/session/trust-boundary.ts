/**
 * Trust-boundary enforcement for the gate reviewer (design §10).
 *
 * The reviewer's independence is not just a prompt instruction — the harness
 * hashes `artifacts/` and `phases/{phase}/` before the reviewer session and
 * verifies nothing changed after. The reviewer may only write under
 * `review/verification/{phase}/`.
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
  readonly phase: FileHashMap;
};

/** Snapshot artifacts/ + phases/{phase}/ immediately before a reviewer session. */
export async function snapshotTrustBoundary(
  taskDir: string,
  phaseId: string,
): Promise<TrustBoundarySnapshot> {
  const [artifacts, phase] = await Promise.all([
    hashDirectory(join(taskDir, "artifacts")),
    hashDirectory(join(taskDir, "phases", phaseId)),
  ]);
  return { artifacts, phase };
}

export type TrustBoundaryViolation = {
  readonly area: "artifacts" | "phase";
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

/** Compare pre/post snapshots — any diff under artifacts/ or phases/{phase}/ is a violation. */
export function diffTrustBoundary(
  before: TrustBoundarySnapshot,
  after: TrustBoundarySnapshot,
): TrustBoundaryResult {
  const violations: TrustBoundaryViolation[] = [];
  diffMaps("artifacts", before.artifacts, after.artifacts, violations);
  diffMaps("phase", before.phase, after.phase, violations);
  return {
    ok: violations.length === 0,
    violations,
    checkedAt: new Date().toISOString(),
  };
}

/** Snapshot both boundaries, run `fn`, then diff — the single entry point runGate uses. */
export async function enforceTrustBoundary<T>(
  taskDir: string,
  phaseId: string,
  fn: () => Promise<T>,
): Promise<{ readonly result: T; readonly trustBoundary: TrustBoundaryResult }> {
  const before = await snapshotTrustBoundary(taskDir, phaseId);
  const result = await fn();
  const after = await snapshotTrustBoundary(taskDir, phaseId);
  return { result, trustBoundary: diffTrustBoundary(before, after) };
}
