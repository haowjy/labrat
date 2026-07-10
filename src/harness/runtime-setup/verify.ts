/**
 * Manual smoke: verify ensureRuntime against the proven microct_analysis env.
 * Run: npx tsx src/harness/runtime-setup/verify.ts
 */
import { ensureRuntime, pythonRuntime } from "./index.js";
import { runCommand } from "./subprocess.js";
import type { ProtocolYaml } from "../../schema/index.js";

const minimalProtocol: ProtocolYaml = {
  kind: "protocol",
  name: "runtime-verify",
  version: 1,
  expects: { modality: "CT" },
  phases: [{ id: "segmentation", skills: ["segmentation-bone-ct"] }],
  runtime: {
    substrate: "microct_analysis",
    deps: ["nibabel", "pydicom", "scikit-image", "scipy", "matplotlib"],
  },
  parent_skills: [],
  agents: {
    worker: { tools: ["Bash"] },
    "gate-reviewer": { tools: ["Read"] },
  },
  requires: {
    worker: { runtime: ["python:scipy"] },
    reviewer: { runtime: ["nibabel"] },
  },
};

async function main(): Promise<void> {
  console.log("=== ensureRuntime (verify-first, no reinstall expected) ===\n");
  const result = await ensureRuntime(minimalProtocol);
  for (const line of result.logs) {
    console.log(`  ${line}`);
  }
  if (!result.ok) {
    console.error("\nFAILED:");
    for (const err of result.errors) {
      console.error(`  ${err}`);
    }
    process.exit(1);
  }
  console.log("\n=== pythonRuntime handle probe ===\n");
  const rt = pythonRuntime();
  console.log(JSON.stringify(rt, null, 2));

  const probe = await runCommand(
    rt.pythonPath,
    [
      "-c",
      "import microct_analysis, sys; print('executable', sys.executable); print('microct_analysis OK')",
    ],
    { ...process.env, ...rt.env },
  );
  console.log("\n=== handle subprocess probe ===");
  console.log(probe.stdout.trim());
  if (probe.code !== 0) {
    console.error(probe.stderr);
    process.exit(1);
  }
  console.log("\nOK");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
