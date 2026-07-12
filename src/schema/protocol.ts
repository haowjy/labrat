import {
  expectArray,
  expectEnum,
  expectNonEmptyString,
  expectNumber,
  expectOptional,
  expectRecord,
  expectString,
  expectStringArray,
  failure,
  isRecord,
  type ValidationResult,
  success,
} from "./validation.js";

/** Typed runtime dependency (design §16). */
export type RuntimeDepType = "python" | "binary" | "conda" | "env";

export type RuntimeDep =
  | string
  | { readonly type: RuntimeDepType; readonly name: string };

const RUNTIME_DEP_TYPES = ["python", "binary", "conda", "env"] as const;
const AGENT_PROFILE_MODELS = ["sonnet", "opus", "haiku", "inherit"] as const;
export const AGENT_PROFILE_PERMISSIONS = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
] as const;

export function parseRuntimeDep(value: unknown): ValidationResult<RuntimeDep> {
  if (typeof value === "string") {
    const colon = value.indexOf(":");
    if (colon === -1) {
      return success(value);
    }
    const type = value.slice(0, colon);
    const name = value.slice(colon + 1);
    if (!(RUNTIME_DEP_TYPES as readonly string[]).includes(type)) {
      return failure([
        { path: "$", message: `unknown runtime dep type: ${type}` },
      ]);
    }
    if (name.length === 0) {
      return failure([{ path: "$", message: "runtime dep name is empty" }]);
    }
    return success({
      type: type as RuntimeDepType,
      name,
    });
  }
  const rec = expectRecord(value, "$");
  if (!rec.ok) return rec;
  const type = expectEnum(rec.value["type"], "$.type", RUNTIME_DEP_TYPES);
  if (!type.ok) return type;
  const name = expectNonEmptyString(rec.value["name"], "$.name");
  if (!name.ok) return name;
  return success({ type: type.value, name: name.value });
}

export function validateRuntimeDepArray(
  value: unknown,
  path: string,
): ValidationResult<readonly RuntimeDep[]> {
  const arr = expectArray(value, path);
  if (!arr.ok) return arr;
  const out: RuntimeDep[] = [];
  for (let i = 0; i < arr.value.length; i++) {
    const dep = parseRuntimeDep(arr.value[i]);
    if (!dep.ok) {
      return failure(
        dep.errors.map((e) => ({
          path: `${path}[${i}]${e.path === "$" ? "" : e.path.slice(1)}`,
          message: e.message,
        })),
      );
    }
    out.push(dep.value);
  }
  return success(out);
}

/** Role-scoped skill requirements (design §7). */
export type RoleRequirements = {
  readonly tools?: readonly string[];
  readonly runtime?: readonly RuntimeDep[];
  readonly writable?: readonly string[];
};

export type SkillRequires = {
  readonly worker?: RoleRequirements;
  readonly reviewer?: RoleRequirements;
};

export type ProtocolSubphase = {
  readonly id: string;
  readonly depends_on?: readonly string[];
};

/**
 * Per-phase review-artifact selector (design §3.D "Protocol contract"). A
 * review artifact is an optional, phase-scoped derived VIEW of already-verified
 * disk evidence; it never affects the scientific gate. `type` picks which
 * vendored template a fresh author starts from; `template` optionally names a
 * registered template id (never a path — path-like values are rejected).
 */
export type ReviewArtifactType =
  | "none"
  | "spatial-3d"
  | "quantitative"
  | "document";

export type ReviewArtifactSpec = {
  /** Omitted WITHIN the block ⇒ `spatial-3d` (the default where an artifact is warranted). */
  readonly type?: ReviewArtifactType;
  /** A registered template id, never a path (design §3.D). */
  readonly template?: string;
};

export const REVIEW_ARTIFACT_TYPES = [
  "none",
  "spatial-3d",
  "quantitative",
  "document",
] as const;

export type ProtocolPhase = {
  readonly id: string;
  readonly skills: readonly string[];
  readonly inputs?: readonly string[];
  readonly outputs?: readonly string[];
  readonly subphases?: readonly ProtocolSubphase[];
  readonly agent?: string;
  /**
   * External resource origins a `review-artifact` phase's review site may load
   * (design review-template.md §1 I4 / §2 G6). Protocol-scoped, not
   * skill-scoped: the same review skill renders Plotly here, Three.js
   * elsewhere. Empty (or absent) = fully offline, only `'self'`. The gate's
   * `check_review_site` reads it for G6.
   */
  readonly cdn_allowlist?: readonly string[];
  /**
   * Optional per-phase review-artifact selector (design §3.D). Absent = no new
   * author artifact; normalization (`resolveReviewArtifact`) decides between the
   * `none` and legacy `review-site` behaviors from the phase's outputs.
   */
  readonly review_artifact?: ReviewArtifactSpec;
};

/**
 * The normalized review-artifact decision for a phase (design §3.D
 * "Normalization rules are decisive"). `legacy` is the authoritative
 * discriminant: when true, the harness uses the existing worker-authored
 * `artifacts/review-site/` path and its pre-review check, and `type` is only a
 * nominal default (callers MUST branch on `legacy` before `type`).
 */
export type ResolvedReviewArtifact = {
  readonly type: ReviewArtifactType;
  readonly template?: string;
  readonly legacy: boolean;
};

const LEGACY_REVIEW_SITE_DIR = "review-site";

function declaresLegacyReviewSite(phase: ProtocolPhase): boolean {
  return (phase.outputs ?? []).some(
    (o) => o === LEGACY_REVIEW_SITE_DIR || o.startsWith(`${LEGACY_REVIEW_SITE_DIR}/`),
  );
}

/**
 * Resolve a phase's review-artifact decision from its `review_artifact` block
 * and outputs (design §3.D). The four decisive cases:
 *
 * 1. explicit `type: none` ⇒ author nothing, no G1–G9 check;
 * 2. present block, `type` omitted ⇒ `spatial-3d` (the warranted default);
 * 3. absent block + a declared `review-site`/`review-site/*` output ⇒ LEGACY
 *    worker-authored single-site behavior (`legacy: true`);
 * 4. absent block otherwise ⇒ `none` (backward compatible; never infer 3D).
 *
 * Pure and total — safe to call after `validatePhase` has accepted the phase.
 */
export function resolveReviewArtifact(
  phase: ProtocolPhase,
): ResolvedReviewArtifact {
  const spec = phase.review_artifact;
  if (spec !== undefined) {
    if (spec.type === "none") {
      return { type: "none", legacy: false };
    }
    const type = spec.type ?? "spatial-3d";
    return {
      type,
      ...(spec.template !== undefined ? { template: spec.template } : {}),
      legacy: false,
    };
  }
  if (declaresLegacyReviewSite(phase)) {
    // Legacy artifacts predate typing: the worker authored the single site and
    // the existing pre-review check gates it. `type` is nominal — `legacy` is
    // the discriminant callers act on. `spatial-3d` (not `none`) so a naive
    // `type === "none"` shortcut can never skip the legacy check.
    return { type: "spatial-3d", legacy: true };
  }
  return { type: "none", legacy: false };
}

export type SubagentDefinition = {
  readonly description: string;
  readonly tools: readonly string[];
  readonly writable?: readonly string[];
};

export type AgentProfile = {
  readonly tools: readonly string[];
  readonly subagents?: Readonly<Record<string, SubagentDefinition>>;
  readonly writable?: readonly string[];
  readonly max_findings?: number;
  readonly model?: "sonnet" | "opus" | "haiku" | "inherit";
  readonly permissions?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
};

/**
 * Runtime substrate declaration for a protocol.
 *
 * `deps` is declarative only — it documents what the protocol expects to be
 * available and drives non-python dep validation (binary/conda/env) — it is
 * NOT an install source. The authoritative install manifest for a substrate
 * env is `<skillDir>/environment.yml` (conda/micromamba env spec), consumed
 * by `ensureRuntime()` when a missing env is first created.
 */
export type ProtocolRuntime = {
  readonly substrate?: string;
  readonly deps: readonly RuntimeDep[];
};

export type ProtocolExpects = Readonly<
  Record<string, string | number | readonly string[]>
>;

/** protocol.yaml execution plan (design §7). */
export type ProtocolYaml = {
  readonly kind: "protocol";
  readonly name: string;
  readonly version: number;
  readonly expects: ProtocolExpects;
  readonly inspect?: string;
  readonly phases: readonly ProtocolPhase[];
  readonly sanity_checks?: string;
  readonly runtime: ProtocolRuntime;
  readonly parent_skills: readonly string[];
  readonly agents: Readonly<Record<string, AgentProfile>> & {
    readonly worker: AgentProfile;
    readonly "gate-reviewer": AgentProfile;
  };
  readonly requires?: SkillRequires;
};

function validateRoleRequirements(
  value: unknown,
  path: string,
): ValidationResult<RoleRequirements | undefined> {
  if (value === undefined || value === null) {
    return success(undefined);
  }
  const rec = expectRecord(value, path);
  if (!rec.ok) return rec;

  const tools = expectOptional(rec.value["tools"], `${path}.tools`, (v, p) =>
    expectStringArray(v, p),
  );
  if (!tools.ok) return tools;

  const runtime = expectOptional(
    rec.value["runtime"],
    `${path}.runtime`,
    (v, p) => validateRuntimeDepArray(v, p),
  );
  if (!runtime.ok) return runtime;

  const writable = expectOptional(
    rec.value["writable"],
    `${path}.writable`,
    (v, p) => expectStringArray(v, p),
  );
  if (!writable.ok) return writable;

  const req: RoleRequirements = {
    ...(tools.value !== undefined ? { tools: tools.value } : {}),
    ...(runtime.value !== undefined ? { runtime: runtime.value } : {}),
    ...(writable.value !== undefined ? { writable: writable.value } : {}),
  };
  return success(req);
}

function validateSkillRequires(
  value: unknown,
  path: string,
): ValidationResult<SkillRequires | undefined> {
  if (value === undefined || value === null) {
    return success(undefined);
  }
  const rec = expectRecord(value, path);
  if (!rec.ok) return rec;

  const worker = validateRoleRequirements(rec.value["worker"], `${path}.worker`);
  if (!worker.ok) return worker;
  const reviewer = validateRoleRequirements(
    rec.value["reviewer"],
    `${path}.reviewer`,
  );
  if (!reviewer.ok) return reviewer;

  const out: SkillRequires = {
    ...(worker.value !== undefined ? { worker: worker.value } : {}),
    ...(reviewer.value !== undefined ? { reviewer: reviewer.value } : {}),
  };
  return success(out);
}

function validateSubphase(
  value: unknown,
  path: string,
): ValidationResult<ProtocolSubphase> {
  const rec = expectRecord(value, path);
  if (!rec.ok) return rec;

  const id = expectNonEmptyString(rec.value["id"], `${path}.id`);
  if (!id.ok) return id;

  const depends_on = expectOptional(
    rec.value["depends_on"],
    `${path}.depends_on`,
    (v, p) => expectStringArray(v, p),
  );
  if (!depends_on.ok) return depends_on;

  return success({
    id: id.value,
    ...(depends_on.value !== undefined
      ? { depends_on: depends_on.value }
      : {}),
  });
}

function validatePhase(
  value: unknown,
  path: string,
): ValidationResult<ProtocolPhase> {
  const rec = expectRecord(value, path);
  if (!rec.ok) return rec;

  const id = expectNonEmptyString(rec.value["id"], `${path}.id`);
  if (!id.ok) return id;

  const skills = expectStringArray(rec.value["skills"], `${path}.skills`);
  if (!skills.ok) return skills;

  const inputs = expectOptional(rec.value["inputs"], `${path}.inputs`, (v, p) =>
    expectStringArray(v, p),
  );
  if (!inputs.ok) return inputs;

  const outputs = expectOptional(
    rec.value["outputs"],
    `${path}.outputs`,
    (v, p) => expectStringArray(v, p),
  );
  if (!outputs.ok) return outputs;

  let subphases: readonly ProtocolSubphase[] | undefined;
  if (rec.value["subphases"] !== undefined) {
    const arr = expectArray(rec.value["subphases"], `${path}.subphases`);
    if (!arr.ok) return arr;
    const parsed: ProtocolSubphase[] = [];
    for (let i = 0; i < arr.value.length; i++) {
      const sp = validateSubphase(arr.value[i], `${path}.subphases[${i}]`);
      if (!sp.ok) return sp;
      parsed.push(sp.value);
    }
    subphases = parsed;
  }

  const agent = expectOptional(rec.value["agent"], `${path}.agent`, (v, p) =>
    expectNonEmptyString(v, p),
  );
  if (!agent.ok) return agent;

  const cdn_allowlist = expectOptional(
    rec.value["cdn_allowlist"],
    `${path}.cdn_allowlist`,
    (v, p) => expectStringArray(v, p),
  );
  if (!cdn_allowlist.ok) return cdn_allowlist;

  const review_artifact = expectOptional(
    rec.value["review_artifact"],
    `${path}.review_artifact`,
    (v, p) => validateReviewArtifactSpec(v, p),
  );
  if (!review_artifact.ok) return review_artifact;

  const phase: ProtocolPhase = {
    id: id.value,
    skills: skills.value,
    ...(inputs.value !== undefined ? { inputs: inputs.value } : {}),
    ...(outputs.value !== undefined ? { outputs: outputs.value } : {}),
    ...(subphases !== undefined ? { subphases } : {}),
    ...(agent.value !== undefined ? { agent: agent.value } : {}),
    ...(cdn_allowlist.value !== undefined ? { cdn_allowlist: cdn_allowlist.value } : {}),
    ...(review_artifact.value !== undefined
      ? { review_artifact: review_artifact.value }
      : {}),
  };

  // Author-generated non-legacy sites are offline by default: a `cdn_allowlist`
  // on a phase that resolves to `none` is contradictory (design §3.D). Legacy
  // review-site phases keep their allowlist (the existing G6 uses it).
  if (
    cdn_allowlist.value !== undefined &&
    cdn_allowlist.value.length > 0
  ) {
    const resolved = resolveReviewArtifact(phase);
    if (resolved.type === "none" && !resolved.legacy) {
      return failure([
        {
          path: `${path}.cdn_allowlist`,
          message:
            "cdn_allowlist is not allowed on a phase with no review artifact (type: none); author-generated sites are offline by default",
        },
      ]);
    }
  }

  return success(phase);
}

const TEMPLATE_PATH_CHARS = /[/.\\]/;

function validateReviewArtifactSpec(
  value: unknown,
  path: string,
): ValidationResult<ReviewArtifactSpec> {
  const rec = expectRecord(value, path);
  if (!rec.ok) return rec;

  const type = expectOptional(rec.value["type"], `${path}.type`, (v, p) =>
    expectEnum(v, p, REVIEW_ARTIFACT_TYPES),
  );
  if (!type.ok) return type;

  const template = expectOptional(
    rec.value["template"],
    `${path}.template`,
    (v, p) => expectNonEmptyString(v, p),
  );
  if (!template.ok) return template;

  // A template is a registry id, never a path: reject path-like values so it
  // can never escape the vendored skill dir (design §3.D).
  if (template.value !== undefined && TEMPLATE_PATH_CHARS.test(template.value)) {
    return failure([
      {
        path: `${path}.template`,
        message: `template must be a registry id, not a path (got "${template.value}")`,
      },
    ]);
  }

  return success({
    ...(type.value !== undefined ? { type: type.value } : {}),
    ...(template.value !== undefined ? { template: template.value } : {}),
  });
}

function validateSubagentDefinition(
  value: unknown,
  path: string,
): ValidationResult<SubagentDefinition> {
  const rec = expectRecord(value, path);
  if (!rec.ok) return rec;

  const description = expectNonEmptyString(
    rec.value["description"],
    `${path}.description`,
  );
  if (!description.ok) return description;

  const tools = expectStringArray(rec.value["tools"], `${path}.tools`);
  if (!tools.ok) return tools;

  const writable = expectOptional(
    rec.value["writable"],
    `${path}.writable`,
    (v, p) => expectStringArray(v, p),
  );
  if (!writable.ok) return writable;

  return success({
    description: description.value,
    tools: tools.value,
    ...(writable.value !== undefined ? { writable: writable.value } : {}),
  });
}

function validateAgentProfile(
  value: unknown,
  path: string,
): ValidationResult<AgentProfile> {
  const rec = expectRecord(value, path);
  if (!rec.ok) return rec;

  const tools = expectStringArray(rec.value["tools"], `${path}.tools`);
  if (!tools.ok) return tools;

  const writable = expectOptional(
    rec.value["writable"],
    `${path}.writable`,
    (v, p) => expectStringArray(v, p),
  );
  if (!writable.ok) return writable;

  const max_findings = expectOptional(
    rec.value["max_findings"],
    `${path}.max_findings`,
    (v, p) => expectNumber(v, p),
  );
  if (!max_findings.ok) return max_findings;

  const model = expectOptional(rec.value["model"], `${path}.model`, (v, p) =>
    expectEnum(v, p, AGENT_PROFILE_MODELS),
  );
  if (!model.ok) return model;

  const permissions = expectOptional(
    rec.value["permissions"],
    `${path}.permissions`,
    (v, p) => expectEnum(v, p, AGENT_PROFILE_PERMISSIONS),
  );
  if (!permissions.ok) return permissions;

  let subagents: Readonly<Record<string, SubagentDefinition>> | undefined;
  if (rec.value["subagents"] !== undefined) {
    const subRec = expectRecord(rec.value["subagents"], `${path}.subagents`);
    if (!subRec.ok) return subRec;
    const map: Record<string, SubagentDefinition> = {};
    for (const [key, val] of Object.entries(subRec.value)) {
      const def = validateSubagentDefinition(val, `${path}.subagents.${key}`);
      if (!def.ok) return def;
      map[key] = def.value;
    }
    subagents = map;
  }

  return success({
    tools: tools.value,
    ...(writable.value !== undefined ? { writable: writable.value } : {}),
    ...(max_findings.value !== undefined
      ? { max_findings: max_findings.value }
      : {}),
    ...(model.value !== undefined ? { model: model.value } : {}),
    ...(permissions.value !== undefined ? { permissions: permissions.value } : {}),
    ...(subagents !== undefined ? { subagents } : {}),
  });
}

function validateExpects(
  value: unknown,
  path: string,
): ValidationResult<ProtocolExpects> {
  const rec = expectRecord(value, path);
  if (!rec.ok) return rec;

  const out: Record<string, string | number | readonly string[]> = {};
  for (const [key, val] of Object.entries(rec.value)) {
    if (typeof val === "string") {
      out[key] = val;
    } else if (typeof val === "number") {
      out[key] = val;
    } else if (Array.isArray(val) && val.every((x) => typeof x === "string")) {
      out[key] = val;
    } else {
      return failure([
        {
          path: `${path}.${key}`,
          message: "expects values must be string, number, or string array",
        },
      ]);
    }
  }
  return success(out as ProtocolExpects);
}

export function validateProtocolYaml(
  value: unknown,
): ValidationResult<ProtocolYaml> {
  const rec = expectRecord(value, "$");
  if (!rec.ok) return rec;

  const kind = expectEnum(rec.value["kind"], "$.kind", ["protocol"] as const);
  if (!kind.ok) return kind;

  const name = expectNonEmptyString(rec.value["name"], "$.name");
  if (!name.ok) return name;

  const version = expectNumber(rec.value["version"], "$.version");
  if (!version.ok) return version;

  const expects = validateExpects(rec.value["expects"], "$.expects");
  if (!expects.ok) return expects;

  const inspect = expectOptional(rec.value["inspect"], "$.inspect", (v, p) =>
    expectNonEmptyString(v, p),
  );
  if (!inspect.ok) return inspect;

  const phasesArr = expectArray(rec.value["phases"], "$.phases");
  if (!phasesArr.ok) return phasesArr;
  if (phasesArr.value.length === 0) {
    return failure([{ path: "$.phases", message: "expected at least one phase" }]);
  }
  const phases: ProtocolPhase[] = [];
  const seenPhaseIds = new Set<string>();
  for (let i = 0; i < phasesArr.value.length; i++) {
    const phase = validatePhase(phasesArr.value[i], `$.phases[${i}]`);
    if (!phase.ok) return phase;
    if (seenPhaseIds.has(phase.value.id)) {
      return failure([
        {
          path: `$.phases[${i}].id`,
          message: `duplicate phase id: ${phase.value.id}`,
        },
      ]);
    }
    seenPhaseIds.add(phase.value.id);

    const subphases = phase.value.subphases ?? [];
    const seenSubphaseIds = new Set<string>();
    for (let j = 0; j < subphases.length; j++) {
      const sp = subphases[j];
      if (sp && seenSubphaseIds.has(sp.id)) {
        return failure([
          {
            path: `$.phases[${i}].subphases[${j}].id`,
            message: `duplicate subphase id in phase "${phase.value.id}": ${sp.id}`,
          },
        ]);
      }
      if (sp) {
        seenSubphaseIds.add(sp.id);
      }
    }

    phases.push(phase.value);
  }

  const sanity_checks = expectOptional(
    rec.value["sanity_checks"],
    "$.sanity_checks",
    (v, p) => expectString(v, p),
  );
  if (!sanity_checks.ok) return sanity_checks;

  const runtimeRec = expectRecord(rec.value["runtime"], "$.runtime");
  if (!runtimeRec.ok) return runtimeRec;

  const substrate = expectOptional(
    runtimeRec.value["substrate"],
    "$.runtime.substrate",
    (v, p) => expectString(v, p),
  );
  if (!substrate.ok) return substrate;

  const deps = validateRuntimeDepArray(
    runtimeRec.value["deps"] ?? [],
    "$.runtime.deps",
  );
  if (!deps.ok) return deps;

  const parent_skills = expectStringArray(
    rec.value["parent_skills"] ?? [],
    "$.parent_skills",
  );
  if (!parent_skills.ok) return parent_skills;

  const agentsRec = expectRecord(rec.value["agents"], "$.agents");
  if (!agentsRec.ok) return agentsRec;

  const worker = validateAgentProfile(agentsRec.value["worker"], "$.agents.worker");
  if (!worker.ok) return worker;

  const gateReviewer = validateAgentProfile(
    agentsRec.value["gate-reviewer"],
    "$.agents.gate-reviewer",
  );
  if (!gateReviewer.ok) return gateReviewer;

  const agentsMap: Record<string, AgentProfile> = {
    worker: worker.value,
    "gate-reviewer": gateReviewer.value,
  };
  for (const [key, val] of Object.entries(agentsRec.value)) {
    if (key === "worker" || key === "gate-reviewer") continue;
    if (!isRecord(val)) {
      return failure([
        { path: `$.agents.${key}`, message: "expected agent profile object" },
      ]);
    }
    const profile = validateAgentProfile(val, `$.agents.${key}`);
    if (!profile.ok) return profile;
    agentsMap[key] = profile.value;
  }

  const agents = agentsMap as ProtocolYaml["agents"];

  const requires = validateSkillRequires(rec.value["requires"], "$.requires");
  if (!requires.ok) return requires;

  const protocol: ProtocolYaml = {
    kind: "protocol",
    name: name.value,
    version: version.value,
    expects: expects.value,
    ...(inspect.value !== undefined ? { inspect: inspect.value } : {}),
    phases,
    ...(sanity_checks.value !== undefined
      ? { sanity_checks: sanity_checks.value }
      : {}),
    runtime: {
      ...(substrate.value !== undefined ? { substrate: substrate.value } : {}),
      deps: deps.value,
    },
    parent_skills: parent_skills.value,
    agents,
    ...(requires.value !== undefined ? { requires: requires.value } : {}),
  };

  return success(protocol);
}
