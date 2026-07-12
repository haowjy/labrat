import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { LabratConfig } from "../../config/index.js";
import {
  resolveReviewArtifact,
  validateGateFile,
  validateReviewArtifactStatus,
  type ProtocolPhase,
  type ProvenanceManifestEntry,
  type ReviewArtifactStatus,
  type ReviewArtifactType,
} from "../../schema/index.js";
import { atomicWriteJson } from "../../util/atomic-write.js";
import { notifyEvent } from "../events/index.js";
import type { LoadedProtocol } from "../protocol-loader/index.js";
import { findRegistrySkillDir } from "../protocol-loader/resolve.js";
import {
  appendManifestEntry,
  readProvenanceManifest,
} from "../provenance/index.js";
import { resolveReviewTemplateDir } from "../review-artifact/templates.js";
import type { RuntimeHandle } from "../runtime-setup/types.js";
import {
  runReviewArtifactAuthor,
  type AuthorSessionConfig,
  type AuthorSessionResult,
} from "../session/review-artifact-author.js";
import { runReviewArtifactCheckAtPath } from "./review-artifact-check.js";

/**
 * Review-artifact settlement (review-provenance design §3.D "Orchestration and
 * settlement"). The scientific gate pass and the artifact publication are two
 * ORDERED substates of phase settlement: this module owns the second — seed a
 * staging dir from the vendored template, run a fresh author session, gate the
 * result with the deterministic per-phase linter, and atomically publish.
 *
 * THE invariant (design correction #3): an author/linter failure NEVER
 * invalidates verified science. This module never calls archiveAndResetPhase,
 * never touches `phases/<phase>/` or the phase's verified `artifacts/`, and
 * reports exhaustion as `kind: "artifact-failed"` — which runTask handles as a
 * clean PAUSE (reason `review-artifact-author-failed`), not a gate FAIL.
 */

export const REVIEW_ARTIFACT_AUTHOR_PAUSE_REASON = "review-artifact-author-failed";

/** The registry skill whose vendored templates seed the author's staging dir. */
const AUTHOR_SKILL_NAME = "review-artifact-builder";

export type ArtifactSettlementContext = {
  readonly taskId: string;
  readonly taskDir: string;
  readonly protocol: LoadedProtocol;
  readonly phase: ProtocolPhase;
  /** Scientific phase attempt (1 on first run). */
  readonly attempt: number;
  readonly runtime: RuntimeHandle;
  readonly config: LabratConfig;
};

export type AuthorRunner = (
  config: AuthorSessionConfig,
) => Promise<AuthorSessionResult>;

export type SettleArtifactResult =
  | { readonly kind: "none" }
  | {
      readonly kind: "published";
      readonly authorSessionId: string;
      readonly authorAttempt: number;
      readonly type: Exclude<ReviewArtifactType, "none">;
      /** Relative to the task dir. */
      readonly publishedPath: string;
      readonly artifactHash: string;
      /** Relative to the task dir. */
      readonly checkReportPath: string;
      readonly checkReportHash: string;
    }
  | { readonly kind: "artifact-failed"; readonly reason: string };

// ---------------------------------------------------------------------------
// Paths + status file
// ---------------------------------------------------------------------------

export function publishedReviewSiteDir(taskDir: string, phaseId: string): string {
  return join(taskDir, "artifacts", "review-sites", phaseId);
}

export function stagingReviewSiteDir(
  taskDir: string,
  phaseId: string,
  authorAttempt: number,
): string {
  return join(
    taskDir,
    "artifacts",
    "review-sites",
    ".staging",
    phaseId,
    String(authorAttempt),
  );
}

export function artifactStatusPath(taskDir: string, phaseId: string): string {
  return join(taskDir, "review", "artifact-author", phaseId, "status.json");
}

function authorAttemptDir(taskDir: string, phaseId: string, attempt: number): string {
  return join(taskDir, "review", "artifact-author", phaseId, `attempt-${attempt}`);
}

export async function readArtifactStatus(
  taskDir: string,
  phaseId: string,
): Promise<ReviewArtifactStatus | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(artifactStatusPath(taskDir, phaseId), "utf8"));
  } catch {
    return null;
  }
  const res = validateReviewArtifactStatus(raw);
  return res.ok ? res.value : null;
}

async function writeArtifactStatus(
  taskDir: string,
  phaseId: string,
  status: Omit<ReviewArtifactStatus, "created_at" | "updated_at">,
): Promise<ReviewArtifactStatus> {
  const existing = await readArtifactStatus(taskDir, phaseId);
  const now = new Date().toISOString();
  const full: ReviewArtifactStatus = {
    ...status,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  const path = artifactStatusPath(taskDir, phaseId);
  await mkdir(dirname(path), { recursive: true });
  await atomicWriteJson(path, full);
  return full;
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

async function hashFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/** Deterministic content hash of a directory tree: sha256 over sorted
 * `relative-path\n<file sha256>\n` records. */
export async function hashDirectory(root: string): Promise<string> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(p);
      } else if (entry.isFile()) {
        files.push(p);
      }
    }
  }
  await walk(root);
  files.sort();
  const h = createHash("sha256");
  for (const file of files) {
    h.update(relative(root, file));
    h.update("\n");
    h.update(await hashFile(file));
    h.update("\n");
  }
  return h.digest("hex");
}

async function scientificGateHash(
  taskDir: string,
  phaseId: string,
): Promise<string | null> {
  try {
    return await hashFile(join(taskDir, "review", "gates", `${phaseId}.json`));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Settlement state detection (resume seam)
// ---------------------------------------------------------------------------

/**
 * True when this phase's SCIENCE is already accepted on disk: a live passing
 * gate file plus a provenance manifest entry. `runTask` uses this to never
 * re-run a worker whose verified outputs already passed the gate — a crash or
 * artifact failure between gate acceptance and settlement resumes at the
 * artifact step only (design §3.D "Resume detects the accepted scientific
 * gate ... and restarts authoring only").
 */
export async function scientificGateAccepted(
  taskDir: string,
  phaseId: string,
): Promise<boolean> {
  let raw: unknown;
  try {
    raw = JSON.parse(
      await readFile(join(taskDir, "review", "gates", `${phaseId}.json`), "utf8"),
    );
  } catch {
    return false;
  }
  const gate = validateGateFile(raw);
  if (!gate.ok) return false;
  if (gate.value.decision !== "pass" && gate.value.decision !== "pass-with-concerns") {
    return false;
  }

  const manifest = await readProvenanceManifest(taskDir).catch(() => null);
  return manifest !== null && manifest.some((e) => e.phase === phaseId);
}

/**
 * True when a science-accepted phase still owes its artifact half of
 * settlement: a non-`none`, non-legacy resolved type whose status.json is not
 * `published` (missing counts as pending — the author never ran).
 */
export async function artifactSettlementPending(
  taskDir: string,
  phase: ProtocolPhase,
): Promise<boolean> {
  const resolved = resolveReviewArtifact(phase);
  if (resolved.legacy || resolved.type === "none") return false;
  const status = await readArtifactStatus(taskDir, phase.id);
  return status?.status !== "published";
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

/**
 * Settle one phase's review artifact after its scientific gate is accepted.
 *
 * - `none`  → writes `status.json = none` and settles immediately (no author,
 *   no site dir, no linter).
 * - non-`none` → up to `config.retries.artifactAuthorAttempts` author attempts,
 *   each a FRESH session against a FRESH staging dir seeded from the vendored
 *   template; only an all-gates-ok linter report publishes (atomic rename to
 *   `artifacts/review-sites/<phase>/`). A failed attempt is archived under
 *   `review/artifact-author/<phase>/attempt-N/` with its report.
 * - legacy → REFUSED: callers must branch on `resolveReviewArtifact().legacy`
 *   BEFORE type and keep the existing worker-authored review-site path.
 *
 * Never touches `phases/<phase>/` or the phase's verified artifacts.
 */
export async function settleReviewArtifact(
  ctx: ArtifactSettlementContext,
  runAuthor: AuthorRunner = runReviewArtifactAuthor,
): Promise<SettleArtifactResult> {
  const { taskId, taskDir, phase } = ctx;
  const resolved = resolveReviewArtifact(phase);
  if (resolved.legacy) {
    throw new Error(
      `settleReviewArtifact called for legacy review-site phase "${phase.id}" — legacy phases keep the existing pre-review check + route`,
    );
  }
  if (resolved.type === "none") {
    await writeArtifactStatus(taskDir, phase.id, { status: "none", type: "none" });
    return { kind: "none" };
  }

  // Idempotent re-entry: already published (e.g. crash after publish but
  // before task.json settled) — nothing to re-author.
  const existing = await readArtifactStatus(taskDir, phase.id);
  if (existing?.status === "published") {
    const publishedRel = relative(taskDir, publishedReviewSiteDir(taskDir, phase.id));
    return {
      kind: "published",
      authorSessionId: existing.author_session_id ?? "unknown",
      authorAttempt: existing.author_attempt ?? 1,
      type: resolved.type,
      publishedPath: publishedRel,
      artifactHash: existing.check_report_hash ?? "unknown",
      checkReportPath: existing.check_report_path ?? publishedRel,
      checkReportHash: existing.check_report_hash ?? "unknown",
    };
  }

  const authorSkillDir = await findRegistrySkillDir(
    AUTHOR_SKILL_NAME,
    ctx.config.scienceHome,
  );
  const templateDir = resolveReviewTemplateDir(authorSkillDir, {
    type: resolved.type,
    ...(resolved.template !== undefined ? { template: resolved.template } : {}),
  });
  const gateHash = await scientificGateHash(taskDir, phase.id);

  // Author attempts continue past a prior pause: a resumed task's counter
  // starts after the last archived attempt, so archives never collide.
  const startAttempt = (existing?.author_attempt ?? 0) + 1;
  const maxAttempts = startAttempt + ctx.config.retries.artifactAuthorAttempts - 1;
  let lastFailure = "review-artifact author produced no attempt";

  for (let authorAttempt = startAttempt; authorAttempt <= maxAttempts; authorAttempt++) {
    const stagingDir = stagingReviewSiteDir(taskDir, phase.id, authorAttempt);
    await rm(stagingDir, { recursive: true, force: true });
    await mkdir(dirname(stagingDir), { recursive: true });
    await cp(templateDir, stagingDir, { recursive: true });

    await writeArtifactStatus(taskDir, phase.id, {
      status: "authoring",
      type: resolved.type,
      ...(resolved.template !== undefined ? { template: resolved.template } : {}),
      author_attempt: authorAttempt,
      staging_path: relative(taskDir, stagingDir),
      ...(gateHash !== null ? { scientific_gate_hash: gateHash } : {}),
    });

    const author = await runAuthor({
      taskId,
      taskDir,
      protocol: ctx.protocol,
      phase,
      attempt: ctx.attempt,
      authorAttempt,
      stagingDir,
      artifactType: resolved.type,
      authorSkillDir,
      runtime: ctx.runtime,
      runSettings: ctx.config,
    });

    const attemptDir = authorAttemptDir(taskDir, phase.id, authorAttempt);
    const reportPath = join(attemptDir, "check_review_site.json");
    const report = await runReviewArtifactCheckAtPath(
      taskId,
      taskDir,
      phase,
      stagingDir,
      reportPath,
    );
    const reportHash = await hashFile(reportPath);
    const reportRel = relative(taskDir, reportPath);

    if (report.ok) {
      const publishedDir = publishedReviewSiteDir(taskDir, phase.id);
      // A leftover published dir without a `published` status was never
      // recorded — clear it so the atomic rename is the only publish path.
      await rm(publishedDir, { recursive: true, force: true });
      await mkdir(dirname(publishedDir), { recursive: true });
      const artifactHash = await hashDirectory(stagingDir);
      await rename(stagingDir, publishedDir);
      const publishedRel = relative(taskDir, publishedDir);

      await writeArtifactStatus(taskDir, phase.id, {
        status: "published",
        type: resolved.type,
        ...(resolved.template !== undefined ? { template: resolved.template } : {}),
        author_attempt: authorAttempt,
        ...(author.sessionId !== "" ? { author_session_id: author.sessionId } : {}),
        published_path: publishedRel,
        check_report_path: reportRel,
        check_report_hash: reportHash,
        ...(gateHash !== null ? { scientific_gate_hash: gateHash } : {}),
      });

      return {
        kind: "published",
        authorSessionId: author.sessionId !== "" ? author.sessionId : "unknown",
        authorAttempt,
        type: resolved.type,
        publishedPath: publishedRel,
        artifactHash,
        checkReportPath: reportRel,
        checkReportHash: reportHash,
      };
    }

    // Linter failed: archive this attempt's staging next to its report and
    // retry with a FRESH author + FRESH staging. NEVER touch worker science.
    lastFailure = report.findings
      .filter((f) => !f.ok)
      .map((f) => `${f.gate}: ${f.detail}`)
      .join("; ");
    await rename(stagingDir, join(attemptDir, "site"));
    await notifyEvent(taskDir, {
      type: "log",
      taskId,
      line: `review-artifact linter FAILED for ${phase.id} (author attempt ${authorAttempt}): ${lastFailure}`,
      ephemeral: true,
    });

    await writeArtifactStatus(taskDir, phase.id, {
      status: "failed",
      type: resolved.type,
      ...(resolved.template !== undefined ? { template: resolved.template } : {}),
      author_attempt: authorAttempt,
      ...(author.sessionId !== "" ? { author_session_id: author.sessionId } : {}),
      check_report_path: reportRel,
      check_report_hash: reportHash,
      ...(gateHash !== null ? { scientific_gate_hash: gateHash } : {}),
    });
  }

  return {
    kind: "artifact-failed",
    reason: `review-artifact author failed for ${phase.id} after ${ctx.config.retries.artifactAuthorAttempts} attempt(s): ${lastFailure}`,
  };
}

/**
 * Resume seam: re-append this phase's latest provenance entry augmented with
 * the now-published artifact (manifest is append-only, last-write-wins per
 * phase) — so a phase whose artifact published on a LATER resume still binds
 * author session + artifact hash into provenance.
 */
export async function appendPublishedArtifactProvenance(
  taskDir: string,
  phaseId: string,
  settle: Extract<SettleArtifactResult, { kind: "published" }>,
): Promise<void> {
  const manifest = await readProvenanceManifest(taskDir);
  let latest: ProvenanceManifestEntry | null = null;
  for (const entry of manifest) {
    if (entry.phase === phaseId) latest = entry;
  }
  if (!latest) {
    throw new Error(
      `No provenance entry for science-accepted phase "${phaseId}" — cannot bind published artifact`,
    );
  }
  await appendManifestEntry(taskDir, {
    ...latest,
    sessions: { ...latest.sessions, author: settle.authorSessionId },
    review_artifact: {
      type: settle.type,
      path: settle.publishedPath,
      hash: settle.artifactHash,
      check_report: settle.checkReportPath,
      check_report_hash: settle.checkReportHash,
    },
  });
}
