import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  validateReviewFinishInput,
  validateReviewVerdictRecord,
} from "./review-verdict.js";

describe("validateReviewFinishInput (POST /api/tasks/:id/review/finish body)", () => {
  const valid = {
    phase: "segmentation",
    human_verdict: "pass",
    corrected: true,
    notes: "Adjusted the femur landmark; everything else confirmed.",
    adjustments: [
      {
        id: "lm-femur-condyle",
        proposed: { x: 1, y: 2, z: 3 },
        corrected: { x: 1.2, y: 2, z: 3 },
      },
    ],
  };

  it("accepts a well-formed body", () => {
    const res = validateReviewFinishInput(valid);
    assert.equal(res.ok, true);
  });

  it("rejects a non-finite coordinate (Infinity/-Infinity serialize to null on disk)", () => {
    for (const bad of [Infinity, -Infinity]) {
      const res = validateReviewFinishInput({
        ...valid,
        adjustments: [{ id: "lm", proposed: null, corrected: { x: bad, y: 0, z: 0 } }],
      });
      assert.equal(res.ok, false);
    }
  });

  it("defaults adjustments to [] when absent", () => {
    const { adjustments: _drop, ...withoutAdjustments } = valid;
    const res = validateReviewFinishInput(withoutAdjustments);
    assert.equal(res.ok, true);
    if (res.ok) assert.deepEqual(res.value.adjustments, []);
  });

  it("rejects a missing human_verdict", () => {
    const { human_verdict: _drop, ...bad } = valid;
    const res = validateReviewFinishInput(bad);
    assert.equal(res.ok, false);
  });

  it("rejects a human_verdict outside pass|fail (never inferred, must be explicit)", () => {
    const res = validateReviewFinishInput({ ...valid, human_verdict: "pass-with-concerns" });
    assert.equal(res.ok, false);
  });

  it("rejects a missing phase", () => {
    const { phase: _drop, ...bad } = valid;
    const res = validateReviewFinishInput(bad);
    assert.equal(res.ok, false);
  });

  it("rejects a non-boolean corrected", () => {
    const res = validateReviewFinishInput({ ...valid, corrected: "true" });
    assert.equal(res.ok, false);
  });

  it("rejects a malformed adjustment (missing corrected point)", () => {
    const res = validateReviewFinishInput({
      ...valid,
      adjustments: [{ id: "x", proposed: { x: 0, y: 0, z: 0 } }],
    });
    assert.equal(res.ok, false);
  });

  it("accepts a null proposed (review-site interaction message has no pre-drag position, gh #20)", () => {
    const res = validateReviewFinishInput({
      ...valid,
      adjustments: [{ id: "x", proposed: null, corrected: { x: 1, y: 2, z: 3 } }],
    });
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.value.adjustments[0]?.proposed, null);
  });

  it("treats a missing proposed key the same as null", () => {
    const res = validateReviewFinishInput({
      ...valid,
      adjustments: [{ id: "x", corrected: { x: 1, y: 2, z: 3 } }],
    });
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.value.adjustments[0]?.proposed, null);
  });

  it("still rejects a malformed non-null proposed (missing coordinate)", () => {
    const res = validateReviewFinishInput({
      ...valid,
      adjustments: [{ id: "x", proposed: { x: 1 }, corrected: { x: 1, y: 2, z: 3 } }],
    });
    assert.equal(res.ok, false);
  });

  it("rejects a non-numeric coordinate", () => {
    const res = validateReviewFinishInput({
      ...valid,
      adjustments: [
        { id: "x", proposed: { x: 0, y: 0, z: 0 }, corrected: { x: "0", y: 0, z: 0 } },
      ],
    });
    assert.equal(res.ok, false);
  });

  it("rejects a non-object body", () => {
    assert.equal(validateReviewFinishInput("nope").ok, false);
    assert.equal(validateReviewFinishInput(null).ok, false);
  });
});

describe("validateReviewVerdictRecord (review/verdict/{phase}.json on-disk shape)", () => {
  it("round-trips the input plus the server-stamped/merged fields", () => {
    const record = {
      phase: "segmentation",
      human_verdict: "pass",
      corrected: false,
      notes: "Confirmed.",
      adjustments: [],
      agent_confidence: { overall: "medium", notes: "femur mask fragmented" },
      agent_gate_decision: "pass-with-concerns",
      agent_gate_feedback: "Labels confirmed after seed replay.",
      reviewed_at: "2026-07-10T12:00:00.000Z",
    };
    const res = validateReviewVerdictRecord(record);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.value.human_verdict, "pass");
      assert.deepEqual(res.value.agent_confidence, {
        overall: "medium",
        notes: "femur mask fragmented",
      });
    }
  });

  it("allows null agent fields (no gate/confidence on disk yet)", () => {
    const res = validateReviewVerdictRecord({
      phase: "segmentation",
      human_verdict: "fail",
      corrected: true,
      notes: "",
      adjustments: [],
      agent_confidence: null,
      agent_gate_decision: null,
      agent_gate_feedback: null,
      reviewed_at: "2026-07-10T12:00:00.000Z",
    });
    assert.equal(res.ok, true);
  });

  it("rejects a missing reviewed_at", () => {
    const res = validateReviewVerdictRecord({
      phase: "segmentation",
      human_verdict: "pass",
      corrected: false,
      notes: "",
      adjustments: [],
      agent_confidence: null,
      agent_gate_decision: null,
      agent_gate_feedback: null,
    });
    assert.equal(res.ok, false);
  });
});
