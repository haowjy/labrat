import { join } from "node:path";
import { DEFAULT_SCIENCE_HOME } from "../../config/index.js";

/** Options for path resolution and env creation behavior. */
export type EnsureRuntimeOptions = {
  /** Override Claude Science home. Callers should thread `LabratConfig.scienceHome`
   * here; falls back to the same built-in default as `src/config` when omitted. */
  readonly claudeScienceHome?: string;
  /** Override conda/micromamba root (default: LABRAT_CONDA_ROOT or $CLAUDE_SCIENCE_HOME/conda). */
  readonly condaRoot?: string;
  /** microct_analysis source tree for PYTHONPATH. Callers should thread
   * `LabratConfig.microctSrc`; null (the default) means PYTHONPATH is left
   * untouched — there is no personal-path fallback. */
  readonly microctSrcPath?: string | null;
  /** Extra runtime deps from resolved phase skills (unioned at task start). */
  readonly skillRuntimeDeps?: readonly import("../../schema/index.js").RuntimeDep[];
  /** When false, fail instead of creating or pip-installing missing deps. Default true. */
  readonly createIfMissing?: boolean;
};

export type RuntimePaths = {
  readonly claudeScienceHome: string;
  readonly condaRoot: string;
  readonly micromambaPath: string;
  readonly microctSrcPath: string | null;
};

export function resolveRuntimePaths(
  opts?: EnsureRuntimeOptions,
): RuntimePaths {
  const claudeScienceHome = opts?.claudeScienceHome ?? DEFAULT_SCIENCE_HOME;

  const condaRoot =
    opts?.condaRoot ??
    process.env["LABRAT_CONDA_ROOT"] ??
    join(claudeScienceHome, "conda");

  const microctSrcPath = opts?.microctSrcPath ?? null;

  return {
    claudeScienceHome,
    condaRoot,
    micromambaPath: join(condaRoot, "bin", "micromamba"),
    microctSrcPath,
  };
}

export function envPythonPath(
  paths: RuntimePaths,
  substrate: string,
): string {
  return join(paths.condaRoot, "envs", substrate, "bin", "python");
}

/** Baseline pip specs for the microct_analysis substrate (proven recipe). */
export const MICROCT_ANALYSIS_PIP_SPECS = [
  "numpy",
  "nibabel>=5",
  "pydicom>=2.4",
  "scikit-image>=0.22",
  "scipy",
  "SimpleITK>=2.3",
  "pyyaml",
  "openpyxl",
  "matplotlib",
] as const;
