import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProtocolPhase } from "./protocol.js";
import { resolveReviewArtifact } from "./protocol.js";
import { validateProtocolYaml } from "./index.js";

/** Minimal valid protocol wrapping a single phase, for validator round-trips. */
function protocolWithPhase(phase: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: "protocol",
    name: "p",
    version: 1,
    expects: {},
    phases: [phase],
    runtime: { deps: [] },
    parent_skills: [],
    agents: {
      worker: { tools: ["Read"] },
      "gate-reviewer": { tools: ["Read"] },
      // An explicit (non-none, non-legacy) review_artifact phase requires an
      // executable author profile at load time (design §3.D) — carried here
      // so single-phase round-trips exercise the phase rules, not that gate.
      "review-artifact-author": { tools: ["Read", "Write", "Edit", "Glob", "Grep"] },
    },
  };
}

/** Parse a single phase through the real protocol validator. */
function parsePhase(phase: Record<string, unknown>): ProtocolPhase {
  const res = validateProtocolYaml(protocolWithPhase(phase));
  assert.equal(res.ok, true, res.ok ? "" : JSON.stringify(res.errors));
  if (!res.ok) throw new Error("unreachable");
  const p = res.value.phases[0];
  assert.ok(p);
  return p;
}

describe("resolveReviewArtifact — normalization (design §3.D)", () => {
  it("explicit type: none → none, not legacy", () => {
    const phase = parsePhase({
      id: "intake",
      skills: ["resources/intake"],
      review_artifact: { type: "none" },
    });
    assert.deepEqual(resolveReviewArtifact(phase), { type: "none", legacy: false });
  });

  it("present block, type omitted → spatial-3d (the warranted default)", () => {
    const phase = parsePhase({
      id: "segmentation",
      skills: ["seg"],
      review_artifact: {},
    });
    assert.deepEqual(resolveReviewArtifact(phase), {
      type: "spatial-3d",
      legacy: false,
    });
  });

  it("present block with explicit type + template passes both through", () => {
    const phase = parsePhase({
      id: "measure",
      skills: ["m"],
      review_artifact: { type: "quantitative", template: "quantitative" },
    });
    assert.deepEqual(resolveReviewArtifact(phase), {
      type: "quantitative",
      template: "quantitative",
      legacy: false,
    });
  });

  it("absent block + legacy review-site output → legacy (legacy: true)", () => {
    const phase = parsePhase({
      id: "review",
      skills: ["r"],
      outputs: ["review-site/index.html"],
    });
    const resolved = resolveReviewArtifact(phase);
    assert.equal(resolved.legacy, true);
    // `type` is nominal for legacy; callers branch on `legacy` first. It must
    // NOT be "none" so a `type === "none"` shortcut cannot skip the legacy check.
    assert.notEqual(resolved.type, "none");
  });

  it("absent block + bare review-site output → legacy", () => {
    const phase = parsePhase({
      id: "review",
      skills: ["r"],
      outputs: ["review-site"],
    });
    assert.equal(resolveReviewArtifact(phase).legacy, true);
  });

  it("absent block, no review-site output → none (backward compatible)", () => {
    const phase = parsePhase({
      id: "intake",
      skills: ["resources/intake"],
      outputs: ["intensity.nii.gz"],
    });
    assert.deepEqual(resolveReviewArtifact(phase), { type: "none", legacy: false });
  });
});

describe("validatePhase — review_artifact validation", () => {
  it("rejects a non-empty cdn_allowlist on a none-resolving phase", () => {
    const res = validateProtocolYaml(
      protocolWithPhase({
        id: "intake",
        skills: ["resources/intake"],
        review_artifact: { type: "none" },
        cdn_allowlist: ["https://cdn.plot.ly"],
      }),
    );
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.match(res.errors[0]?.message ?? "", /cdn_allowlist/);
    }
  });

  it("allows an empty cdn_allowlist on a none-resolving phase", () => {
    const res = validateProtocolYaml(
      protocolWithPhase({
        id: "intake",
        skills: ["resources/intake"],
        review_artifact: { type: "none" },
        cdn_allowlist: [],
      }),
    );
    assert.equal(res.ok, true);
  });

  it("allows a cdn_allowlist on a legacy review-site phase (G6 needs it)", () => {
    const res = validateProtocolYaml(
      protocolWithPhase({
        id: "review",
        skills: ["r"],
        outputs: ["review-site/index.html"],
        cdn_allowlist: ["https://cdn.plot.ly"],
      }),
    );
    assert.equal(res.ok, true);
  });

  it("rejects a path-like template (contains /)", () => {
    const res = validateProtocolYaml(
      protocolWithPhase({
        id: "review",
        skills: ["r"],
        review_artifact: { type: "spatial-3d", template: "../evil/x" },
      }),
    );
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.match(res.errors[0]?.message ?? "", /registry id/);
    }
  });

  it("rejects a path-like template (contains . and \\)", () => {
    for (const template of ["a.b", "a\\b"]) {
      const res = validateProtocolYaml(
        protocolWithPhase({
          id: "review",
          skills: ["r"],
          review_artifact: { type: "document", template },
        }),
      );
      assert.equal(res.ok, false, `template "${template}" should be rejected`);
    }
  });

  it("rejects an unknown review_artifact type", () => {
    const res = validateProtocolYaml(
      protocolWithPhase({
        id: "review",
        skills: ["r"],
        review_artifact: { type: "holographic" },
      }),
    );
    assert.equal(res.ok, false);
  });

  it("accepts landmarks_available: false and preserves it (G9 authority)", () => {
    const phase = parsePhase({
      id: "intake",
      skills: ["s"],
      review_artifact: { type: "spatial-3d", landmarks_available: false },
    });
    assert.equal(phase.review_artifact?.landmarks_available, false);
  });

  it("omits landmarks_available when absent (defaults true at the G9 seam)", () => {
    const phase = parsePhase({
      id: "landmarks",
      skills: ["s"],
      review_artifact: { type: "spatial-3d" },
    });
    assert.equal(phase.review_artifact?.landmarks_available, undefined);
  });

  it("rejects a non-boolean landmarks_available", () => {
    const res = validateProtocolYaml(
      protocolWithPhase({
        id: "review",
        skills: ["r"],
        review_artifact: { type: "spatial-3d", landmarks_available: "false" },
      }),
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.errors[0]?.message ?? "", /expected boolean/);
  });
});

describe("validateProtocolYaml — review-artifact-author profile requirement (design §3.D)", () => {
  function protocolWithAgents(
    phase: Record<string, unknown>,
    agents: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      kind: "protocol",
      name: "p",
      version: 1,
      expects: {},
      phases: [phase],
      runtime: { deps: [] },
      parent_skills: [],
      agents,
    };
  }
  const baseAgents = {
    worker: { tools: ["Read"] },
    "gate-reviewer": { tools: ["Read"] },
  };

  it("rejects an explicit review_artifact phase without agents.review-artifact-author", () => {
    const res = validateProtocolYaml(
      protocolWithAgents(
        { id: "seg", skills: ["s"], review_artifact: { type: "spatial-3d" } },
        baseAgents,
      ),
    );
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.errors[0]?.message ?? "", /review-artifact-author/);
  });

  it("accepts type: none and legacy review-site phases without the author profile", () => {
    const nonePhase = validateProtocolYaml(
      protocolWithAgents(
        { id: "intake", skills: ["s"], review_artifact: { type: "none" } },
        baseAgents,
      ),
    );
    assert.equal(nonePhase.ok, true, nonePhase.ok ? "" : JSON.stringify(nonePhase.errors));

    const legacyPhase = validateProtocolYaml(
      protocolWithAgents(
        { id: "review", skills: ["s"], outputs: ["review-site/index.html"] },
        baseAgents,
      ),
    );
    assert.equal(legacyPhase.ok, true, legacyPhase.ok ? "" : JSON.stringify(legacyPhase.errors));
  });

  it("accepts an explicit review_artifact phase when the author profile is present", () => {
    const res = validateProtocolYaml(
      protocolWithAgents(
        { id: "seg", skills: ["s"], review_artifact: { type: "quantitative" } },
        { ...baseAgents, "review-artifact-author": { tools: ["Read", "Write"] } },
      ),
    );
    assert.equal(res.ok, true, res.ok ? "" : JSON.stringify(res.errors));
  });
});
