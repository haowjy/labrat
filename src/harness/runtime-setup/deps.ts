import type {
  ProtocolYaml,
  RuntimeDep,
  RuntimeDepType,
} from "../../schema/index.js";

export type NormalizedRuntimeDep = {
  readonly type: RuntimeDepType;
  readonly name: string;
};

export function normalizeRuntimeDep(dep: RuntimeDep): NormalizedRuntimeDep {
  if (typeof dep === "string") {
    const colon = dep.indexOf(":");
    if (colon === -1) {
      return { type: "python", name: dep };
    }
    const type = dep.slice(0, colon) as RuntimeDepType;
    return { type, name: dep.slice(colon + 1) };
  }
  return dep;
}

export function depKey(dep: NormalizedRuntimeDep): string {
  return `${dep.type}:${dep.name}`;
}

/** Union protocol.runtime.deps + requires.worker/reviewer.runtime + optional skill deps. */
export function mergeRuntimeDeps(
  protocol: ProtocolYaml,
  skillRuntimeDeps?: readonly RuntimeDep[],
): NormalizedRuntimeDep[] {
  const seen = new Map<string, NormalizedRuntimeDep>();

  const add = (dep: RuntimeDep): void => {
    const norm = normalizeRuntimeDep(dep);
    seen.set(depKey(norm), norm);
  };

  for (const dep of protocol.runtime.deps) {
    add(dep);
  }
  const requires = protocol.requires;
  if (requires?.worker?.runtime) {
    for (const dep of requires.worker.runtime) {
      add(dep);
    }
  }
  if (requires?.reviewer?.runtime) {
    for (const dep of requires.reviewer.runtime) {
      add(dep);
    }
  }
  if (skillRuntimeDeps) {
    for (const dep of skillRuntimeDeps) {
      add(dep);
    }
  }

  return [...seen.values()];
}
