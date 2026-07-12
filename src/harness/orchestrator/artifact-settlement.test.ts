import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, it } from "node:test";
import { stringify as stringifyYaml } from "yaml";
import type { LabratConfig } from "../../config/index.js";
import type { ProtocolPhase } from "../../schema/index.js";
import type { LoadedProtocol } from "../protocol-loader/index.js";
import { readProvenanceManifest } from "../provenance/index.js";
import type { RuntimeHandle } from "../runtime-setup/types.js";
import type { AuthorSessionConfig } from "../session/review-artifact-author.js";
import {
  appendPublishedArtifactProvenance,
  artifactSettlementPending,
  artifactStatusPath,
  publishedReviewSiteDir,
  readArtifactStatus,
  scientificGateAccepted,
  settleReviewArtifact,
  type ArtifactSettlementContext,
} from "./artifact-settlement.js";

/*
 * Review-artifact settlement (review-provenance design §3.D + correction #3).
 *
 * THE invariant these tests exist to protect: an artifact-author/linter
 * failure NEVER destroys or re-runs scientifically verified worker outputs.
 * The gate FAIL path archives + resets a phase; the artifact path must never
 * take it — so a failed settlement leaves `phases/<phase>/` and the phase's
 * verified `artifacts/` BYTE-IDENTICAL, publishes nothing, and reports
 * `kind: "artifact-failed"` for runTask to PAUSE on.
 *
 * The author session is stubbed (an AuthorRunner writing staging files
 * directly) — settlement's contract is disk in/disk out, deterministic.
 */

const SITE_FIXTURE = fileURLToPath(
  new URL("../../../validation/fixtures/review-site", import.meta.url),
);
const BUILDER_SKILL = fileURLToPath(
  new URL("../../../skills/review-artifact-builder", import.meta.url),
);
const TASK_ID = "task-2026-07-11-001";

const ARTIFACT_PHASE: ProtocolPhase = {
  id: "segmentation",
  skills: [],
  inputs: [],
  outputs: ["regression/regression.json"],
  cdn_allowlist: [],
  review_artifact: { type: "spatial-3d" },
};

const NONE_PHASE: ProtocolPhase = {
  id: "intake",
  skills: [],
  review_artifact: { type: "none" },
};

const LEGACY_PHASE: ProtocolPhase = {
  id: "review-artifact",
  skills: [],
  outputs: ["review-site/index.html"],
};

type Fixture = {
  readonly taskDir: string;
  readonly ctx: (phase: ProtocolPhase) => ArtifactSettlementContext;
  readonly measurementHash: string;
  readonly cleanup: () => Promise<void>;
};

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "artifact-settlement-"));
  const taskDir = join(root, TASK_ID);

  // Fake Claude Science registry carrying the real vendored builder skill so
  // template resolution goes through the same findRegistrySkillDir path.
  const scienceHome = join(root, "science-home");
  await cp(BUILDER_SKILL, join(scienceHome, "orgs", "test-org", "skills", "review-artifact-builder"), {
    recursive: true,
  });

  // Verified worker science on disk — the bytes settlement must never touch.
  await mkdir(join(taskDir, "phases", "segmentation"), { recursive: true });
  await writeFile(
    join(taskDir, "phases", "segmentation", "summary.md"),
    "# Segmentation\nverified science\n",
  );
  await mkdir(join(taskDir, "artifacts", "regression"), { recursive: true });
  const measurementBytes = JSON.stringify({ slope: 0.12, intercept: 0.4, r_squared: 0.55, n: 200 });
  await writeFile(join(taskDir, "artifacts", "regression", "regression.json"), measurementBytes);
  const measurementHash = createHash("sha256").update(measurementBytes).digest("hex");

  // Accepted scientific gate + provenance entry (the resume-detection inputs).
  await mkdir(join(taskDir, "review", "gates"), { recursive: true });
  await writeFile(
    join(taskDir, "review", "gates", "segmentation.json"),
    JSON.stringify({
      phase: "segmentation",
      decidedAt: "2026-07-11T10:00:00.000Z",
      decision: "pass",
    }),
  );
  await mkdir(join(taskDir, "provenance"), { recursive: true });
  await writeFile(
    join(taskDir, "provenance", "manifest.yaml"),
    stringifyYaml([
      {
        phase: "segmentation",
        attempt: 1,
        started: "2026-07-11T09:00:00.000Z",
        completed: "2026-07-11T10:00:00.000Z",
        skills_loaded: [{ name: "resources/x", hash: "abc123" }],
        agent: "worker",
        inputs: [],
        outputs: [{ path: "artifacts/regression/regression.json", hash: measurementHash }],
        subphases: null,
        sessions: { worker: "sess_worker", gate: "sess_gate" },
        gate_decision: "pass",
        verification: {
          code: "review/verification/segmentation/",
          results: "review/gates/segmentation.json",
        },
      },
    ]),
  );

  const config = {
    scienceHome,
    defaultModel: "sonnet",
    defaultPermissionMode: "acceptEdits",
    retries: {
      workerStall: 3,
      reviewAttempts: 2,
      phaseAttempts: 2,
      backgroundGraceRetries: 10,
      artifactAuthorAttempts: 2,
    },
  } as unknown as LabratConfig;

  const runtime = { pythonPath: "/usr/bin/python3", env: {}, substrate: "test" } as RuntimeHandle;
  const protocol = {
    yaml: { agents: { "review-artifact-author": { tools: ["Read", "Write"] } }, phases: [] },
    skillDir: join(scienceHome, "orgs", "test-org", "skills", "review-artifact-builder"),
    claudeScienceHome: scienceHome,
  } as unknown as LoadedProtocol;

  return {
    taskDir,
    measurementHash,
    ctx: (phase) => ({
      taskId: TASK_ID,
      taskDir,
      protocol,
      phase,
      attempt: 1,
      runtime,
      config,
    }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** Author double that produces a LINTER-PASSING site: the review-site fixture
 * with the manifest patched to this run's identity + measurement hash. */
function goodAuthor(measurementHash: string) {
  return async (cfg: AuthorSessionConfig) => {
    await rm(cfg.stagingDir, { recursive: true, force: true });
    await cp(SITE_FIXTURE, cfg.stagingDir, { recursive: true });
    const indexPath = join(cfg.stagingDir, "index.html");
    const html = await readFile(indexPath, "utf8");
    await writeFile(
      indexPath,
      html
        .replace('sample_id: "oa-knee-0007"', `sample_id: "${TASK_ID}"`)
        .replace(
          /"measurements\/results\.json@[0-9a-f]{64}"/,
          `"regression/regression.json@${measurementHash}"`,
        ),
    );
    return { sessionId: `author-session-${cfg.authorAttempt}` };
  };
}

/** Author double that produces a site the deterministic linter REJECTS. */
async function badAuthor(cfg: AuthorSessionConfig) {
  await writeFile(join(cfg.stagingDir, "index.html"), "<html>no manifest, no nothing</html>");
  return { sessionId: `bad-author-${cfg.authorAttempt}` };
}

/** sha256 of every file under root, keyed by relative path — the
 * byte-identity snapshot for the worker-science invariant. */
async function snapshotTree(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(dir: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(p, r);
      else if (entry.isFile()) {
        out.set(r, createHash("sha256").update(await readFile(p)).digest("hex"));
      }
    }
  }
  await walk(root, "");
  return out;
}

describe("settleReviewArtifact — type: none settles immediately", () => {
  it("writes status none, runs no author, creates no site dir and no linter report", async () => {
    const fx = await makeFixture();
    try {
      let authorCalls = 0;
      const result = await settleReviewArtifact(fx.ctx(NONE_PHASE), async () => {
        authorCalls += 1;
        return { sessionId: "never" };
      });
      assert.equal(result.kind, "none");
      assert.equal(authorCalls, 0);

      const status = await readArtifactStatus(fx.taskDir, "intake");
      assert.equal(status?.status, "none");
      assert.equal(status?.type, "none");

      await assert.rejects(readdir(join(fx.taskDir, "artifacts", "review-sites")));
      await assert.rejects(
        readFile(join(fx.taskDir, "review", "artifact-author", "intake", "attempt-1", "check_review_site.json")),
      );
    } finally {
      await fx.cleanup();
    }
  });
});

describe("settleReviewArtifact — legacy phases are refused (branch on legacy BEFORE type)", () => {
  it("throws for a legacy review-site phase and writes no status.json", async () => {
    const fx = await makeFixture();
    try {
      await assert.rejects(
        settleReviewArtifact(fx.ctx(LEGACY_PHASE), badAuthor),
        /legacy/,
      );
      assert.equal(await readArtifactStatus(fx.taskDir, "review-artifact"), null);
    } finally {
      await fx.cleanup();
    }
  });

  it("artifactSettlementPending is false for legacy and none phases", async () => {
    const fx = await makeFixture();
    try {
      assert.equal(await artifactSettlementPending(fx.taskDir, LEGACY_PHASE), false);
      assert.equal(await artifactSettlementPending(fx.taskDir, NONE_PHASE), false);
      assert.equal(await artifactSettlementPending(fx.taskDir, ARTIFACT_PHASE), true);
    } finally {
      await fx.cleanup();
    }
  });
});

describe("settleReviewArtifact — publish path", () => {
  it("gates the staging dir with the linter, atomically publishes, and records status", async () => {
    const fx = await makeFixture();
    try {
      const result = await settleReviewArtifact(
        fx.ctx(ARTIFACT_PHASE),
        goodAuthor(fx.measurementHash),
      );
      assert.equal(result.kind, "published");
      if (result.kind !== "published") return;
      assert.equal(result.authorAttempt, 1);
      assert.equal(result.authorSessionId, "author-session-1");

      // Published site is at the phase-scoped path; staging is gone.
      const published = publishedReviewSiteDir(fx.taskDir, "segmentation");
      const html = await readFile(join(published, "index.html"), "utf8");
      assert.match(html, new RegExp(TASK_ID));
      await assert.rejects(
        readdir(join(fx.taskDir, "artifacts", "review-sites", ".staging", "segmentation", "1")),
      );

      // Linter report persisted per attempt and referenced from status.json.
      const status = await readArtifactStatus(fx.taskDir, "segmentation");
      assert.equal(status?.status, "published");
      assert.equal(status?.type, "spatial-3d");
      assert.equal(status?.author_session_id, "author-session-1");
      assert.ok(status?.check_report_path);
      assert.ok(status?.scientific_gate_hash);
      const report = JSON.parse(
        await readFile(join(fx.taskDir, status!.check_report_path!), "utf8"),
      ) as { ok: boolean };
      assert.equal(report.ok, true);

      // Settlement is idempotent: a re-entry after publish re-authors nothing.
      let authorCalls = 0;
      const again = await settleReviewArtifact(fx.ctx(ARTIFACT_PHASE), async () => {
        authorCalls += 1;
        return { sessionId: "never" };
      });
      assert.equal(again.kind, "published");
      assert.equal(authorCalls, 0);
    } finally {
      await fx.cleanup();
    }
  });

  it("retries with a fresh author + fresh staging after a linter fail, then publishes", async () => {
    const fx = await makeFixture();
    try {
      const good = goodAuthor(fx.measurementHash);
      const result = await settleReviewArtifact(fx.ctx(ARTIFACT_PHASE), async (cfg) => {
        if (cfg.authorAttempt === 1) return badAuthor(cfg);
        return good(cfg);
      });
      assert.equal(result.kind, "published");
      if (result.kind !== "published") return;
      assert.equal(result.authorAttempt, 2);

      // Attempt 1 is archived with its failing report; nothing of it published.
      const attempt1 = join(fx.taskDir, "review", "artifact-author", "segmentation", "attempt-1");
      const archived = await readFile(join(attempt1, "site", "index.html"), "utf8");
      assert.match(archived, /no manifest/);
      const report1 = JSON.parse(
        await readFile(join(attempt1, "check_review_site.json"), "utf8"),
      ) as { ok: boolean };
      assert.equal(report1.ok, false);
    } finally {
      await fx.cleanup();
    }
  });
});

describe("settleReviewArtifact — THE invariant: failure never touches worker science", () => {
  it("exhausted author retries → artifact-failed; worker outputs byte-identical; nothing published; no archive/reset of the phase", async () => {
    const fx = await makeFixture();
    try {
      const before = {
        phase: await snapshotTree(join(fx.taskDir, "phases", "segmentation")),
        artifacts: await snapshotTree(join(fx.taskDir, "artifacts", "regression")),
        gate: await readFile(join(fx.taskDir, "review", "gates", "segmentation.json"), "utf8"),
      };

      const result = await settleReviewArtifact(fx.ctx(ARTIFACT_PHASE), badAuthor);
      assert.equal(result.kind, "artifact-failed");
      if (result.kind !== "artifact-failed") return;
      assert.match(result.reason, /segmentation/);

      // BYTE-IDENTICAL worker science: phases/<phase>/ and the phase's
      // verified artifacts are exactly what the gate accepted.
      assert.deepEqual(
        await snapshotTree(join(fx.taskDir, "phases", "segmentation")),
        before.phase,
      );
      assert.deepEqual(
        await snapshotTree(join(fx.taskDir, "artifacts", "regression")),
        before.artifacts,
      );
      // No archiveAndResetPhase: no phases/segmentation.attempt-N dir appeared.
      const phaseDirs = await readdir(join(fx.taskDir, "phases"));
      assert.deepEqual(phaseDirs.sort(), ["segmentation"]);
      // The accepted scientific gate file is untouched.
      assert.equal(
        await readFile(join(fx.taskDir, "review", "gates", "segmentation.json"), "utf8"),
        before.gate,
      );

      // Nothing at the published path — a linter fail publishes NOTHING.
      await assert.rejects(readdir(publishedReviewSiteDir(fx.taskDir, "segmentation")));

      // Status is failed (never "none"), with both attempts archived.
      const status = await readArtifactStatus(fx.taskDir, "segmentation");
      assert.equal(status?.status, "failed");
      assert.equal(status?.author_attempt, 2);
      for (const n of [1, 2]) {
        const dir = join(fx.taskDir, "review", "artifact-author", "segmentation", `attempt-${n}`);
        assert.ok((await readdir(dir)).includes("check_review_site.json"));
      }
    } finally {
      await fx.cleanup();
    }
  });
});

describe("resume-into-authoring (review-provenance §3.D resume seam)", () => {
  it("scientificGateAccepted requires BOTH a passing live gate file and a provenance entry", async () => {
    const fx = await makeFixture();
    try {
      assert.equal(await scientificGateAccepted(fx.taskDir, "segmentation"), true);
      // No gate file for this phase.
      assert.equal(await scientificGateAccepted(fx.taskDir, "intake"), false);
      // Failing gate decision does not count.
      await writeFile(
        join(fx.taskDir, "review", "gates", "segmentation.json"),
        JSON.stringify({
          phase: "segmentation",
          decidedAt: "2026-07-11T10:00:00.000Z",
          decision: "fail",
        }),
      );
      assert.equal(await scientificGateAccepted(fx.taskDir, "segmentation"), false);
    } finally {
      await fx.cleanup();
    }
  });

  it("a task paused at the artifact step re-enters authoring ONLY: no worker re-run, science untouched, artifact publishes and provenance gains the author", async () => {
    const fx = await makeFixture();
    try {
      // Arrange: the exact disk state runTask leaves after an artifact-failed
      // pause — accepted science + status.json failed after 2 attempts.
      const paused = await settleReviewArtifact(fx.ctx(ARTIFACT_PHASE), badAuthor);
      assert.equal(paused.kind, "artifact-failed");
      const before = {
        phase: await snapshotTree(join(fx.taskDir, "phases", "segmentation")),
        artifacts: await snapshotTree(join(fx.taskDir, "artifacts", "regression")),
      };

      // The resume detection runTask's loop-top uses:
      assert.equal(await scientificGateAccepted(fx.taskDir, "segmentation"), true);
      assert.equal(await artifactSettlementPending(fx.taskDir, ARTIFACT_PHASE), true);

      // Act: re-enter settlement (what runTask does INSTEAD of the worker).
      const resumed = await settleReviewArtifact(
        fx.ctx(ARTIFACT_PHASE),
        goodAuthor(fx.measurementHash),
      );
      assert.equal(resumed.kind, "published");
      if (resumed.kind !== "published") return;
      // The author counter continued past the archived attempts.
      assert.equal(resumed.authorAttempt, 3);

      // Worker science still byte-identical across pause + resume.
      assert.deepEqual(
        await snapshotTree(join(fx.taskDir, "phases", "segmentation")),
        before.phase,
      );
      assert.deepEqual(
        await snapshotTree(join(fx.taskDir, "artifacts", "regression")),
        before.artifacts,
      );

      // Provenance re-append binds the author session + published artifact.
      await appendPublishedArtifactProvenance(fx.taskDir, "segmentation", resumed);
      const manifest = await readProvenanceManifest(fx.taskDir);
      const latest = manifest[manifest.length - 1];
      assert.equal(latest?.phase, "segmentation");
      assert.equal(latest?.sessions.author, "author-session-3");
      assert.equal(latest?.review_artifact?.type, "spatial-3d");
      assert.equal(latest?.review_artifact?.path, "artifacts/review-sites/segmentation");
      assert.ok(latest?.review_artifact?.hash);

      // And the phase is no longer pending — a second resume settles trivially.
      assert.equal(await artifactSettlementPending(fx.taskDir, ARTIFACT_PHASE), false);

      const statusFile = JSON.parse(
        await readFile(artifactStatusPath(fx.taskDir, "segmentation"), "utf8"),
      ) as { status: string };
      assert.equal(statusFile.status, "published");
    } finally {
      await fx.cleanup();
    }
  });
});
