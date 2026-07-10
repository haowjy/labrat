import type { ProtocolYaml } from "../../schema/index.js";
import {
  envPythonPath,
  MICROCT_ANALYSIS_PIP_SPECS,
  resolveRuntimePaths,
  type EnsureRuntimeOptions,
} from "./config.js";
import {
  depKey,
  mergeRuntimeDeps,
  pipSpecForPythonDep,
  pythonImportModule,
  type NormalizedRuntimeDep,
} from "./deps.js";
import { pathExists, runCommand } from "./subprocess.js";
import type { RuntimeHandle, RuntimeSetupResult } from "./types.js";

export type { EnsureRuntimeOptions, RuntimePaths } from "./config.js";
export type { NormalizedRuntimeDep } from "./deps.js";
export type { RuntimeHandle, RuntimeSetupResult } from "./types.js";
export { mergeRuntimeDeps, normalizeRuntimeDep } from "./deps.js";

const DEFAULT_SUBSTRATE = "microct_analysis";

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
 * TODO(#2): make substrate deps protocol-driven — the microct_analysis
 * substrate/pip-install recipe below is still hardcoded (out of scope for
 * the config seam cleanup; a separate pass should drive this from
 * protocol.yaml runtime.deps instead of DEFAULT_SUBSTRATE/MICROCT_ANALYSIS_PIP_SPECS).
 * Tracked: https://github.com/haowjy/labrat/issues/2
 */
export async function ensureRuntime(
  protocol: ProtocolYaml,
  opts?: EnsureRuntimeOptions,
): Promise<RuntimeSetupResult> {
  const logs: string[] = [];
  const errors: string[] = [];
  const createIfMissing = opts?.createIfMissing ?? true;

  const paths = resolveRuntimePaths(opts);
  const substrate = protocol.runtime.substrate ?? DEFAULT_SUBSTRATE;
  const pythonPath = envPythonPath(paths, substrate);
  const mergedDeps = mergeRuntimeDeps(protocol, opts?.skillRuntimeDeps);

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
    logs.push(`creating conda env ${substrate}`);
    const created = await createSubstrateEnv(paths, substrate, logs, errors);
    if (!created) {
      return fail(errors, logs);
    }
  } else {
    logs.push(`substrate env present: ${pythonPath}`);
  }

  const pythonDeps = mergedDeps.filter((d) => d.type === "python");

  for (const dep of mergedDeps.filter((d) => d.type !== "python")) {
    const ok = await validateDep(
      dep,
      paths,
      substrate,
      pythonPath,
      subprocessEnv,
      logs,
      errors,
    );
    if (!ok) {
      return fail(errors, logs);
    }
  }

  const pythonModules = [
    ...new Set(
      pythonDeps
        .filter((d) => d.name !== "microct_analysis")
        .map((d) => pythonImportModule(d.name)),
    ),
  ];

  const needsMicroct =
    substrate === DEFAULT_SUBSTRATE ||
    pythonDeps.some((d) => d.name === "microct_analysis");
  const probeModules = [
    ...pythonModules,
    ...(needsMicroct ? ["microct_analysis"] : []),
  ];

  if (probeModules.length > 0) {
    let importsOk = await probePythonImports(
      pythonPath,
      subprocessEnv,
      probeModules,
      logs,
      errors,
    );
    if (!importsOk) {
      if (!createIfMissing) {
        return fail(errors, logs);
      }
      const pipSpecs = collectPipSpecs(substrate, pythonDeps);
      const installed = await ensurePipPackages(
        pythonPath,
        subprocessEnv,
        pipSpecs,
        logs,
        errors,
      );
      if (!installed) {
        return fail(errors, logs);
      }
      importsOk = await probePythonImports(
        pythonPath,
        subprocessEnv,
        probeModules,
        logs,
        errors,
      );
      if (!importsOk) {
        return fail(errors, logs);
      }
    }
    logs.push(`all python imports OK (${probeModules.join(", ")})`);
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

function collectPipSpecs(
  substrate: string,
  pythonDeps: readonly NormalizedRuntimeDep[],
): string[] {
  const specs = new Set<string>();
  if (substrate === DEFAULT_SUBSTRATE) {
    for (const spec of MICROCT_ANALYSIS_PIP_SPECS) {
      specs.add(spec);
    }
  }
  for (const dep of pythonDeps) {
    if (dep.name === "microct_analysis") {
      continue;
    }
    specs.add(pipSpecForPythonDep(dep.name));
  }
  return [...specs];
}

async function createSubstrateEnv(
  paths: { condaRoot: string; micromambaPath: string },
  substrate: string,
  logs: string[],
  errors: string[],
): Promise<boolean> {
  const result = await runCommand(paths.micromambaPath, [
    "create",
    "-y",
    "-r",
    paths.condaRoot,
    "-n",
    substrate,
    "python=3.11",
    "pip",
  ]);
  if (result.code !== 0) {
    errors.push(
      `micromamba create failed for env ${substrate}: ${trimOutput(result.stderr || result.stdout)}`,
    );
    return false;
  }
  logs.push(`created conda env ${substrate}`);
  return true;
}

async function ensurePipPackages(
  pythonPath: string,
  subprocessEnv: Record<string, string>,
  specs: readonly string[],
  logs: string[],
  errors: string[],
): Promise<boolean> {
  if (specs.length === 0) {
    return true;
  }
  logs.push(`pip install (${specs.length} packages)`);
  const result = await runCommand(
    pythonPath,
    ["-m", "pip", "install", ...specs],
    { ...process.env, ...subprocessEnv },
  );
  if (result.code !== 0) {
    errors.push(`pip install failed: ${trimOutput(result.stderr || result.stdout)}`);
    return false;
  }
  logs.push("pip install OK");
  return true;
}

async function validateDep(
  dep: NormalizedRuntimeDep,
  paths: { condaRoot: string; micromambaPath: string },
  substrate: string,
  pythonPath: string,
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
      if (dep.name === "microct_analysis") {
        return true;
      }
      const mod = pythonImportModule(dep.name);
      return probePythonImports(
        pythonPath,
        subprocessEnv,
        [mod],
        logs,
        errors,
        `python:${dep.name}`,
      );
    }
    default: {
      const _exhaustive: never = dep.type;
      errors.push(`unknown dep type: ${String(_exhaustive)}`);
      return false;
    }
  }
}

async function probePythonImports(
  pythonPath: string,
  subprocessEnv: Record<string, string>,
  modules: readonly string[],
  logs: string[],
  errors: string[],
  label?: string,
): Promise<boolean> {
  const script = `
import importlib, json, sys
mods = json.loads(sys.argv[1])
failed = []
for m in mods:
    try:
        importlib.import_module(m)
    except Exception as e:
        failed.append({"module": m, "error": str(e)})
if failed:
    print(json.dumps({"ok": False, "failed": failed}))
    sys.exit(1)
print(json.dumps({"ok": True, "modules": mods}))
`;
  const result = await runCommand(
    pythonPath,
    ["-c", script, JSON.stringify(modules)],
    { ...process.env, ...subprocessEnv },
  );
  if (result.code !== 0) {
    const tag = label ?? `imports(${modules.join(",")})`;
    errors.push(`${tag} failed: ${trimOutput(result.stdout || result.stderr)}`);
    return false;
  }
  if (label) {
    logs.push(`${label} import OK`);
  }
  return true;
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
