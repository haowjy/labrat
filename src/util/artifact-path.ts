import { join } from "node:path";

export type ResolvedArtifactPath = {
  /** Absolute on-disk path, with any trailing slash on the declared value stripped. */
  readonly absPath: string;
  /** Path as it appears in the provenance manifest / error messages, relative to the task dir. */
  readonly manifestPath: string;
};

/**
 * Canonical resolver for a protocol phase.inputs/outputs entry.
 *
 * `input/` (and anything under it) is relative to the task-dir root — the
 * staged DICOM. Everything else lives under `artifacts/`. This one contract is
 * consumed by provenance ref resolution, upstream-readiness checks, and
 * retry/rewind invalidation; keep it single-sourced so they cannot drift.
 */
export function resolveDeclaredArtifactPath(
  taskDir: string,
  declared: string,
): ResolvedArtifactPath {
  const isTaskRootRelative =
    declared === "input/" || declared.startsWith("input/");
  if (isTaskRootRelative) {
    return { absPath: join(taskDir, declared), manifestPath: declared };
  }
  return {
    absPath: join(taskDir, "artifacts", declared.replace(/\/+$/, "")),
    manifestPath: `artifacts/${declared}`,
  };
}
