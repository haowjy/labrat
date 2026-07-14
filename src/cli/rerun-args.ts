export type ParsedRerunArgs = {
  readonly taskId: string | undefined;
  readonly fromPhase: string | undefined;
  readonly force: boolean;
};

const RERUN_FLAGS = new Set(["--force", "--no-dashboard"]);

/** Parse the positional portion of `labrat rerun` while keeping CLI flags out
 * of the optional phase slot. */
export function parseRerunArgs(args: readonly string[]): ParsedRerunArgs {
  const positional = args.filter((arg) => !RERUN_FLAGS.has(arg));
  return {
    taskId: positional[0],
    fromPhase: positional[1],
    force: args.includes("--force"),
  };
}
