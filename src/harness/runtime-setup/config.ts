import { homedir } from "node:os";
import { join } from "node:path";

/** Options for path resolution and env creation behavior. */
export type EnsureRuntimeOptions = {
  /** Override Claude Science home (default: config → CLAUDE_SCIENCE_HOME → ~/.claude-science). */
  readonly claudeScienceHome?: string;
  /** Override conda/micromamba root (default: LABRAT_CONDA_ROOT or $CLAUDE_SCIENCE_HOME/conda). */
  readonly condaRoot?: string;
  /** Override microct_analysis source tree for PYTHONPATH (default: LABRAT_MICROCT_SRC). */
  readonly microctSrcPath?: string;
  /** Extra runtime deps from resolved phase skills (unioned at task start). */
  readonly skillRuntimeDeps?: readonly import("../../schema/index.js").RuntimeDep[];
  /** When false, fail instead of creating or pip-installing missing deps. Default true. */
  readonly createIfMissing?: boolean;
};

export type RuntimePaths = {
  readonly claudeScienceHome: string;
  readonly condaRoot: string;
  readonly micromambaPath: string;
  readonly microctSrcPath: string;
};

/** Proven default for LABRAT_MICROCT_SRC on the reference machine. */
const DEFAULT_MICROCT_SRC = join(
  homedir(),
  "gitrepos",
  "prompts",
  "microct-analysis",
  "src",
);

export function resolveRuntimePaths(
  opts?: EnsureRuntimeOptions,
): RuntimePaths {
  const claudeScienceHome =
    opts?.claudeScienceHome ??
    process.env["CLAUDE_SCIENCE_HOME"] ??
    join(homedir(), ".claude-science");

  const condaRoot =
    opts?.condaRoot ??
    process.env["LABRAT_CONDA_ROOT"] ??
    join(claudeScienceHome, "conda");

  const microctSrcPath =
    opts?.microctSrcPath ??
    process.env["LABRAT_MICROCT_SRC"] ??
    DEFAULT_MICROCT_SRC;

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
