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

export type ProtocolPhase = {
  readonly id: string;
  readonly skills: readonly string[];
  readonly inputs?: readonly string[];
  readonly outputs?: readonly string[];
  readonly subphases?: readonly ProtocolSubphase[];
  readonly agent?: string;
};

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
};

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

  return success({
    id: id.value,
    skills: skills.value,
    ...(inputs.value !== undefined ? { inputs: inputs.value } : {}),
    ...(outputs.value !== undefined ? { outputs: outputs.value } : {}),
    ...(subphases !== undefined ? { subphases } : {}),
    ...(agent.value !== undefined ? { agent: agent.value } : {}),
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
  for (let i = 0; i < phasesArr.value.length; i++) {
    const phase = validatePhase(phasesArr.value[i], `$.phases[${i}]`);
    if (!phase.ok) return phase;
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
