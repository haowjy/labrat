import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ProtocolPhase } from "../../schema/index.js";
import type { ReviewSiteReport } from "../../review-site/check.js";
import {
  phaseProducesReviewSite,
  reviewArtifactCheckPath,
  reviewSiteGateFailure,
  runReviewArtifactCheck,
} from "./review-artifact-check.js";

const FIXTURE = fileURLToPath(new URL("../../../validation/fixtures/review-site", import.meta.url));
const TASK_ID = "task-2026-07-09-001";

const REVIEW_PHASE: ProtocolPhase = {
  id: "review-artifact",
  skills: [],
  inputs: ["regression/regression.json"],
  outputs: ["review-site/index.html", "review-site/data/manifest.js"],
  cdn_allowlist: [],
};

/**
 * A task tree the harness gate would see: artifacts/review-site (copied from the
 * clean fixture) built from artifacts/regression/regression.json, with a
 * manifest that faithfully names the measurement + carries the run id.
 */
async function makeTaskTree(): Promise<{ taskDir: string; hash: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "review-artifact-gate-"));
  const taskDir = join(root, TASK_ID);
  const siteDir = join(taskDir, "artifacts", "review-site");
  await cp(FIXTURE, siteDir, { recursive: true });

  await mkdir(join(taskDir, "artifacts", "regression"), { recursive: true });
  const measurementBytes = JSON.stringify({ slope: 0.12, intercept: 0.4, r_squared: 0.55, n: 200 });
  await writeFile(join(taskDir, "artifacts", "regression", "regression.json"), measurementBytes);
  const hash = createHash("sha256").update(measurementBytes).digest("hex");

  await writeFile(
    join(siteDir, "data", "manifest.js"),
    `window.REVIEW_MANIFEST = {\n  sample_id: "${TASK_ID}",\n  produced_from: { measurement: "regression/regression.json@${hash}" },\n  verdict_schema: "review-verdict/1",\n  data_globals: ["REVIEW_MANIFEST", "REVIEW_DATA"],\n};\n`,
  );

  return { taskDir, hash, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function readCheckFile(taskDir: string): Promise<ReviewSiteReport> {
  const raw = await readFile(reviewArtifactCheckPath(taskDir, REVIEW_PHASE.id), "utf8");
  return JSON.parse(raw) as ReviewSiteReport;
}

describe("harness-bound review-site gate (Lane C — the REAL gate path)", () => {
  it("only fires for phases that produce artifacts/review-site/", () => {
    assert.equal(phaseProducesReviewSite(REVIEW_PHASE), true);
    assert.equal(
      phaseProducesReviewSite({ id: "regression", skills: [], outputs: ["regression/regression.json"] }),
      false,
    );
    assert.equal(phaseProducesReviewSite({ id: "x", skills: [] }), false);
  });

  it("a clean site: harness writes ok:true and the floor lets it through", async () => {
    const { taskDir, cleanup } = await makeTaskTree();
    try {
      const report = await runReviewArtifactCheck(TASK_ID, taskDir, REVIEW_PHASE);
      assert.ok(report);
      assert.equal(report.ok, true, JSON.stringify(report.findings.filter((f) => !f.ok)));
      assert.equal(report.fidelity, "verified");
      // The report is persisted where the reviewer reads it.
      const onDisk = await readCheckFile(taskDir);
      assert.equal(onDisk.ok, true);
      // Deterministic floor: nothing to block on.
      assert.equal(reviewSiteGateFailure(report), null);
    } finally {
      await cleanup();
    }
  });

  it("a failing site is gated OUT: harness writes ok:false and the floor blocks the pass", async () => {
    const { taskDir, cleanup } = await makeTaskTree();
    try {
      // Inject an external, non-allowlisted script src (a real exfil surface).
      const indexPath = join(taskDir, "artifacts", "review-site", "index.html");
      const html = await readFile(indexPath, "utf8");
      await writeFile(
        indexPath,
        html.replace(
          '<script src="assets/app.js"></script>',
          '<script src="https://cdn.evil.example.com/x.js"></script>\n<script src="assets/app.js"></script>',
        ),
      );

      const report = await runReviewArtifactCheck(TASK_ID, taskDir, REVIEW_PHASE);
      assert.ok(report);
      assert.equal(report.ok, false);
      const onDisk = await readCheckFile(taskDir);
      assert.equal(onDisk.ok, false);

      // The floor turns this into a gate failure regardless of the reviewer.
      const failure = reviewSiteGateFailure(report);
      assert.ok(failure, "a non-ok report must produce a gate failure");
      assert.match(failure, /G6/);
      assert.match(failure, /cdn\.evil\.example\.com/);
    } finally {
      await cleanup();
    }
  });

  it("a stale manifest hash is gated OUT (G8 fidelity, harness-supplied measurement)", async () => {
    const { taskDir, cleanup } = await makeTaskTree();
    try {
      const manifestPath = join(taskDir, "artifacts", "review-site", "data", "manifest.js");
      const manifest = await readFile(manifestPath, "utf8");
      await writeFile(manifestPath, manifest.replace(/@[0-9a-f]{64}/, `@${"0".repeat(64)}`));

      const report = await runReviewArtifactCheck(TASK_ID, taskDir, REVIEW_PHASE);
      assert.ok(report);
      const g8 = report.findings.find((f) => f.gate === "G8");
      assert.equal(g8?.ok, false, g8?.detail);
      assert.ok(reviewSiteGateFailure(report));
    } finally {
      await cleanup();
    }
  });

  it("no-ops (returns null, writes nothing) for a non-review-site phase", async () => {
    const { taskDir, cleanup } = await makeTaskTree();
    try {
      const phase: ProtocolPhase = {
        id: "regression",
        skills: [],
        outputs: ["regression/regression.json"],
      };
      const report = await runReviewArtifactCheck(TASK_ID, taskDir, phase);
      assert.equal(report, null);
      assert.equal(reviewSiteGateFailure(report), null);
    } finally {
      await cleanup();
    }
  });
});
