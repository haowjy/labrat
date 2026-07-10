import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { rebuildVerdict } from "./gate.js";

async function makeGatesDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "labrat-verdict-"));
  await mkdir(join(dir, "review", "gates"), { recursive: true });
  return dir;
}

async function writeGateFile(
  taskDir: string,
  name: string,
  body: Record<string, unknown>,
): Promise<void> {
  await writeFile(
    join(taskDir, "review", "gates", name),
    JSON.stringify(body),
  );
}

describe("rebuildVerdict (F2 — verdict is derived from surviving gate files)", () => {
  it("is in-progress with no gate files", async () => {
    const taskDir = await makeGatesDir();
    try {
      const verdict = await rebuildVerdict(taskDir);
      assert.equal(verdict.status, "in-progress");
      assert.deepEqual(verdict.flags, []);
    } finally {
      await rm(taskDir, { recursive: true, force: true });
    }
  });

  it("is pass when every surviving gate file passed cleanly", async () => {
    const taskDir = await makeGatesDir();
    try {
      await writeGateFile(taskDir, "intake.json", {
        phase: "intake",
        decidedAt: new Date().toISOString(),
        decision: "pass",
      });
      await writeGateFile(taskDir, "segmentation.json", {
        phase: "segmentation",
        decidedAt: new Date().toISOString(),
        decision: "pass",
      });
      const verdict = await rebuildVerdict(taskDir);
      assert.equal(verdict.status, "pass");
      assert.deepEqual(verdict.flags, []);
    } finally {
      await rm(taskDir, { recursive: true, force: true });
    }
  });

  it("ignores .trust-boundary.json sidecars and archived .attempt-N.json files", async () => {
    const taskDir = await makeGatesDir();
    try {
      await writeGateFile(taskDir, "intake.json", {
        phase: "intake",
        decidedAt: new Date().toISOString(),
        decision: "pass",
      });
      await writeGateFile(taskDir, "intake.trust-boundary.json", {
        ok: true,
        violations: [],
        checkedAt: new Date().toISOString(),
      });
      // A stale pass-with-concerns from a since-invalidated attempt — must
      // NOT leak into the rebuilt verdict.
      await writeGateFile(taskDir, "segmentation.attempt-1.json", {
        phase: "segmentation",
        decidedAt: new Date().toISOString(),
        decision: "pass-with-concerns",
        feedback: "stale concern from a rewound attempt",
      });
      const verdict = await rebuildVerdict(taskDir);
      assert.equal(verdict.status, "pass");
      assert.deepEqual(verdict.flags, []);
    } finally {
      await rm(taskDir, { recursive: true, force: true });
    }
  });

  it("returns to pass after a clean re-pass replaces a pass-with-concerns gate file", async () => {
    const taskDir = await makeGatesDir();
    try {
      await writeGateFile(taskDir, "segmentation.json", {
        phase: "segmentation",
        decidedAt: new Date().toISOString(),
        decision: "pass-with-concerns",
        feedback: "borderline watershed result",
      });
      const dirty = await rebuildVerdict(taskDir);
      assert.equal(dirty.status, "pass-with-concerns");
      assert.deepEqual(dirty.flags, ["segmentation: borderline watershed result"]);

      // Simulate archiveAndResetPhase + a fresh clean re-pass: the old gate
      // file is gone, a new clean one replaces it.
      await writeGateFile(taskDir, "segmentation.json", {
        phase: "segmentation",
        decidedAt: new Date().toISOString(),
        decision: "pass",
      });
      const clean = await rebuildVerdict(taskDir);
      assert.equal(clean.status, "pass");
      assert.deepEqual(clean.flags, []);
    } finally {
      await rm(taskDir, { recursive: true, force: true });
    }
  });
});
