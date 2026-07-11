import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { diffTrustBoundary, snapshotTrustBoundary } from "./trust-boundary.js";

async function makeTaskDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "labrat-trust-boundary-"));
  await mkdir(join(dir, "artifacts"), { recursive: true });
  await mkdir(join(dir, "phases", "segmentation"), { recursive: true });
  await mkdir(join(dir, "phases", "intake"), { recursive: true });
  await mkdir(join(dir, "review", "gates"), { recursive: true });
  await mkdir(join(dir, "provenance"), { recursive: true });
  await writeFile(join(dir, "phases", "intake", "summary.md"), "intake done");
  await writeFile(
    join(dir, "phases", "segmentation", "summary.md"),
    "segmentation done",
  );
  await writeFile(
    join(dir, "task.json"),
    JSON.stringify({ id: "task-test-001" }),
  );
  await writeFile(
    join(dir, "review", "gates", "intake.json"),
    JSON.stringify({ phase: "intake", decision: "pass" }),
  );
  await writeFile(
    join(dir, "provenance", "manifest.yaml"),
    "entries: []\n",
  );
  return dir;
}

describe("trust boundary", () => {
  it("flags a write under a phase dir other than the one under gate", async () => {
    const taskDir = await makeTaskDir();
    try {
      const before = await snapshotTrustBoundary(taskDir);
      // A malicious/careless reviewer touching an upstream phase's output
      // while ostensibly gating `segmentation` — must be caught, not just
      // writes under `phases/segmentation/`.
      await writeFile(
        join(taskDir, "phases", "intake", "summary.md"),
        "tampered by reviewer",
      );
      const after = await snapshotTrustBoundary(taskDir);
      const result = diffTrustBoundary(before, after);

      assert.equal(result.ok, false);
      assert.ok(
        result.violations.some(
          (v) =>
            v.area === "phases" &&
            v.path === join("intake", "summary.md") &&
            v.kind === "modified",
        ),
      );
    } finally {
      await rm(taskDir, { recursive: true, force: true });
    }
  });

  it("flags writes to task.json, review/gates/, review/verdict/, review/monitor/, and provenance/manifest.yaml", async () => {
    const taskDir = await makeTaskDir();
    try {
      const before = await snapshotTrustBoundary(taskDir);
      await writeFile(join(taskDir, "task.json"), JSON.stringify({ id: "tampered" }));
      await writeFile(
        join(taskDir, "review", "gates", "intake.json"),
        JSON.stringify({ phase: "intake", decision: "pass-with-concerns" }),
      );
      // A reviewer (who has Bash) writing a verdict file directly would forge a
      // HUMAN decision — the dashboard reads review/verdict/ as legitimate.
      await mkdir(join(taskDir, "review", "verdict"), { recursive: true });
      await writeFile(
        join(taskDir, "review", "verdict", "segmentation.json"),
        JSON.stringify({ phase: "segmentation", verdict: "approve" }),
      );
      await mkdir(join(taskDir, "review", "monitor"), { recursive: true });
      await writeFile(
        join(taskDir, "review", "monitor", "segmentation.json"),
        JSON.stringify({ phase: "segmentation", status: "clean" }),
      );
      await writeFile(join(taskDir, "provenance", "manifest.yaml"), "entries: [x]\n");
      const after = await snapshotTrustBoundary(taskDir);
      const result = diffTrustBoundary(before, after);

      assert.equal(result.ok, false);
      const areas = result.violations.map((v) => v.area).sort();
      assert.deepEqual(areas, [
        "provenance-manifest",
        "review-gates",
        "review-monitor",
        "review-verdict",
        "task-json",
      ]);
      assert.ok(
        result.violations.some(
          (v) => v.area === "review-verdict" && v.path === "segmentation.json" && v.kind === "added",
        ),
      );
    } finally {
      await rm(taskDir, { recursive: true, force: true });
    }
  });

  it("does NOT flag writes under review/verification/{phase}/ — the reviewer's legal scratch space", async () => {
    const taskDir = await makeTaskDir();
    try {
      const before = await snapshotTrustBoundary(taskDir);
      await mkdir(join(taskDir, "review", "verification", "segmentation"), {
        recursive: true,
      });
      await writeFile(
        join(taskDir, "review", "verification", "segmentation", "check.py"),
        "print('verifying')",
      );
      await writeFile(
        join(taskDir, "review", "verification", "segmentation", "output.txt"),
        "voxel counts look right",
      );
      const after = await snapshotTrustBoundary(taskDir);
      const result = diffTrustBoundary(before, after);

      assert.equal(result.ok, true);
      assert.deepEqual(result.violations, []);
    } finally {
      await rm(taskDir, { recursive: true, force: true });
    }
  });
});
