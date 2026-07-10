import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  REVIEW_EVIDENCE_CAP,
  REVIEW_LOG_CAP,
  REVIEW_LOG_RATE_MAX,
  REVIEW_LOG_RATE_WINDOW_MS,
  adjustmentsFromEvidence,
  appendVerdictLog,
  applyReviewMessage,
  hasOnlyKeys,
  isFiniteNumber,
  isReviewId,
  newReviewVerdict,
  revokeEvidence,
  validateInteraction,
  validateMetrics,
  verdictLabel,
  verdictPillClass,
  withStatus,
  type ReviewVerdict,
} from "./review-bridge.js";

/*
 * Direct, real-ESM-import unit tests for the F1 trust boundary (design/
 * review-architecture-decision.md "what lives where" + goal doc's "carry
 * the F1 postMessage security unchanged"). This is the highest-risk file in
 * Lane B's scope — it decides which cross-frame messages the trusted shell
 * accepts — so it gets the exhaustive edge-case coverage /testing calls for
 * on a trust boundary: adversarial inputs (extra keys, wrong types, NaN/
 * Infinity, oversized ids), not just the happy path.
 */

describe("hasOnlyKeys / isFiniteNumber / isReviewId", () => {
  it("hasOnlyKeys rejects any key outside the allowed set", () => {
    assert.equal(hasOnlyKeys({ a: 1, b: 2 }, { a: 1, b: 1 }), true);
    assert.equal(hasOnlyKeys({ a: 1, b: 2, c: 3 }, { a: 1, b: 1 }), false);
    assert.equal(hasOnlyKeys({}, { a: 1 }), true);
  });

  it("isFiniteNumber rejects NaN/Infinity/non-numbers", () => {
    assert.equal(isFiniteNumber(1.5), true);
    assert.equal(isFiniteNumber(0), true);
    assert.equal(isFiniteNumber(-3), true);
    assert.equal(isFiniteNumber(NaN), false);
    assert.equal(isFiniteNumber(Infinity), false);
    assert.equal(isFiniteNumber(-Infinity), false);
    assert.equal(isFiniteNumber("1"), false);
    assert.equal(isFiniteNumber(null), false);
    assert.equal(isFiniteNumber(undefined), false);
  });

  it("isReviewId enforces the bounded [A-Za-z0-9_-]{1,128} shape", () => {
    assert.equal(isReviewId("femur_axial_notch"), true);
    assert.equal(isReviewId("a"), true);
    assert.equal(isReviewId(""), false);
    assert.equal(isReviewId("has space"), false);
    assert.equal(isReviewId("has/slash"), false);
    assert.equal(isReviewId("a".repeat(128)), true);
    assert.equal(isReviewId("a".repeat(129)), false, "over the 128-char bound");
    assert.equal(isReviewId(123), false, "non-string rejected");
    assert.equal(isReviewId(null), false);
  });
});

describe("validateInteraction (F1)", () => {
  const good = {
    type: "interaction",
    action: "landmark-moved",
    id: "femur_axial_notch",
    position: { x: 1.5, y: -2, z: 0 },
  };

  it("accepts a well-formed interaction and returns the sanitized payload", () => {
    const ok = validateInteraction(good);
    assert.deepEqual(ok, {
      action: "landmark-moved",
      id: "femur_axial_notch",
      position: { x: 1.5, y: -2, z: 0 },
    });
  });

  it("rejects an extra top-level key (strict key set)", () => {
    assert.equal(validateInteraction({ ...good, extra: "haxx" }), null);
  });

  it("rejects an unknown action (enum)", () => {
    assert.equal(validateInteraction({ ...good, action: "delete-everything" }), null);
  });

  it("rejects an id outside the bounded id regex", () => {
    assert.equal(validateInteraction({ ...good, id: "../../etc/passwd" }), null);
    assert.equal(validateInteraction({ ...good, id: "" }), null);
  });

  it("rejects a missing/non-object/array position", () => {
    assert.equal(validateInteraction({ ...good, position: undefined }), null);
    assert.equal(validateInteraction({ ...good, position: "1,2,3" }), null);
    assert.equal(validateInteraction({ ...good, position: [1, 2, 3] }), null);
  });

  it("rejects a position with an extra key", () => {
    assert.equal(
      validateInteraction({ ...good, position: { x: 1, y: 2, z: 3, w: 4 } }),
      null,
    );
  });

  it("rejects non-finite coordinates (NaN/Infinity/string)", () => {
    assert.equal(validateInteraction({ ...good, position: { x: NaN, y: 0, z: 0 } }), null);
    assert.equal(validateInteraction({ ...good, position: { x: Infinity, y: 0, z: 0 } }), null);
    assert.equal(validateInteraction({ ...good, position: { x: "1", y: 0, z: 0 } }), null);
  });
});

describe("validateMetrics (F1)", () => {
  const good = { type: "metrics-updated", metrics: { id: "lm1", displaced_mm: 0.42 } };

  it("accepts well-formed metrics and strips nothing but keeps id + numeric fields", () => {
    assert.deepEqual(validateMetrics(good), { id: "lm1", displaced_mm: 0.42 });
  });

  it("rejects an extra top-level key", () => {
    assert.equal(validateMetrics({ ...good, extra: 1 }), null);
  });

  it("rejects metrics with no id", () => {
    assert.equal(validateMetrics({ type: "metrics-updated", metrics: { displaced_mm: 1 } }), null);
  });

  it("rejects an empty metrics object", () => {
    assert.equal(validateMetrics({ type: "metrics-updated", metrics: {} }), null);
  });

  it("rejects more than REVIEW_METRICS_MAX_KEYS keys", () => {
    const metrics: Record<string, number | string> = { id: "lm1" };
    for (let i = 0; i < 20; i++) metrics[`k${i}`] = i;
    assert.equal(validateMetrics({ type: "metrics-updated", metrics }), null);
  });

  it("rejects a non-finite metric value", () => {
    assert.equal(
      validateMetrics({ type: "metrics-updated", metrics: { id: "lm1", drift: NaN } }),
      null,
    );
    assert.equal(
      validateMetrics({ type: "metrics-updated", metrics: { id: "lm1", drift: "far" } }),
      null,
    );
  });
});

describe("appendVerdictLog rate limiting", () => {
  it("appends within the window, caps at REVIEW_LOG_RATE_MAX, then coalesces a suppressed count into the next window", () => {
    let v = newReviewVerdict();
    const t0 = 1_000_000;
    for (let i = 0; i < REVIEW_LOG_RATE_MAX; i++) {
      v = appendVerdictLog(v, `line ${i}`, t0 + i);
    }
    assert.equal(v.log.length, REVIEW_LOG_RATE_MAX, "all lines within the cap were appended");

    // One more in the SAME window: suppressed, not appended.
    v = appendVerdictLog(v, "over the limit", t0 + 5);
    assert.equal(v.log.length, REVIEW_LOG_RATE_MAX, "the 21st event in-window is dropped");
    assert.equal(v.logSuppressed, 1);

    // A few more in-window: keep counting suppressions, still not appended.
    v = appendVerdictLog(v, "also over", t0 + 6);
    assert.equal(v.logSuppressed, 2);
    assert.equal(v.log.length, REVIEW_LOG_RATE_MAX);

    // Next window (> REVIEW_LOG_RATE_WINDOW_MS later): the new line lands,
    // preceded by exactly one coalesced "N suppressed" notice.
    v = appendVerdictLog(v, "next window", t0 + REVIEW_LOG_RATE_WINDOW_MS + 50);
    const tail = v.log.slice(-2).map((l) => l.text);
    assert.deepEqual(tail, ["… 2 event(s) suppressed (rate limit).", "next window"]);
    assert.equal(v.logSuppressed, 0, "suppression counter resets for the new window");
  });

  it("caps v.log at REVIEW_LOG_CAP, dropping the oldest lines", () => {
    let v = newReviewVerdict();
    // Space events far enough apart that none hit the per-window rate cap.
    for (let i = 0; i < REVIEW_LOG_CAP + 10; i++) {
      v = appendVerdictLog(v, `line ${i}`, i * (REVIEW_LOG_RATE_WINDOW_MS + 1));
    }
    assert.equal(v.log.length, REVIEW_LOG_CAP);
    assert.equal(v.log[0]?.text, "line 10", "the oldest 10 lines were dropped");
    assert.equal(v.log[v.log.length - 1]?.text, `line ${REVIEW_LOG_CAP + 9}`);
  });

  it("never mutates the verdict passed in (pure)", () => {
    const v0 = newReviewVerdict();
    const frozen = JSON.stringify(v0);
    appendVerdictLog(v0, "hello", 1);
    assert.equal(JSON.stringify(v0), frozen);
  });
});

describe("applyReviewMessage (the postMessage bridge's core dispatch)", () => {
  it("ignores an unknown message type — returns the SAME verdict reference", () => {
    const v0 = newReviewVerdict();
    const v1 = applyReviewMessage(v0, { type: "eval", code: "alert(1)" }, 1);
    assert.equal(v1, v0, "no-op must be a reference no-op, not just an equal-looking object");
  });

  it("ignores non-object / null data", () => {
    const v0 = newReviewVerdict();
    assert.equal(applyReviewMessage(v0, null, 1), v0);
    assert.equal(applyReviewMessage(v0, "interaction", 1), v0);
    assert.equal(applyReviewMessage(v0, 42, 1), v0);
  });

  it("'ready' with extra keys is dropped silently (no log line)", () => {
    const v0 = newReviewVerdict();
    const v1 = applyReviewMessage(v0, { type: "ready", extra: 1 }, 1);
    assert.equal(v1, v0);
  });

  it("'ready' logs but never touches status/corrected/evidence", () => {
    const v0 = newReviewVerdict();
    const v1 = applyReviewMessage(v0, { type: "ready" }, 1);
    assert.equal(v1.log.at(-1)?.text, "Review site loaded and interactive.");
    assert.equal(v1.status, null);
    assert.equal(v1.corrected, false);
    assert.deepEqual(v1.evidence, []);
  });

  it("an invalid 'interaction' (fails validateInteraction) is a no-op — corrected stays false", () => {
    const v0 = newReviewVerdict();
    const v1 = applyReviewMessage(
      v0,
      { type: "interaction", action: "delete-scene", id: "lm1", position: { x: 0, y: 0, z: 0 } },
      1,
    );
    assert.equal(v1, v0);
    assert.equal(v1.corrected, false);
  });

  it("a valid 'interaction' flips corrected=true, records evidence, appends a log line — but NEVER sets status (TRUST BOUNDARY)", () => {
    const v0 = newReviewVerdict();
    const v1 = applyReviewMessage(
      v0,
      {
        type: "interaction",
        action: "landmark-moved",
        id: "growth_plate_proximal",
        position: { x: 1, y: 2, z: 3 },
      },
      1,
    );
    assert.equal(v1.corrected, true);
    assert.equal(v1.status, null, "interaction must never set the committable status");
    assert.equal(v1.evidence.length, 1);
    assert.deepEqual(v1.evidence[0], {
      action: "landmark-moved",
      id: "growth_plate_proximal",
      position: { x: 1, y: 2, z: 3 },
    });
    assert.match(v1.log.at(-1)?.text ?? "", /Adjusted growth_plate_proximal.*corrected/);
  });

  it("evidence is capped at REVIEW_EVIDENCE_CAP, dropping the oldest", () => {
    let v = newReviewVerdict();
    for (let i = 0; i < REVIEW_EVIDENCE_CAP + 5; i++) {
      v = applyReviewMessage(
        v,
        {
          type: "interaction",
          action: "landmark-moved",
          id: `lm${i}`,
          position: { x: i, y: 0, z: 0 },
        },
        i * (REVIEW_LOG_RATE_WINDOW_MS + 1),
      );
    }
    assert.equal(v.evidence.length, REVIEW_EVIDENCE_CAP);
    assert.equal(v.evidence[0]?.id, "lm5", "the oldest 5 evidence entries were dropped");
  });

  it("'metrics-updated' logs but does not touch corrected/evidence/status", () => {
    const v0 = newReviewVerdict();
    const v1 = applyReviewMessage(
      v0,
      { type: "metrics-updated", metrics: { id: "lm1", displaced_mm: 0.3 } },
      1,
    );
    assert.match(v1.log.at(-1)?.text ?? "", /Metrics for lm1: displaced_mm=0\.3/);
    assert.equal(v1.corrected, false);
    assert.equal(v1.status, null);
    assert.deepEqual(v1.evidence, []);
  });

  it("an invalid 'metrics-updated' is a no-op", () => {
    const v0 = newReviewVerdict();
    const v1 = applyReviewMessage(v0, { type: "metrics-updated", metrics: {} }, 1);
    assert.equal(v1, v0);
  });
});

describe("revokeEvidence (bridge revocation on unexpected iframe reload — F1)", () => {
  it("clears corrected + evidence, PRESERVES an explicit status, and logs why", () => {
    let v = newReviewVerdict();
    v = applyReviewMessage(
      v,
      { type: "interaction", action: "landmark-moved", id: "lm1", position: { x: 1, y: 1, z: 1 } },
      1,
    );
    v = withStatus(v, "pass");
    assert.equal(v.corrected, true);
    assert.equal(v.status, "pass");

    const revoked = revokeEvidence(v, "the sandboxed frame navigated or reloaded itself", 2000);
    assert.equal(revoked.corrected, false);
    assert.deepEqual(revoked.evidence, []);
    assert.equal(revoked.status, "pass", "the reviewer's own explicit verdict is not iframe-sourced");
    assert.match(revoked.log.at(-1)?.text ?? "", /Bridge revoked — the sandboxed frame/);
  });
});

describe("withStatus — the only setter of the committable verdict", () => {
  it("sets status and touches nothing else, without logging", () => {
    const v0 = newReviewVerdict();
    const v1 = withStatus(v0, "pass");
    assert.equal(v1.status, "pass");
    assert.equal(v1.corrected, false);
    assert.deepEqual(v1.log, [], "withStatus itself does not log — callers log the human action");
  });
});

describe("verdictLabel / verdictPillClass", () => {
  it("prefers explicit status over the corrected hint over pending", () => {
    const base: ReviewVerdict = newReviewVerdict();
    assert.equal(verdictLabel(base), "pending");
    assert.equal(verdictLabel({ ...base, corrected: true }), "corrected");
    assert.equal(verdictLabel({ ...base, corrected: true, status: "fail" }), "fail");
  });

  it("maps each label to its pill class", () => {
    assert.equal(verdictPillClass("pass"), "pill-pass");
    assert.equal(verdictPillClass("fail"), "pill-fail");
    assert.equal(verdictPillClass("corrected"), "pill-warn");
    assert.equal(verdictPillClass("pending"), "pill-skip");
  });
});

describe("adjustmentsFromEvidence (Finish-review payload assembly)", () => {
  it("dedupes by id, keeping the LATEST position, proposed is honestly null", () => {
    const evidence = [
      { action: "landmark-moved" as const, id: "lm1", position: { x: 1, y: 0, z: 0 } },
      { action: "landmark-moved" as const, id: "lm2", position: { x: 5, y: 5, z: 5 } },
      { action: "landmark-moved" as const, id: "lm1", position: { x: 2, y: 0, z: 0 } },
    ];
    const adjustments = adjustmentsFromEvidence(evidence);
    assert.equal(adjustments.length, 2, "lm1's two drags collapse into one adjustment");
    assert.deepEqual(adjustments[0], { id: "lm1", proposed: null, corrected: { x: 2, y: 0, z: 0 } });
    assert.deepEqual(adjustments[1], { id: "lm2", proposed: null, corrected: { x: 5, y: 5, z: 5 } });
  });

  it("returns [] for no evidence", () => {
    assert.deepEqual(adjustmentsFromEvidence([]), []);
  });
});
