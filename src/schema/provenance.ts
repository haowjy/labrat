import {
  expectArray,
  expectEnum,
  expectIsoDateTime,
  expectNonEmptyString,
  expectNumber,
  expectOptional,
  expectRecord,
  expectStringMap,
  type ValidationResult,
  success,
} from "./validation.js";
import { GATE_DECISIONS, type GateDecision } from "./gate.js";

export type SkillLoaded = {
  readonly name: string;
  readonly hash: string;
  readonly source?: "registry" | "local";
};

export type ProvenanceArtifactRef = {
  readonly path: string;
  readonly hash?: string;
  readonly fileCount?: number;
};

export type ProvenanceSessions = {
  readonly worker: string;
  readonly gate: string;
};

export type ProvenanceVerification = {
  readonly code: string;
  readonly results: string;
};

/** Single append-only manifest entry (design §14). */
export type ProvenanceManifestEntry = {
  readonly phase: string;
  readonly attempt: number;
  readonly started: string;
  readonly completed: string;
  readonly skills_loaded: readonly SkillLoaded[];
  readonly agent: string;
  readonly inputs: readonly ProvenanceArtifactRef[];
  readonly outputs: readonly ProvenanceArtifactRef[];
  readonly subphases: Readonly<Record<string, string>> | null;
  readonly sessions: ProvenanceSessions;
  readonly gate_decision: GateDecision;
  readonly verification: ProvenanceVerification;
};

export type ProvenanceManifest = readonly ProvenanceManifestEntry[];

function validateSkillLoaded(
  value: unknown,
  path: string,
): ValidationResult<SkillLoaded> {
  const rec = expectRecord(value, path);
  if (!rec.ok) return rec;

  const name = expectNonEmptyString(rec.value["name"], `${path}.name`);
  if (!name.ok) return name;

  const hash = expectNonEmptyString(rec.value["hash"], `${path}.hash`);
  if (!hash.ok) return hash;

  const source = expectOptional(rec.value["source"], `${path}.source`, (v, p) =>
    expectEnum(v, p, ["registry", "local"] as const),
  );
  if (!source.ok) return source;

  return success({
    name: name.value,
    hash: hash.value,
    ...(source.value !== undefined ? { source: source.value } : {}),
  });
}

function validateArtifactRef(
  value: unknown,
  path: string,
): ValidationResult<ProvenanceArtifactRef> {
  const rec = expectRecord(value, path);
  if (!rec.ok) return rec;

  const artifactPath = expectNonEmptyString(rec.value["path"], `${path}.path`);
  if (!artifactPath.ok) return artifactPath;

  const hash = expectOptional(rec.value["hash"], `${path}.hash`, (v, p) =>
    expectNonEmptyString(v, p),
  );
  if (!hash.ok) return hash;

  const fileCount = expectOptional(
    rec.value["fileCount"],
    `${path}.fileCount`,
    (v, p) => expectNumber(v, p),
  );
  if (!fileCount.ok) return fileCount;

  return success({
    path: artifactPath.value,
    ...(hash.value !== undefined ? { hash: hash.value } : {}),
    ...(fileCount.value !== undefined ? { fileCount: fileCount.value } : {}),
  });
}

function validateArtifactRefArray(
  value: unknown,
  path: string,
): ValidationResult<readonly ProvenanceArtifactRef[]> {
  const arr = expectArray(value, path);
  if (!arr.ok) return arr;
  const out: ProvenanceArtifactRef[] = [];
  for (let i = 0; i < arr.value.length; i++) {
    const ref = validateArtifactRef(arr.value[i], `${path}[${i}]`);
    if (!ref.ok) return ref;
    out.push(ref.value);
  }
  return success(out);
}

export function validateProvenanceManifestEntry(
  value: unknown,
): ValidationResult<ProvenanceManifestEntry> {
  const rec = expectRecord(value, "$");
  if (!rec.ok) return rec;

  const phase = expectNonEmptyString(rec.value["phase"], "$.phase");
  if (!phase.ok) return phase;

  const attempt = expectNumber(rec.value["attempt"], "$.attempt");
  if (!attempt.ok) return attempt;

  const started = expectIsoDateTime(rec.value["started"], "$.started");
  if (!started.ok) return started;

  const completed = expectIsoDateTime(rec.value["completed"], "$.completed");
  if (!completed.ok) return completed;

  const skillsArr = expectArray(rec.value["skills_loaded"], "$.skills_loaded");
  if (!skillsArr.ok) return skillsArr;
  const skills_loaded: SkillLoaded[] = [];
  for (let i = 0; i < skillsArr.value.length; i++) {
    const sk = validateSkillLoaded(skillsArr.value[i], `$.skills_loaded[${i}]`);
    if (!sk.ok) return sk;
    skills_loaded.push(sk.value);
  }

  const agent = expectNonEmptyString(rec.value["agent"], "$.agent");
  if (!agent.ok) return agent;

  const inputs = validateArtifactRefArray(rec.value["inputs"] ?? [], "$.inputs");
  if (!inputs.ok) return inputs;

  const outputs = validateArtifactRefArray(
    rec.value["outputs"] ?? [],
    "$.outputs",
  );
  if (!outputs.ok) return outputs;

  let subphases: Readonly<Record<string, string>> | null = null;
  const sp = rec.value["subphases"];
  if (sp !== null && sp !== undefined) {
    const spMap = expectStringMap(sp, "$.subphases");
    if (!spMap.ok) return spMap;
    subphases = spMap.value;
  }

  const sessionsRec = expectRecord(rec.value["sessions"], "$.sessions");
  if (!sessionsRec.ok) return sessionsRec;

  const worker = expectNonEmptyString(sessionsRec.value["worker"], "$.sessions.worker");
  if (!worker.ok) return worker;

  const gate = expectNonEmptyString(sessionsRec.value["gate"], "$.sessions.gate");
  if (!gate.ok) return gate;

  const gate_decision = expectEnum(
    rec.value["gate_decision"],
    "$.gate_decision",
    GATE_DECISIONS,
  );
  if (!gate_decision.ok) return gate_decision;

  const verificationRec = expectRecord(rec.value["verification"], "$.verification");
  if (!verificationRec.ok) return verificationRec;

  const code = expectNonEmptyString(
    verificationRec.value["code"],
    "$.verification.code",
  );
  if (!code.ok) return code;

  const results = expectNonEmptyString(
    verificationRec.value["results"],
    "$.verification.results",
  );
  if (!results.ok) return results;

  return success({
    phase: phase.value,
    attempt: attempt.value,
    started: started.value,
    completed: completed.value,
    skills_loaded,
    agent: agent.value,
    inputs: inputs.value,
    outputs: outputs.value,
    subphases,
    sessions: { worker: worker.value, gate: gate.value },
    gate_decision: gate_decision.value,
    verification: { code: code.value, results: results.value },
  });
}

export function validateProvenanceManifest(
  value: unknown,
): ValidationResult<ProvenanceManifest> {
  const arr = expectArray(value, "$");
  if (!arr.ok) return arr;

  const out: ProvenanceManifestEntry[] = [];
  for (let i = 0; i < arr.value.length; i++) {
    const entry = validateProvenanceManifestEntry(arr.value[i]);
    if (!entry.ok) {
      return {
        ok: false,
        errors: entry.errors.map((e) => ({
          path: `$[${i}]${e.path === "$" ? "" : e.path.slice(1)}`,
          message: e.message,
        })),
      };
    }
    out.push(entry.value);
  }
  return success(out);
}
