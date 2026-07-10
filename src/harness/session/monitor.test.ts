import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  classifyReviewerAudit,
  scanVerificationEvidence,
  type VerificationEvidence,
} from "./monitor.js";
import { monitorOverridesGate } from "../orchestrator/gate.js";

const DIR = "review/verification/classify/";

function evidence(over: Partial<VerificationEvidence> = {}): VerificationEvidence {
  return {
    fileCount: 0,
    scriptBytes: 0,
    outputBytes: 0,
    totalBytes: 0,
    files: [],
    hasRealEvidence: false,
    ...over,
  };
}

describe("classifyReviewerAudit — the discriminator", () => {
  it("flags a PASS with an empty verification dir as rubber_stamp", () => {
    const r = classifyReviewerAudit({
      phase: "classify",
      gateDecision: "pass",
      reviewerDefaulted: false,
      verificationDir: DIR,
      evidence: evidence({ hasRealEvidence: false }),
    });
    assert.equal(r.verdict, "rubber_stamp");
  });

  it("flags a defaulted reviewer as rubber_stamp even if a file exists", () => {
    // The harness default (never called submit_gate_decision) is a rubber
    // stamp regardless of any stray scratch file.
    const r = classifyReviewerAudit({
      phase: "classify",
      gateDecision: "pass-with-concerns",
      reviewerDefaulted: true,
      verificationDir: DIR,
      evidence: evidence({ hasRealEvidence: true, scriptBytes: 4000, fileCount: 1 }),
    });
    assert.equal(r.verdict, "rubber_stamp");
  });

  it("passes a genuine PASS backed by a real recompute script", () => {
    const r = classifyReviewerAudit({
      phase: "classify",
      gateDecision: "pass",
      reviewerDefaulted: false,
      verificationDir: DIR,
      evidence: evidence({ hasRealEvidence: true, scriptBytes: 4185, fileCount: 1 }),
    });
    assert.equal(r.verdict, "ok");
  });

  it("passes a legitimate pass-with-concerns that DID real verification (no false positive on the label)", () => {
    const r = classifyReviewerAudit({
      phase: "classify",
      gateDecision: "pass-with-concerns",
      reviewerDefaulted: false,
      verificationDir: DIR,
      evidence: evidence({ hasRealEvidence: true, scriptBytes: 900, fileCount: 2 }),
      // Even if the model over-eagerly returned rubber_stamp, evidence present
      // means the floor holds it at ok — the model cannot invent a rubber stamp.
      modelVerdict: "rubber_stamp",
      modelReasons: ["model was unsure"],
    });
    assert.equal(r.verdict, "ok");
  });

  it("lets the model ESCALATE an evidence-present pass to insufficient_evidence", () => {
    const r = classifyReviewerAudit({
      phase: "classify",
      gateDecision: "pass",
      reviewerDefaulted: false,
      verificationDir: DIR,
      evidence: evidence({ hasRealEvidence: true, scriptBytes: 300, fileCount: 1 }),
      modelVerdict: "insufficient_evidence",
      modelReasons: ["script never recomputes the reported accuracy"],
    });
    assert.equal(r.verdict, "insufficient_evidence");
    assert.deepEqual(r.reasons, ["script never recomputes the reported accuracy"]);
  });

  it("does not audit a reviewer FAIL (no pass to rubber-stamp)", () => {
    const r = classifyReviewerAudit({
      phase: "classify",
      gateDecision: "fail",
      reviewerDefaulted: false,
      verificationDir: DIR,
      evidence: evidence({ hasRealEvidence: false }),
    });
    assert.equal(r.verdict, "ok");
  });
});

describe("scanVerificationEvidence — real evidence vs empty scratch", () => {
  it("reports no real evidence for an empty (or missing) verification dir", async () => {
    const taskDir = await mkdtemp(join(tmpdir(), "labrat-mon-"));
    try {
      await mkdir(join(taskDir, "review", "verification", "classify"), {
        recursive: true,
      });
      const ev = await scanVerificationEvidence(taskDir, "classify");
      assert.equal(ev.fileCount, 0);
      assert.equal(ev.hasRealEvidence, false);
    } finally {
      await rm(taskDir, { recursive: true, force: true });
    }
  });

  it("reports real evidence for a substantive recompute script", async () => {
    const taskDir = await mkdtemp(join(tmpdir(), "labrat-mon-"));
    try {
      const vdir = join(taskDir, "review", "verification", "classify");
      await mkdir(vdir, { recursive: true });
      await writeFile(
        join(vdir, "verify.py"),
        "import csv, json\n# independently recompute the classifier accuracy\n".repeat(10),
      );
      const ev = await scanVerificationEvidence(taskDir, "classify");
      assert.equal(ev.fileCount, 1);
      assert.ok(ev.scriptBytes > 64);
      assert.equal(ev.hasRealEvidence, true);
    } finally {
      await rm(taskDir, { recursive: true, force: true });
    }
  });
});

describe("monitorOverridesGate — enforcement wiring", () => {
  it("overrides a PASS on rubber_stamp / insufficient_evidence", () => {
    assert.equal(monitorOverridesGate("pass", "rubber_stamp"), true);
    assert.equal(monitorOverridesGate("pass-with-concerns", "insufficient_evidence"), true);
  });
  it("does not override an ok verdict", () => {
    assert.equal(monitorOverridesGate("pass", "ok"), false);
  });
  it("never overrides an already-failing reviewer decision", () => {
    assert.equal(monitorOverridesGate("fail", "rubber_stamp"), false);
    assert.equal(monitorOverridesGate("fail-upstream", "insufficient_evidence"), false);
  });
});
