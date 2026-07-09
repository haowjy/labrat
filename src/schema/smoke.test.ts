import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  allSubphasesCloseable,
  isCloseableMark,
  validateBlockedInput,
  validateGateFile,
  validateMarkSubphaseInput,
  validateMcpToolInput,
  validateProtocolYaml,
  validateProvenanceManifest,
  validateProvenanceManifestEntry,
  validateRecordPhaseInput,
  validateSseEvent,
  validateSubmitGateDecisionInput,
  validateSubphasesJson,
  validateSuggestionEntry,
  validateSuggestionsJson,
  validateTaskJson,
  validateVerdictJson,
} from "./index.js";

describe("schema validators round-trip", () => {
  it("task.json valid + invalid", () => {
    const valid = {
      id: "task-2026-07-09-001",
      protocol: "bonemorph-oa-mouse-knee",
      input: "input/OA6-1RK/",
      state: "running",
      currentPhase: "segmentation",
      phasesComplete: ["intake"],
      createdAt: "2026-07-09T10:00:00.000Z",
      updatedAt: "2026-07-09T10:15:00.000Z",
    };
    const ok = validateTaskJson(valid);
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.deepEqual(ok.value, valid);
    }

    const bad = validateTaskJson({ ...valid, id: "bad-id" });
    assert.equal(bad.ok, false);
  });

  it("protocol.yaml valid + invalid", () => {
    const valid = {
      kind: "protocol",
      name: "bonemorph-oa-mouse-knee",
      version: 1,
      expects: {
        modality: "CT",
        body_part: ["knee", "hindlimb"],
        species: ["mouse", "rat"],
        min_slices: 100,
      },
      inspect: "assets/inspect.py",
      phases: [
        {
          id: "intake",
          skills: ["resources/intake"],
          outputs: ["intensity.nii.gz", "spacing.json"],
        },
        {
          id: "segmentation",
          skills: ["segmentation-bone-ct", "resources/threshold"],
          inputs: ["intensity.nii.gz"],
          outputs: ["labels.nii.gz"],
          subphases: [
            { id: "threshold" },
            { id: "watershed", depends_on: ["threshold"] },
          ],
        },
      ],
      sanity_checks: "assets/expected_ranges.json",
      runtime: {
        substrate: "microct_analysis",
        deps: ["nibabel", "python:scipy", "binary:freesurfer"],
      },
      parent_skills: ["microct-3d-analysis"],
      agents: {
        worker: {
          tools: ["Bash", "Read", "record_phase", "mark_subphase"],
          subagents: {
            reviewer: {
              description: "Independent subphase verification",
              tools: ["Read", "Grep"],
            },
          },
        },
        "gate-reviewer": {
          tools: ["Read", "submit_gate_decision"],
          writable: ["review/verification/"],
          max_findings: 5,
        },
      },
      requires: {
        worker: { tools: ["Bash"], runtime: ["scipy"] },
        reviewer: { runtime: ["nibabel"] },
      },
    };
    const ok = validateProtocolYaml(valid);
    assert.equal(ok.ok, true);

    const bad = validateProtocolYaml({ ...valid, kind: "skill" });
    assert.equal(bad.ok, false);
  });

  it("subphases.json + closeable helper", () => {
    const log = [
      {
        subphase: "threshold",
        mark: "pass" as const,
        confidence: "high" as const,
        notes: "clean separation",
        attempt: 1,
        timestamp: "2026-07-09T10:20:00.000Z",
      },
      {
        subphase: "watershed",
        mark: "fail" as const,
        attempt: 1,
        timestamp: "2026-07-09T10:25:00.000Z",
      },
      {
        subphase: "watershed",
        mark: "human-review" as const,
        confidence: "medium" as const,
        attempt: 2,
        timestamp: "2026-07-09T10:30:00.000Z",
      },
    ];
    const ok = validateSubphasesJson(log);
    assert.equal(ok.ok, true);

    assert.equal(isCloseableMark("pass"), true);
    assert.equal(isCloseableMark("fail"), false);
    assert.equal(
      allSubphasesCloseable(["threshold", "watershed"], log).ok,
      true,
    );
    assert.equal(
      allSubphasesCloseable(["threshold", "bone-assignment"], log).ok,
      false,
    );

    const bad = validateSubphasesJson([
      { subphase: "x", mark: "pass", attempt: 1, timestamp: "not-a-date" },
    ]);
    assert.equal(bad.ok, false);
  });

  it("gate decision, gate file, verdict", () => {
    const toolInput = {
      decision: "pass",
      rewind_to: null,
      feedback: null,
      subphase_assessments: { threshold: "agree" },
    };
    const okTool = validateSubmitGateDecisionInput(toolInput);
    assert.equal(okTool.ok, true);

    const gateFile = {
      phase: "segmentation",
      decidedAt: "2026-07-09T10:45:00.000Z",
      ...toolInput,
    };
    const okGate = validateGateFile(gateFile);
    assert.equal(okGate.ok, true);

    const verdict = {
      status: "pass",
      flags: ["low-margin-bone-identity"],
      gated_measurements: { femur_length_mm: 2.42 },
      updatedAt: "2026-07-09T11:00:00.000Z",
    };
    const okVerdict = validateVerdictJson(verdict);
    assert.equal(okVerdict.ok, true);

    const bad = validateSubmitGateDecisionInput({
      decision: "fail-upstream",
    });
    assert.equal(bad.ok, false);
  });

  it("provenance manifest entry", () => {
    const entry = {
      phase: "intake",
      attempt: 1,
      started: "2026-07-09T10:15:23.000Z",
      completed: "2026-07-09T10:18:45.000Z",
      skills_loaded: [{ name: "resources/intake", hash: "abc123" }],
      agent: "worker",
      inputs: [],
      outputs: [
        { path: "artifacts/intensity.nii.gz", hash: "def456" },
        { path: "artifacts/masks/", fileCount: 3 },
      ],
      subphases: null,
      sessions: { worker: "sess_xyz789", gate: "sess_uvw012" },
      gate_decision: "pass",
      verification: {
        code: "review/verification/intake/",
        results: "review/gates/intake.json",
      },
    };
    const okEntry = validateProvenanceManifestEntry(entry);
    assert.equal(okEntry.ok, true);

    const okManifest = validateProvenanceManifest([entry]);
    assert.equal(okManifest.ok, true);

    const bad = validateProvenanceManifestEntry({ ...entry, sessions: {} });
    assert.equal(bad.ok, false);
  });

  it("SSE events — all 8 types", () => {
    const taskId = "task-2026-07-09-001";
    const events = [
      { type: "task-started", taskId, protocol: "bonemorph-oa-mouse-knee" },
      { type: "phase-started", taskId, phase: "intake" },
      { type: "phase-complete", taskId, phase: "intake" },
      {
        type: "gate-result",
        taskId,
        phase: "intake",
        decision: "pass",
      },
      { type: "task-done", taskId },
      { type: "task-failed", taskId, reason: "worker crash" },
      { type: "task-paused", taskId, reason: "blocked" },
      { type: "log", taskId, line: "threshold calibrated", ephemeral: true },
    ] as const;

    for (const event of events) {
      const result = validateSseEvent(event);
      assert.equal(result.ok, true, `expected ${event.type} to validate`);
    }

    const bad = validateSseEvent({ type: "log", taskId, line: "x" });
    assert.equal(bad.ok, false);
  });

  it("suggestions.json", () => {
    const entry = {
      id: "sg-001",
      taskId: "task-2026-07-09-001",
      protocol: "bonemorph-oa-mouse-knee",
      phase: "landmarks",
      text: "Growth plate boundary looks too deep.",
      createdAt: "2026-07-09T12:00:00.000Z",
      author: "jimmy@voluma.bio",
    };
    const okEntry = validateSuggestionEntry(entry);
    assert.equal(okEntry.ok, true);

    const okList = validateSuggestionsJson([entry]);
    assert.equal(okList.ok, true);

    const bad = validateSuggestionEntry({ ...entry, taskId: "nope" });
    assert.equal(bad.ok, false);
  });

  it("MCP tool inputs", () => {
    assert.equal(
      validateRecordPhaseInput({ phase: "intake" }).ok,
      true,
    );
    assert.equal(
      validateMarkSubphaseInput({
        subphase: "threshold",
        mark: "pass",
        confidence: "high",
      }).ok,
      true,
    );
    assert.equal(
      validateBlockedInput({ reason: "missing input volume" }).ok,
      true,
    );
    assert.equal(
      validateMcpToolInput("submit_gate_decision", {
        decision: "pass-with-concerns",
        feedback: "minor artifact",
      }).ok,
      true,
    );

    assert.equal(
      validateMarkSubphaseInput({ subphase: "x", mark: "pass" }).ok,
      false,
    );
  });
});
