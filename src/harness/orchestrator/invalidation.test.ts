import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ProtocolYaml } from "../../schema/index.js";
import { archiveAndResetPhase } from "./invalidation.js";

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
