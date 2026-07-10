import { join } from "node:path";
import type { ProtocolYaml } from "../../schema/index.js";
import { envPythonPath, resolveRuntimePaths, type EnsureRuntimeOptions } from "./config.js";
import { depKey, mergeRuntimeDeps, type NormalizedRuntimeDep } from "./deps.js";
import { pathExists, runCommand } from "./subprocess.js";
import type { RuntimeHandle, RuntimeSetupResult } from "./types.js";

export type { EnsureRuntimeOptions, RuntimePaths } from "./config.js";
export type { NormalizedRuntimeDep } from "./deps.js";
export type { RuntimeHandle, RuntimeSetupResult } from "./types.js";
export { mergeRuntimeDeps, normalizeRuntimeDep } from "./deps.js";

let activeHandle: RuntimeHandle | undefined;

/** Returns the handle set by the last successful `ensureRuntime()` call. */
export function pythonRuntime(): RuntimeHandle {
  if (!activeHandle) {
    throw new Error(
      "pythonRuntime(): ensureRuntime() has not succeeded yet",
    );
  }
  return activeHandle;
}

/** Reset module state (for tests). */
export function resetRuntimeHandle(): void {
  activeHandle = undefined;
}

/**
 * Ensure the protocol's runtime substrate exists and all merged deps resolve.
 * Idempotent: verify-first; create/install only when missing.
 *
 * Substrate provisioning is driven by `<skillDir>/environment.yml` (a
 * micromamba/conda env spec) when present, falling back to a bare
 * `python=3.11 + pip` env for zero-dep protocols. `protocol.runtime.deps`
 * remains declarative metadata only (see `ProtocolRuntime`) — it does not
 * drive installation; non-python deps (binary/conda/env) are still verified
 * against the resulting env.
 *
 * TODO(#2): re-provisioning on a changed environment.yml is out of scope —
 * an existing env is never updated. A future pass could `micromamba env
 * update -f environment.yml` when the file's mtime/hash changes.
 */
export async function ensureRuntime(
  protocol: ProtocolYaml,
  opts: EnsureRuntimeOptions,
): Promise<RuntimeSetupResult> {
  const logs: string[] = [];
  const errors: string[] = [];
  const createIfMissing = opts.createIfMissing ?? true;

  const paths = resolveRuntimePaths(opts);
  const substrate = protocol.runtime.substrate;
  if (!substrate) {
    errors.push(
      "protocol.runtime.substrate is required (no default substrate) — set it in protocol.yaml",
    );
    return fail(errors, logs);
  }
  const pythonPath = envPythonPath(paths, substrate);
  const mergedDeps = mergeRuntimeDeps(protocol, opts.skillRuntimeDeps);

  logs.push(`substrate=${substrate}`);
  logs.push(`python=${pythonPath}`);
  logs.push(`merged deps (${mergedDeps.length}): ${mergedDeps.map(depKey).join(", ")}`);

  const subprocessEnv = buildSubprocessEnv(paths);

  const micromambaOk = await pathExists(paths.micromambaPath);
  if (!micromambaOk) {
    errors.push(
      `micromamba not found at ${paths.micromambaPath} — set LABRAT_CONDA_ROOT or install claude-science conda`,
    );
    return fail(errors, logs);
  }

  const envExists = await pathExists(pythonPath);
  if (!envExists) {
    if (!createIfMissing) {
      errors.push(`substrate env missing: ${pythonPath}`);
      return fail(errors, logs);
    }
    const created = await createSubstrateEnv(paths, substrate, opts.skillDir, logs, errors);
    if (!created) {
      return fail(errors, logs);
    }
  } else {
    logs.push(`substrate env present: ${pythonPath}`);
  }

  for (const dep of mergedDeps.filter((d) => d.type !== "python")) {
    const ok = await validateDep(dep, paths, substrate, subprocessEnv, logs, errors);
    if (!ok) {
      return fail(errors, logs);
    }
  }

  const handle: RuntimeHandle = {
    pythonPath,
    env: subprocessEnv,
    substrate,
  };
  activeHandle = handle;
  logs.push("runtime ready");

  return { ok: true, errors: [], logs, handle };
}

function buildSubprocessEnv(paths: {
  microctSrcPath: string | null;
}): Record<string, string> {
  return {
    ...(paths.microctSrcPath !== null ? { PYTHONPATH: paths.microctSrcPath } : {}),
    MPLBACKEND: "Agg",
  };
}

/**
 * Provision the substrate env from `<skillDir>/environment.yml` when present;
 * otherwise fall back to a bare `python=3.11 + pip` env (zero-dep protocols).
 */
async function createSubstrateEnv(
  paths: { condaRoot: string; micromambaPath: string },
  substrate: string,
  skillDir: string,
  logs: string[],
  errors: string[],
): Promise<boolean> {
  const environmentYmlPath = join(skillDir, "environment.yml");
  const hasEnvironmentYml = await pathExists(environmentYmlPath);

  const args = hasEnvironmentYml
    ? ["create", "-y", "-r", paths.condaRoot, "-n", substrate, "-f", environmentYmlPath]
    : ["create", "-y", "-r", paths.condaRoot, "-n", substrate, "python=3.11", "pip"];

  if (hasEnvironmentYml) {
    logs.push(`creating conda env ${substrate} from ${environmentYmlPath}`);
  } else {
    logs.push(
      `no environment.yml found at ${environmentYmlPath} — creating bare conda env ${substrate} (python=3.11, pip)`,
    );
  }

  const result = await runCommand(paths.micromambaPath, args);
  if (result.code !== 0) {
    errors.push(
      `micromamba create failed for env ${substrate}: ${trimOutput(result.stderr || result.stdout)}`,
    );
    return false;
  }
  logs.push(`created conda env ${substrate}`);
  return true;
}

async function validateDep(
  dep: NormalizedRuntimeDep,
  paths: { condaRoot: string; micromambaPath: string },
  substrate: string,
  subprocessEnv: Record<string, string>,
  logs: string[],
  errors: string[],
): Promise<boolean> {
  switch (dep.type) {
    case "binary": {
      const which = await runCommand("which", [dep.name]);
      if (which.code !== 0 || which.stdout.trim().length === 0) {
        errors.push(`missing binary dep: ${dep.name} (not on PATH)`);
        return false;
      }
      logs.push(`binary:${dep.name} → ${which.stdout.trim()}`);
      return true;
    }
    case "conda": {
      const listed = await runCommand(paths.micromambaPath, [
        "list",
        "-r",
        paths.condaRoot,
        "-n",
        substrate,
        dep.name,
      ]);
      if (listed.code !== 0 || !listed.stdout.includes(dep.name)) {
        errors.push(`missing conda dep: ${dep.name} in env ${substrate}`);
        return false;
      }
      logs.push(`conda:${dep.name} present in ${substrate}`);
      return true;
    }
    case "env": {
      // Check the same env a subprocess would actually see (subprocessEnv
      // overrides layered on process.env — see buildSubprocessEnv), not just
      // process.env: a dep declared to come from the conda/runtime env would
      // otherwise pass or fail validation for the wrong reason.
      const value = subprocessEnv[dep.name] ?? process.env[dep.name];
      if (value === undefined || value.length === 0) {
        errors.push(`missing env var dep: ${dep.name}`);
        return false;
      }
      logs.push(`env:${dep.name} present`);
      return true;
    }
    case "python": {
      // Declarative only — package resolution is owned by environment.yml
      // at env-create time (a create failure already fails ensureRuntime
      // above). No per-package import probe here.
      return true;
    }
    default: {
      const _exhaustive: never = dep.type;
      errors.push(`unknown dep type: ${String(_exhaustive)}`);
      return false;
    }
  }
}

function trimOutput(text: string, max = 500): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}

function fail(
  errors: string[],
  logs: string[],
): RuntimeSetupResult {
  activeHandle = undefined;
  return { ok: false, errors, logs };
}
