import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ProtocolYaml } from "../../schema/index.js";
import { archiveAndResetPhase, invalidateFromPhase } from "./invalidation.js";

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

const protocolYaml = {
  kind: "protocol",
  name: "test-protocol",
  version: 1,
  expects: { modality: "microct", species: "mouse" },
  agents: { worker: { model: "test" }, reviewer: { model: "test" } },
  phases: [
    { id: "intake", skills: [], inputs: [], outputs: [] },
    {
      id: "segmentation",
      skills: [],
      inputs: [],
      outputs: ["labels.nii.gz"],
    },
  ],
} as unknown as ProtocolYaml;

// The real protocol SCATTERS a phase's outputs across artifacts/ under names
// that are NOT the phase id (spacing.json, labels.nii.gz, masks/), so a blind
// `rm artifacts/<phaseId>` would miss them. reset-to now invalidates by
// DECLARED OUTPUTS (F1), which this protocol exercises.
const scatteredProtocol = {
  kind: "protocol",
  name: "scattered-protocol",
  version: 1,
  expects: { modality: "microct", species: "mouse" },
  agents: { worker: { model: "test" }, reviewer: { model: "test" } },
  phases: [
    { id: "intake", skills: [], inputs: [], outputs: ["spacing.json"] },
    {
      id: "segmentation",
      skills: [],
      inputs: ["spacing.json"],
      outputs: ["labels.nii.gz", "masks/"],
    },
    {
      id: "measure",
      skills: [],
      inputs: ["labels.nii.gz"],
      outputs: ["measurements/thickness.json"],
    },
  ],
} as unknown as ProtocolYaml;

describe("invalidateFromPhase (F1 — reset-to clears SCATTERED declared outputs)", () => {
  it("removes each downstream phase's declared outputs by name, leaving upstream intact", async () => {
    const taskDir = await mkdtemp(join(tmpdir(), "labrat-invalidation-"));
    try {
      const art = (rel: string) => join(taskDir, "artifacts", rel);
      // Materialize a completed run: intake + segmentation + measure outputs,
      // all scattered under artifacts/ (dirs ≠ phase ids).
      await mkdir(join(taskDir, "artifacts", "masks"), { recursive: true });
      await mkdir(join(taskDir, "artifacts", "measurements"), { recursive: true });
      await writeFile(art("spacing.json"), '{"spacing":[1,1,1]}');
      await writeFile(art("labels.nii.gz"), "LABELS");
      await writeFile(art("masks/femur.nii.gz"), "MASK");
      await writeFile(art("measurements/thickness.json"), '{"t":0.1}');
      for (const id of ["intake", "segmentation", "measure"]) {
        await mkdir(join(taskDir, "phases", id), { recursive: true });
      }

      // reset-to segmentation → invalidate segmentation + measure, keep intake.
      await invalidateFromPhase(taskDir, scatteredProtocol, "segmentation");

      // Upstream (intake) output survives — reset-to never touches it.
      assert.equal(await exists(art("spacing.json")), true);
      // Downstream scattered outputs are cleared, though their names are not
      // the phase id (the old rm artifacts/<phaseId> would have missed them).
      assert.equal(await exists(art("labels.nii.gz")), false);
      assert.equal(await exists(art("masks")), false);
      assert.equal(await exists(art("measurements/thickness.json")), false);
    } finally {
      await rm(taskDir, { recursive: true, force: true });
    }
  });
});

describe("archiveAndResetPhase (F3 — retried gate gets a fresh reviewer)", () => {
  it("archives review/gates/{phase}.trust-boundary.json alongside the gate file", async () => {
    const taskDir = await mkdtemp(join(tmpdir(), "labrat-invalidation-"));
    try {
      await mkdir(join(taskDir, "phases", "segmentation"), { recursive: true });
      await mkdir(join(taskDir, "review", "gates"), { recursive: true });
      await writeFile(
        join(taskDir, "review", "gates", "segmentation.json"),
        JSON.stringify({ decision: "fail" }),
      );
      await writeFile(
        join(taskDir, "review", "gates", "segmentation.trust-boundary.json"),
        JSON.stringify({ ok: true, violations: [] }),
      );

      await archiveAndResetPhase(taskDir, protocolYaml, "segmentation");

      const gatesEntries = await readdir(join(taskDir, "review", "gates"));
      assert.ok(gatesEntries.includes("segmentation.attempt-1.json"));
      assert.ok(
        gatesEntries.includes("segmentation.attempt-1.trust-boundary.json"),
      );
      assert.equal(
        await exists(join(taskDir, "review", "gates", "segmentation.json")),
        false,
      );
      assert.equal(
        await exists(
          join(taskDir, "review", "gates", "segmentation.trust-boundary.json"),
        ),
        false,
      );
    } finally {
      await rm(taskDir, { recursive: true, force: true });
    }
  });

  it("removes review/verification/{phase}/ so a retried gate's reviewer starts fresh", async () => {
    const taskDir = await mkdtemp(join(tmpdir(), "labrat-invalidation-"));
    try {
      await mkdir(join(taskDir, "phases", "segmentation"), { recursive: true });
      await mkdir(join(taskDir, "review", "gates"), { recursive: true });
      await mkdir(join(taskDir, "review", "verification", "segmentation"), {
        recursive: true,
      });
      await writeFile(
        join(taskDir, "review", "verification", "segmentation", "check.py"),
        "print('stale verification from a failed attempt')",
      );

      await archiveAndResetPhase(taskDir, protocolYaml, "segmentation");

      assert.equal(
        await exists(join(taskDir, "review", "verification", "segmentation")),
        false,
      );
    } finally {
      await rm(taskDir, { recursive: true, force: true });
    }
  });
});
