/**
 * RuntimeHandle — contract for worker/reviewer session lanes.
 *
 * After `ensureRuntime()` succeeds, `pythonRuntime()` returns this handle.
 * Every Bash or Python subprocess that runs imaging code MUST use:
 *
 * - `pythonPath` — dedicated substrate interpreter (no shell activation)
 * - `env` — at minimum `PYTHONPATH` (microct_analysis source) and `MPLBACKEND=Agg`
 * - `substrate` — conda env name (e.g. `microct_analysis`)
 *
 * Example (Node spawn):
 * ```ts
 * const rt = pythonRuntime();
 * spawn(rt.pythonPath, ["script.py"], { env: { ...process.env, ...rt.env } });
 * ```
 */
export type RuntimeHandle = {
  /** Absolute path to the substrate conda env python binary. */
  readonly pythonPath: string;
  /** Env vars required on every imaging subprocess (merged over process.env). */
  readonly env: Readonly<Record<string, string>>;
  /** Conda env / substrate name from protocol.runtime.substrate. */
  readonly substrate: string;
};

export type RuntimeSetupResult = {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly logs: readonly string[];
  readonly handle?: RuntimeHandle;
};
