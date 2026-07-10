import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  latestMarksBySubphase,
  validateProvenanceManifest,
  validateProvenanceManifestEntry,
  validateSubphasesJson,
  type ProvenanceArtifactRef,
  type ProvenanceManifest,
  type ProvenanceManifestEntry,
  type SkillLoaded,
} from "../../schema/index.js";
import type { ResolvedSkill } from "../protocol-loader/index.js";
import { atomicWriteText } from "../util/atomic-write.js";
import { hashDirectory, hashFile } from "../session/trust-boundary.js";

const MANIFEST_REL = join("provenance", "manifest.yaml");

async function existsAt(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Hash `resources/*.md` skill bodies for provenance (design §14 skills_loaded). */
export function hashSkillsLoaded(
  resolvedSkills: readonly ResolvedSkill[],
): readonly SkillLoaded[] {
  return resolvedSkills.map((skill) => ({
    name: skill.ref,
    hash: createHash("sha256").update(skill.body).digest("hex").slice(0, 12),
    source: skill.kind === "registry" ? ("registry" as const) : ("local" as const),
  }));
}

/**
 * Resolve one protocol phase.inputs/outputs entry to an on-disk path and a
 * provenance ref (hash for files, fileCount for directories). `input/` is
 * relative to the task dir root (the staged DICOM); everything else is
 * relative to `artifacts/`.
 */
async function resolveArtifactRef(
  taskDir: string,
  declared: string,
): Promise<ProvenanceArtifactRef> {
  const isTaskRootRelative = declared === "input/" || declared.startsWith("input/");
  const relForManifest = isTaskRootRelative ? declared : `artifacts/${declared}`;
  const absPath = isTaskRootRelative
    ? join(taskDir, declared)
    : join(taskDir, "artifacts", declared.replace(/\/+$/, ""));

  if (!(await existsAt(absPath))) {
    return { path: relForManifest };
  }

  const info = await stat(absPath);
  if (info.isDirectory()) {
    const files = await hashDirectory(absPath);
    return { path: relForManifest, fileCount: files.size };
  }

  const hash = await hashFile(absPath);
  return { path: relForManifest, hash };
}

export async function resolveArtifactRefs(
  taskDir: string,
  declared: readonly string[],
): Promise<readonly ProvenanceArtifactRef[]> {
  const out: ProvenanceArtifactRef[] = [];
  for (const d of declared) {
    out.push(await resolveArtifactRef(taskDir, d));
  }
  return out;
}

/** Read the latest subphase marks as a flat `{ id: "mark (confidence)" }` map. */
export async function readSubphaseSummary(
  taskDir: string,
  phaseId: string,
): Promise<Readonly<Record<string, string>> | null> {
  const filePath = join(taskDir, "phases", phaseId, "subphases.json");
  if (!(await existsAt(filePath))) {
    return null;
  }
  const raw: unknown = JSON.parse(await readFile(filePath, "utf8"));
  const validated = validateSubphasesJson(raw);
  if (!validated.ok || validated.value.length === 0) {
    return null;
  }
  const latest = latestMarksBySubphase(validated.value);
  const out: Record<string, string> = {};
  for (const [id, entry] of latest) {
    out[id] = entry.confidence ? `${entry.mark} (${entry.confidence})` : entry.mark;
  }
  return out;
}

/**
 * Best-effort phase timing derived from disk when the caller didn't track
 * wall-clock start/stop itself (e.g. the standalone `gate` CLI backfilling
 * provenance for a phase that already ran).
 */
export async function derivePhaseTiming(
  taskDir: string,
  phaseId: string,
): Promise<{ readonly started: string; readonly completed: string }> {
  const phaseDir = join(taskDir, "phases", phaseId);
  let started: string | undefined;
  let completed: string | undefined;

  const subphasesPath = join(phaseDir, "subphases.json");
  if (await existsAt(subphasesPath)) {
    const raw: unknown = JSON.parse(await readFile(subphasesPath, "utf8"));
    const validated = validateSubphasesJson(raw);
    if (validated.ok && validated.value.length > 0) {
      const timestamps = validated.value.map((e) => e.timestamp).sort();
      started = timestamps[0];
      completed = timestamps[timestamps.length - 1];
    }
  }

  const summaryPath = join(phaseDir, "summary.md");
  if (await existsAt(summaryPath)) {
    const info = await stat(summaryPath);
    completed = completed ?? info.mtime.toISOString();
  }

  if (!started) {
    const dirInfo = await stat(phaseDir).catch(() => undefined);
    started = dirInfo?.birthtime.toISOString() ?? new Date().toISOString();
  }
  if (!completed) {
    completed = new Date().toISOString();
  }

  return { started, completed };
}

async function readManifest(taskDir: string): Promise<ProvenanceManifest> {
  const manifestPath = join(taskDir, MANIFEST_REL);
  if (!(await existsAt(manifestPath))) {
    return [];
  }
  const raw = await readFile(manifestPath, "utf8");
  if (raw.trim().length === 0) {
    return [];
  }
  const parsed: unknown = parseYaml(raw);
  const validated = validateProvenanceManifest(parsed ?? []);
  if (!validated.ok) {
    throw new Error(
      `Invalid provenance/manifest.yaml on disk: ${validated.errors
        .map((e) => `${e.path}: ${e.message}`)
        .join("; ")}`,
    );
  }
  return validated.value;
}

/** Append one entry to provenance/manifest.yaml (design §14), atomically. */
export async function appendManifestEntry(
  taskDir: string,
  entry: ProvenanceManifestEntry,
): Promise<void> {
  const validatedEntry = validateProvenanceManifestEntry(entry);
  if (!validatedEntry.ok) {
    throw new Error(
      `Refusing to append invalid provenance entry: ${validatedEntry.errors
        .map((e) => `${e.path}: ${e.message}`)
        .join("; ")}`,
    );
  }

  const existing = await readManifest(taskDir);
  const next = [...existing, validatedEntry.value];

  const validatedManifest = validateProvenanceManifest(next);
  if (!validatedManifest.ok) {
    throw new Error(
      `Refusing to write invalid provenance manifest: ${validatedManifest.errors
        .map((e) => `${e.path}: ${e.message}`)
        .join("; ")}`,
    );
  }

  const yamlText = stringifyYaml(validatedManifest.value);
  await atomicWriteText(join(taskDir, MANIFEST_REL), yamlText);
}
