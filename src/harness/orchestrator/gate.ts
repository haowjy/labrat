import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { LabratConfig } from "../../config/index.js";
import {
  validateGateFile,
  validateVerdictJson,
  type GateFile,
  type ProtocolPhase,
  type ProvenanceManifestEntry,
  type SubmitGateDecisionInput,
  type VerdictJson,
} from "../../schema/index.js";
import type { LoadedProtocol } from "../protocol-loader/index.js";
import { loadPhase } from "../protocol-loader/index.js";
import {
  derivePhaseTiming,
  hashSkillsLoaded,
  readSubphaseSummary,
  resolveArtifactRefs,
  appendManifestEntry,
} from "../provenance/index.js";
import { notifyEvent } from "../events/index.js";
import type { RuntimeHandle } from "../runtime-setup/types.js";
import { runGateReview } from "../session/review.js";
import { runMonitor, type MonitorVerdict } from "../session/monitor.js";
import {
  enforceTrustBoundary,
  type TrustBoundaryResult,
} from "../session/trust-boundary.js";
import { atomicWriteJson, atomicWriteText } from "../../util/atomic-write.js";
import { archiveAndResetPhase, invalidateFromPhase } from "./invalidation.js";

export type GateContext = {
  readonly taskId: string;
  readonly taskDir: string;
  readonly protocol: LoadedProtocol;
  readonly phase: ProtocolPhase;
  readonly workerSessionId: string;
  readonly runtime: RuntimeHandle;
  /** Current attempt number for this phase (1 on first run). */
  readonly attempt: number;
  /** ISO timestamp the worker session started, for provenance. Falls back
   * to disk-derived timing (subphases.json / summary.md mtimes) when the
   * caller doesn't know it (e.g. the standalone `gate` CLI backfilling a
   * phase that already ran). */
  readonly startedAt?: string;
  readonly config: LabratConfig;
};

export type RunGateResult =
  | {
      readonly kind: "pass" | "pass-with-concerns";
      readonly phase: string;
      readonly sessionId: string;
      readonly confidence?: "low";
    }
  | {
      readonly kind: "fail";
      readonly phase: string;
      readonly sessionId: string;
      readonly feedback: string | null;
      readonly attempt: number;
    }
  | {
      readonly kind: "fail-upstream";
      readonly phase: string;
      readonly sessionId: string;
      readonly rewindTo: string;
      readonly feedback: string | null;
    };

/** review/gates/{phase}.json — excludes .trust-boundary.json and archived .attempt-N.json. */
function isLiveGateFile(name: string): boolean {
  return (
    name.endsWith(".json") &&
    !name.endsWith(".trust-boundary.json") &&
    !/\.attempt-\d+\.json$/.test(name)
  );
}

/**
 * Rebuild verdict.json from the currently surviving gate files (design §6):
 * verdict is a *derived* view of `review/gates/`, not an append-only log, so
 * a clean re-pass after a rewind/retry (which archives the failing gate
 * file) can return the verdict to `pass` instead of staying stuck at
 * `pass-with-concerns` from a since-invalidated attempt.
 */
export async function rebuildVerdict(taskDir: string): Promise<VerdictJson> {
  const gatesRoot = join(taskDir, "review", "gates");
  let entries: string[];
  try {
    entries = await readdir(gatesRoot);
  } catch {
    entries = [];
  }

  let anyConcerns = false;
  const flags: string[] = [];
  for (const name of entries.filter(isLiveGateFile).sort()) {
    const raw: unknown = JSON.parse(await readFile(join(gatesRoot, name), "utf8"));
    const validated = validateGateFile(raw);
    if (!validated.ok) continue; // corrupt/foreign file — ignore, don't crash the verdict
    const gateFile = validated.value;
    if (gateFile.decision === "pass-with-concerns") {
      anyConcerns = true;
      if (gateFile.feedback) {
        flags.push(`${gateFile.phase}: ${gateFile.feedback}`);
      }
    }
  }

  if (entries.filter(isLiveGateFile).length === 0) {
    return { status: "in-progress", flags: [] };
  }
  return {
    status: anyConcerns ? "pass-with-concerns" : "pass",
    flags,
    updatedAt: new Date().toISOString(),
  };
}

async function writeVerdict(taskDir: string): Promise<void> {
  const verdict = await rebuildVerdict(taskDir);
  const validated = validateVerdictJson(verdict);
  if (!validated.ok) {
    throw new Error(
      `Internal error building verdict.json: ${validated.errors.map((e) => e.message).join("; ")}`,
    );
  }
  await atomicWriteJson(join(taskDir, "review", "verdict.json"), validated.value);
}

function reviewerReportMarkdown(
  phaseId: string,
  decision: SubmitGateDecisionInput,
  trustBoundary: TrustBoundaryResult,
  defaulted: boolean,
  sessionId: string,
): string {
  const lines: string[] = [
    `# Gate review — ${phaseId}`,
    "",
    `- Decision: **${decision.decision}**`,
    `- Reviewer session: ${sessionId}`,
    `- Defaulted (no submit_gate_decision after 2 attempts): ${defaulted ? "yes" : "no"}`,
    `- Trust boundary: ${trustBoundary.ok ? "OK — artifacts/, phases/, task.json, review/gates/, and provenance/manifest.yaml unmodified" : "VIOLATION — see below"}`,
  ];
  if (decision.rewind_to) {
    lines.push(`- Rewind to: ${decision.rewind_to}`);
  }
  if (decision.feedback) {
    lines.push("", "## Feedback", "", decision.feedback);
  }
  if (decision.subphase_assessments) {
    lines.push("", "## Subphase assessments", "");
    for (const [id, note] of Object.entries(decision.subphase_assessments)) {
      lines.push(`- ${id}: ${note}`);
    }
  }
  if (!trustBoundary.ok) {
    lines.push("", "## Trust boundary violations", "");
    for (const v of trustBoundary.violations) {
      lines.push(`- [${v.area}] ${v.kind}: ${v.path}`);
    }
  }
  lines.push(
    "",
    `_Verification code + output: \`review/verification/${phaseId}/\`_`,
  );
  return `${lines.join("\n")}\n`;
}

async function writeGateArtifacts(
  taskDir: string,
  phaseId: string,
  decision: SubmitGateDecisionInput,
  confidence: "low" | undefined,
  trustBoundary: TrustBoundaryResult,
  defaulted: boolean,
  sessionId: string,
): Promise<void> {
  const gateFile: GateFile = {
    phase: phaseId,
    decidedAt: new Date().toISOString(),
    decision: decision.decision,
    ...(decision.rewind_to !== undefined ? { rewind_to: decision.rewind_to } : {}),
    ...(decision.feedback !== undefined ? { feedback: decision.feedback } : {}),
    ...(decision.subphase_assessments !== undefined
      ? { subphase_assessments: decision.subphase_assessments }
      : {}),
    ...(confidence !== undefined ? { confidence } : {}),
  };
  const validated = validateGateFile(gateFile);
  if (!validated.ok) {
    throw new Error(
      `Internal error building gate file: ${validated.errors.map((e) => e.message).join("; ")}`,
    );
  }
  await atomicWriteJson(
    join(taskDir, "review", "gates", `${phaseId}.json`),
    validated.value,
  );
  await atomicWriteJson(
    join(taskDir, "review", "gates", `${phaseId}.trust-boundary.json`),
    trustBoundary,
  );
  await appendReviewerReport(
    taskDir,
    reviewerReportMarkdown(phaseId, decision, trustBoundary, defaulted, sessionId),
  );
}

/** review/reviewer_report.md accumulates one section per gate (design §5, §10). */
async function appendReviewerReport(taskDir: string, section: string): Promise<void> {
  const reportPath = join(taskDir, "review", "reviewer_report.md");
  const existing = await readFile(reportPath, "utf8").catch(() => "");
  await atomicWriteText(reportPath, `${existing}${existing ? "\n---\n\n" : ""}${section}`);
}

/**
 * Enforcement rule for the independent monitor (Lane D2): a monitor verdict of
 * `rubber_stamp`/`insufficient_evidence` overrides a reviewer PASS and FAILs
 * the gate. Only passing verdicts can be overridden — a reviewer that already
 * failed/rewound has no rubber stamp to catch. Pure so the enforcement wiring
 * is testable without a live session.
 */
export function monitorOverridesGate(
  reviewerDecision: SubmitGateDecisionInput["decision"],
  monitorVerdict: MonitorVerdict,
): boolean {
  const passing =
    reviewerDecision === "pass" || reviewerDecision === "pass-with-concerns";
  return passing && monitorVerdict !== "ok";
}

/**
 * Gate one completed phase (design §6, §10, §12): run a fresh, disk-only
 * reviewer session inside the trust boundary, write the gate/verdict/report
 * files, append provenance on pass paths, and perform the retry/rewind
 * invalidation on fail paths.
 *
 * Lane D2: on a reviewer PASS, an INDEPENDENT small-model monitor (outside the
 * reviewer's trust boundary) audits the review for rubber-stamping before the
 * pass is committed. A monitor rejection converts the result to a FAIL so
 * runTask's existing retry/pause path handles it.
 */
export async function runGate(ctx: GateContext): Promise<RunGateResult> {
  const loadedPhase = await loadPhase(ctx.protocol, ctx.phase.id);

  const { result: review, trustBoundary } = await enforceTrustBoundary(
    ctx.taskDir,
    () =>
      runGateReview({
        taskId: ctx.taskId,
        taskDir: ctx.taskDir,
        protocol: ctx.protocol,
        loadedPhase,
        runtime: ctx.runtime,
        runSettings: ctx.config,
      }),
  );

  const decision = review.decision;
  const confidence = review.defaulted ? ("low" as const) : undefined;

  await writeGateArtifacts(
    ctx.taskDir,
    ctx.phase.id,
    decision,
    confidence,
    trustBoundary,
    review.defaulted,
    review.sessionId,
  );
  notifyEvent({
    type: "gate-result",
    taskId: ctx.taskId,
    phase: ctx.phase.id,
    decision: decision.decision,
  });

  if (decision.decision === "pass" || decision.decision === "pass-with-concerns") {
    // Independent monitor audits this PASS for rubber-stamping (Lane D2). It
    // runs OUTSIDE the reviewer's trust boundary, reads the reviewer's
    // verification + gate + report, and writes review/monitor/{phase}.json.
    const monitorProfile = ctx.protocol.yaml.agents["monitor"];
    const monitor = await runMonitor({
      taskId: ctx.taskId,
      taskDir: ctx.taskDir,
      phaseId: ctx.phase.id,
      gateDecision: decision.decision,
      reviewerDefaulted: review.defaulted,
      model: monitorProfile?.model ?? "haiku",
      permissionMode: monitorProfile?.permissions ?? ctx.config.defaultPermissionMode,
      runtime: ctx.runtime,
    });

    if (monitorOverridesGate(decision.decision, monitor.verdict)) {
      // Treat as a reviewer FAIL: archive the phase + gate (dropping the
      // now-void pass), skip verdict/provenance, and let runTask retry with a
      // fresh worker + reviewer. The monitor's finding persists in
      // review/monitor/{phase}.json.
      notifyEvent({
        type: "log",
        taskId: ctx.taskId,
        line: `monitor FAILED gate for ${ctx.phase.id}: ${monitor.verdict} — ${monitor.reasons[0] ?? ""}`,
        ephemeral: true,
      });
      await archiveAndResetPhase(ctx.taskDir, ctx.protocol.yaml, ctx.phase.id);
      return {
        kind: "fail",
        phase: ctx.phase.id,
        sessionId: review.sessionId,
        feedback: `Independent monitor rejected the reviewer's "${decision.decision}" as ${monitor.verdict}: ${monitor.reasons.join(" ")}`,
        attempt: ctx.attempt,
      };
    }

    await writeVerdict(ctx.taskDir);

    const { started, completed } = ctx.startedAt
      ? { started: ctx.startedAt, completed: new Date().toISOString() }
      : await derivePhaseTiming(ctx.taskDir, ctx.phase.id);

    const entry: ProvenanceManifestEntry = {
      phase: ctx.phase.id,
      attempt: ctx.attempt,
      started,
      completed,
      skills_loaded: hashSkillsLoaded(loadedPhase.skills),
      agent: "worker",
      inputs: await resolveArtifactRefs(ctx.taskDir, ctx.phase.inputs ?? []),
      outputs: await resolveArtifactRefs(ctx.taskDir, ctx.phase.outputs ?? []),
      subphases: await readSubphaseSummary(ctx.taskDir, ctx.phase.id),
      sessions: { worker: ctx.workerSessionId, gate: review.sessionId },
      gate_decision: decision.decision,
      verification: {
        code: `review/verification/${ctx.phase.id}/`,
        results: `review/gates/${ctx.phase.id}.json`,
      },
    };
    await appendManifestEntry(ctx.taskDir, entry);

    return {
      kind: decision.decision,
      phase: ctx.phase.id,
      sessionId: review.sessionId,
      ...(confidence !== undefined ? { confidence } : {}),
    };
  }

  if (decision.decision === "fail-upstream") {
    const rewindTo = decision.rewind_to as string; // guaranteed by schema validation
    await invalidateFromPhase(ctx.taskDir, ctx.protocol.yaml, rewindTo);
    return {
      kind: "fail-upstream",
      phase: ctx.phase.id,
      sessionId: review.sessionId,
      rewindTo,
      feedback: decision.feedback ?? null,
    };
  }

  // decision.decision === "fail" — retry same phase, fresh agent.
  await archiveAndResetPhase(ctx.taskDir, ctx.protocol.yaml, ctx.phase.id);
  return {
    kind: "fail",
    phase: ctx.phase.id,
    sessionId: review.sessionId,
    feedback: decision.feedback ?? null,
    attempt: ctx.attempt,
  };
}
