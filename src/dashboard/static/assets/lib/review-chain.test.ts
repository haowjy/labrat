import assert from "node:assert/strict";
import { describe, it } from "node:test";
// @ts-expect-error — framework-free browser ESM, no types (as review-bridge.test.ts).
import { deriveReviewChain, findReviewerValue } from "./review-chain.js";

const KEY = "femur_oa_ratio";

/** A phaseDetail shaped like getPhase's response, with sane defaults the
 * individual tests override. */
function phaseDetail(overrides = {}) {
  return {
    phase: "measurement",
    measurements: {
      [KEY]: 1.275,
      expectedRanges: { [KEY]: [1.0, 1.3] },
      classifications: { [KEY]: { inRange: "Normal", outOfRange: "OA" } },
    },
    gate: { decision: "pass" },
    gateHistory: [],
    reviewerVerification: [],
    monitorVerdict: null,
    verification: [],
    ...overrides,
  };
}

describe("deriveReviewChain — corrected framing (reviewer recomputed a different value)", () => {
  it("shows both numbers, the direction, and that the cutoff was crossed", () => {
    const chain = deriveReviewChain(
      phaseDetail({
        reviewerVerification: [{ file: "recompute.json", data: { [KEY]: 1.33 } }],
        gate: { decision: "fail" },
        verification: ["recompute.json", "verify.py"],
      }),
    );
    assert.ok(chain);
    const m = chain.measurement;
    assert.equal(m.framing, "corrected");
    assert.equal(m.worker.value, 1.275);
    assert.equal(m.worker.classification, "Normal");
    assert.equal(m.reviewer.value, 1.33);
    assert.equal(m.reviewer.classification, "OA");
    assert.equal(m.reviewer.status, "recomputed-differs");
    assert.equal(m.directional, "higher");
    assert.equal(m.crossedCutoff, true);
  });
});

describe("deriveReviewChain — verified framing (reviewer agrees)", () => {
  it("recomputed the SAME value -> verified, no fake disagreement", () => {
    const chain = deriveReviewChain(
      phaseDetail({
        reviewerVerification: [{ file: "recompute.json", data: { [KEY]: 1.2750001 } }],
      }),
    );
    assert.equal(chain.measurement.framing, "verified");
    assert.equal(chain.measurement.reviewer.status, "confirmed");
    assert.equal(chain.measurement.directional, null);
  });

  it("no independent number but the gate passed -> verified/confirmed, value null", () => {
    const chain = deriveReviewChain(phaseDetail({ gate: { decision: "pass" } }));
    assert.equal(chain.measurement.framing, "verified");
    assert.equal(chain.measurement.reviewer.value, null);
    assert.equal(chain.measurement.reviewer.status, "confirmed");
    // confirmed reviewer mirrors the worker's own classification
    assert.equal(chain.measurement.reviewer.classification, "Normal");
  });
});

describe("deriveReviewChain — correction history (caught and re-run across attempts)", () => {
  it("flags corrected from archived failing gates even with no live number", () => {
    const chain = deriveReviewChain(
      phaseDetail({
        gateHistory: [{ decision: "fail", feedback: "recomputed ratio disagreed" }],
      }),
    );
    assert.equal(chain.measurement.framing, "corrected");
    assert.equal(chain.measurement.reviewer.status, "flagged");
    assert.equal(chain.history.attempts, 1);
    assert.equal(chain.history.latestFeedback, "recomputed ratio disagreed");
  });
});

describe("deriveReviewChain — monitor audit", () => {
  it("ok verdict passes the audit", () => {
    const chain = deriveReviewChain(
      phaseDetail({ monitorVerdict: { verdict: "ok", reasons: ["recompute present"] } }),
    );
    assert.equal(chain.monitor.passed, true);
    assert.equal(chain.monitor.verdict, "ok");
  });

  it("rubber_stamp fails the audit", () => {
    const chain = deriveReviewChain(
      phaseDetail({ monitorVerdict: { verdict: "rubber_stamp", reasons: ["empty verification"] } }),
    );
    assert.equal(chain.monitor.passed, false);
  });
});

describe("deriveReviewChain — nothing chain-worthy", () => {
  it("returns null when there is no measurement, monitor, reviewer output, or history", () => {
    const chain = deriveReviewChain({
      phase: "intake",
      measurements: null,
      gate: null,
      gateHistory: [],
      reviewerVerification: [],
      monitorVerdict: null,
      verification: [],
    });
    assert.equal(chain, null);
  });

  it("renders (non-null) for a monitor-only phase with no decisive measurement", () => {
    const chain = deriveReviewChain({
      phase: "segmentation",
      measurements: null,
      gate: { decision: "pass" },
      gateHistory: [],
      reviewerVerification: [],
      monitorVerdict: { verdict: "ok", reasons: [] },
      verification: [],
    });
    assert.ok(chain);
    assert.equal(chain.measurement, null);
    assert.equal(chain.monitor.passed, true);
  });
});

describe("findReviewerValue — nested containers", () => {
  it("finds the value under a known nesting container", () => {
    const value = findReviewerValue(
      [{ file: "v.json", data: { recomputed_ratios: { [KEY]: 1.41 } } }],
      KEY,
    );
    assert.equal(value, 1.41);
  });

  it("returns null when no structured number is present", () => {
    const value = findReviewerValue([{ file: "v.json", data: { note: "looks fine" } }], KEY);
    assert.equal(value, null);
  });
});
