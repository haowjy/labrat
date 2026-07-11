/**
 * Retry/rewind invalidation (design §6, §12).
 *
 * Retry (same phase, fresh agent): archive phases/{phase}/, its gate file
 * (+ trust-boundary sidecar), review/verification/{phase}/ (the prior
 * reviewer's scratch space — a retried gate gets a truly fresh reviewer,
 * not one that inherits stale verification code/output), and reset declared
 * artifact outputs.
 *
 * Rewind (fail-upstream): the same, applied to the target phase AND every
 * downstream phase — work built on now-invalid inputs cannot survive.
 */
import { readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ProtocolYaml } from "../../schema/index.js";
import { resolveDeclaredArtifactPath } from "../../util/artifact-path.js";
import { readHumanVerdict } from "../review-verdict/index.js";

async function existsAt(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function nextAttemptSuffix(
  parentDir: string,
  baseName: string,
): Promise<number> {
  if (!(await existsAt(parentDir))) {
    return 1;
  }
  const entries = await readdir(parentDir);
  let max = 0;
  const re = new RegExp(`^${baseName}\\.attempt-(\\d+)(?:\\.json)?$`);
  for (const entry of entries) {
    const m = re.exec(entry);
    if (m?.[1]) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return max + 1;
}

/** Archive phases/{phase}/ + its gate file, then reset declared artifact outputs. */
export async function archiveAndResetPhase(
  taskDir: string,
  protocolYaml: ProtocolYaml,
  phaseId: string,
): Promise<{ readonly attempt: number }> {
  const phase = protocolYaml.phases.find((p) => p.id === phaseId);
  const phasesRoot = join(taskDir, "phases");
  const phaseDir = join(phasesRoot, phaseId);
  const attempt = await nextAttemptSuffix(phasesRoot, phaseId);

  if (await existsAt(phaseDir)) {
    await rename(phaseDir, join(phasesRoot, `${phaseId}.attempt-${attempt}`));
  }

  const gatesRoot = join(taskDir, "review", "gates");
  const gatePath = join(gatesRoot, `${phaseId}.json`);
  if (await existsAt(gatePath)) {
    await rename(gatePath, join(gatesRoot, `${phaseId}.attempt-${attempt}.json`));
  }

  const trustBoundaryPath = join(gatesRoot, `${phaseId}.trust-boundary.json`);
  if (await existsAt(trustBoundaryPath)) {
    await rename(
      trustBoundaryPath,
      join(gatesRoot, `${phaseId}.attempt-${attempt}.trust-boundary.json`),
    );
  }

  // The prior reviewer's scratch space — rm it so a retried gate's reviewer
  // starts fresh instead of inheriting stale verification code/output.
  const verificationDir = join(taskDir, "review", "verification", phaseId);
  await rm(verificationDir, { recursive: true, force: true });

  for (const output of phase?.outputs ?? []) {
    const { absPath } = resolveDeclaredArtifactPath(taskDir, output);
    await rm(absPath, { recursive: true, force: true });
  }

  return { attempt };
}

/**
 * Consume a delivered send-back mark: archive a `changes_requested` human
 * verdict (`review/verdict/{phase}.json`) to `{phase}.attempt-N.json` — the
 * same attempt-N idiom `archiveAndResetPhase` uses for the gate sidecars.
 *
 * Called from the gate PASS path (orchestrator, after the trust-boundary
 * check — never inside a reviewer session): by then the re-run worker has
 * already read the human's note, so archiving here (a) keeps the verdict
 * auditable, (b) stops `findSendBackPhase` from rewinding to this phase again
 * on a later unrelated `rerun`, and (c) stops the stale note re-injecting
 * into a later unrelated re-run of the phase. Terminal `pass`/`fail` human
 * verdicts are NOT touched — they stay live for the review chain.
 * Deliberately NOT part of `archiveAndResetPhase`: that runs during
 * send-back invalidation, BEFORE the re-run worker reads the note.
 */
export async function consumeSendBackVerdict(
  taskDir: string,
  phaseId: string,
): Promise<void> {
  const record = await readHumanVerdict(taskDir, phaseId);
  if (record?.human_verdict !== "changes_requested") {
    return;
  }
  const verdictRoot = join(taskDir, "review", "verdict");
  const attempt = await nextAttemptSuffix(verdictRoot, phaseId);
  await rename(
    join(verdictRoot, `${phaseId}.json`),
    join(verdictRoot, `${phaseId}.attempt-${attempt}.json`),
  );
}

/** Phases at or after `fromPhaseId` in protocol declaration order. */
export function downstreamPhaseIds(
  protocolYaml: ProtocolYaml,
  fromPhaseId: string,
): readonly string[] {
  const ids = protocolYaml.phases.map((p) => p.id);
  const idx = ids.indexOf(fromPhaseId);
  if (idx === -1) {
    throw new Error(`Unknown rewind target phase: ${fromPhaseId}`);
  }
  return ids.slice(idx);
}

/** Rewind: archive+reset the target phase and everything downstream of it. */
export async function invalidateFromPhase(
  taskDir: string,
  protocolYaml: ProtocolYaml,
  fromPhaseId: string,
): Promise<void> {
  for (const phaseId of downstreamPhaseIds(protocolYaml, fromPhaseId)) {
    await archiveAndResetPhase(taskDir, protocolYaml, phaseId);
  }
}
