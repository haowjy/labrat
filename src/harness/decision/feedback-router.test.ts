import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type {
  ProtocolYaml,
  ReviewVerdictRecord,
  SendBackInvalidationRecord,
  SendBackRouteRecord,
  SubmitFeedbackRouteInput,
  TaskJson,
} from "../../schema/index.js";
import { validateSubmitFeedbackRouteInput } from "../../schema/index.js";
import { allowedLabratTools } from "../session/signals.js";
import { invalidateForSendBack } from "../orchestrator/index.js";
import {
  buildFeedbackRouterQueryOptions,
  collectLiveMarks,
  decideSendBackRoute,
  FEEDBACK_ROUTER_BUILTIN_TOOLS,
  type FeedbackRouterContext,
  type FeedbackRouterFn,
  type FeedbackRouterOutcome,
} from "./feedback-router.js";

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

const protocolYaml = {
  kind: "protocol",
  name: "test-protocol",
  version: 1,
  expects: { modality: "microct", species: "mouse" },
  agents: { worker: { model: "test" }, reviewer: { model: "test" } },
  phases: [
    { id: "intake", skills: [], inputs: [], outputs: ["spacing.json"] },
    {
      id: "segmentation",
      skills: [],
      inputs: ["spacing.json"],
      outputs: ["labels.nii.gz"],
    },
    {
      id: "measure",
      skills: [],
      inputs: ["labels.nii.gz"],
      outputs: ["measurements/thickness.json"],
    },
  ],
} as unknown as ProtocolYaml;

const PHASE_IDS = ["intake", "segmentation", "measure"];

function humanVerdict(
  phase: string,
  verdict: ReviewVerdictRecord["human_verdict"],
  notes: string,
): ReviewVerdictRecord {
  return {
    phase,
    human_verdict: verdict,
    corrected: false,
    notes,
    adjustments: [],
    agent_confidence: null,
    agent_gate_decision: null,
    agent_gate_feedback: null,
    reviewed_at: "2026-07-10T00:00:00.000Z",
  };
}

async function makeCompletedRun(): Promise<string> {
  const taskDir = await mkdtemp(join(tmpdir(), "labrat-feedback-router-"));
  await mkdir(join(taskDir, "artifacts", "measurements"), { recursive: true });
  await writeFile(join(taskDir, "artifacts", "spacing.json"), '{"spacing":[1,1,1]}');
  await writeFile(join(taskDir, "artifacts", "labels.nii.gz"), "LABELS");
  await writeFile(
    join(taskDir, "artifacts", "measurements", "thickness.json"),
    '{"t":0.1}',
  );
  for (const id of PHASE_IDS) {
    await mkdir(join(taskDir, "phases", id), { recursive: true });
    await writeFile(join(taskDir, "phases", id, "summary.md"), `# ${id}\n`);
  }
  await mkdir(join(taskDir, "review", "verdict"), { recursive: true });

  const task: TaskJson = {
    id: "task-2026-07-10-001",
    protocol: "test-protocol",
    input: "input/scan",
    state: "done",
    currentPhase: null,
    phasesComplete: [...PHASE_IDS],
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
  };
  await writeFile(join(taskDir, "task.json"), JSON.stringify(task));
  return taskDir;
}

async function writeMark(taskDir: string, phase: string, notes: string): Promise<void> {
  await writeFile(
    join(taskDir, "review", "verdict", `${phase}.json`),
    JSON.stringify(humanVerdict(phase, "changes_requested", notes)),
  );
}

function proposal(
  restart: string | null,
  confidence: SubmitFeedbackRouteInput["confidence"],
): SubmitFeedbackRouteInput {
  return {
    restart_phase: restart,
    confidence,
    justification: "test rationale",
    implicated_feedback_phases: [],
    alternatives: [],
  };
}

function outcomeOf(
  p: SubmitFeedbackRouteInput | null,
  failure: string | null = null,
): FeedbackRouterOutcome {
  return {
    proposal: p,
    model: { name: "haiku", session_id: "sess-1", prompt_version: "feedback-router-v1" },
    failure,
  };
}

/** Deterministic router stub: records invocations, returns a fixed outcome. */
function stubRouter(outcome: FeedbackRouterOutcome | Error): {
  readonly fn: FeedbackRouterFn;
  readonly calls: FeedbackRouterContext[];
} {
  const calls: FeedbackRouterContext[] = [];
  const fn: FeedbackRouterFn = async (ctx) => {
    calls.push(ctx);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  return { fn, calls };
}

async function readRouteRecord(
  taskDir: string,
  routeId: string,
): Promise<SendBackRouteRecord> {
  return JSON.parse(
    await readFile(
      join(taskDir, "review", "routing", "send-back", `${routeId}.json`),
      "utf8",
    ),
  ) as SendBackRouteRecord;
}

async function readInvalidationRecord(
  taskDir: string,
  routeId: string,
): Promise<SendBackInvalidationRecord> {
  return JSON.parse(
    await readFile(
      join(taskDir, "review", "routing", "invalidation", `${routeId}.json`),
      "utf8",
    ),
  ) as SendBackInvalidationRecord;
}

describe("decideSendBackRoute — the pure code-owned adoption policy", () => {
  const base = { phaseIds: PHASE_IDS, earliestMarkedPhase: "segmentation" };

  it("explicit human override always wins, even over a live proposal", () => {
    const d = decideSendBackRoute({
      ...base,
      fromPhase: "measure",
      outcome: outcomeOf(proposal("intake", "high")),
    });
    assert.equal(d.accepted_phase, "measure");
    assert.equal(d.source, "human-override");
    assert.equal(d.acceptance, "human-override");
    assert.deepEqual(d.validation_errors, []);
  });

  it("valid high-confidence route at the earliest mark is auto-accepted", () => {
    const d = decideSendBackRoute({
      ...base,
      outcome: outcomeOf(proposal("segmentation", "high")),
    });
    assert.equal(d.accepted_phase, "segmentation");
    assert.equal(d.source, "llm");
    assert.equal(d.acceptance, "auto-high");
  });

  it("valid high-confidence UPSTREAM route is auto-accepted", () => {
    const d = decideSendBackRoute({
      ...base,
      outcome: outcomeOf(proposal("intake", "high")),
    });
    assert.equal(d.accepted_phase, "intake");
    assert.equal(d.acceptance, "auto-high");
  });

  it("a DOWNSTREAM proposal falls back to the earliest mark — never later to save cost", () => {
    const d = decideSendBackRoute({
      ...base,
      outcome: outcomeOf(proposal("measure", "high")),
    });
    assert.equal(d.accepted_phase, "segmentation");
    assert.equal(d.source, "deterministic-fallback");
    assert.equal(d.acceptance, "fallback");
    assert.match(d.validation_errors.join(" "), /downstream/);
  });

  it("null restart_phase (cannot route) falls back", () => {
    const d = decideSendBackRoute({ ...base, outcome: outcomeOf(proposal(null, "high")) });
    assert.equal(d.accepted_phase, "segmentation");
    assert.equal(d.acceptance, "fallback");
    assert.match(d.validation_errors.join(" "), /null restart_phase/);
  });

  it("medium and low confidence fall back with the reason recorded", () => {
    for (const confidence of ["medium", "low"] as const) {
      const d = decideSendBackRoute({
        ...base,
        outcome: outcomeOf(proposal("intake", confidence)),
      });
      assert.equal(d.accepted_phase, "segmentation");
      assert.equal(d.acceptance, "fallback");
      assert.match(d.validation_errors.join(" "), /below the auto-accept bar/);
    }
  });

  it("an unknown proposed phase falls back", () => {
    const d = decideSendBackRoute({
      ...base,
      outcome: outcomeOf(proposal("registration", "high")),
    });
    assert.equal(d.accepted_phase, "segmentation");
    assert.match(d.validation_errors.join(" "), /not a protocol phase/);
  });

  it("timeout / session failure falls back with the failure recorded", () => {
    const d = decideSendBackRoute({ ...base, outcome: outcomeOf(null, "timeout") });
    assert.equal(d.accepted_phase, "segmentation");
    assert.equal(d.acceptance, "fallback");
    assert.match(d.validation_errors.join(" "), /timeout/);
  });

  it("no router at all (profile absent) is the deterministic earliest-mark route", () => {
    const d = decideSendBackRoute({ ...base, outcome: null });
    assert.equal(d.accepted_phase, "segmentation");
    assert.equal(d.source, "deterministic-fallback");
  });
});

describe("submit_feedback_route input validation", () => {
  it("accepts a well-formed proposal and defaults optional arrays", () => {
    const v = validateSubmitFeedbackRouteInput({
      restart_phase: "segmentation",
      confidence: "high",
      justification: "mask leaked into fibula",
    });
    assert.ok(v.ok);
    assert.equal(v.value.restart_phase, "segmentation");
    assert.deepEqual(v.value.implicated_feedback_phases, []);
    assert.deepEqual(v.value.alternatives, []);
  });

  it("accepts explicit null restart_phase", () => {
    const v = validateSubmitFeedbackRouteInput({
      restart_phase: null,
      confidence: "low",
      justification: "cannot route",
    });
    assert.ok(v.ok);
    assert.equal(v.value.restart_phase, null);
  });

  it("rejects unknown confidence, oversize justification, >3 alternatives", () => {
    assert.equal(
      validateSubmitFeedbackRouteInput({
        restart_phase: "a",
        confidence: "certain",
        justification: "x",
      }).ok,
      false,
    );
    assert.equal(
      validateSubmitFeedbackRouteInput({
        restart_phase: "a",
        confidence: "high",
        justification: "x".repeat(601),
      }).ok,
      false,
    );
    assert.equal(
      validateSubmitFeedbackRouteInput({
        restart_phase: "a",
        confidence: "high",
        justification: "x",
        alternatives: [
          { phase: "a", reason: "r" },
          { phase: "b", reason: "r" },
          { phase: "c", reason: "r" },
          { phase: "d", reason: "r" },
        ],
      }).ok,
      false,
    );
  });
});

describe("feedback-router confinement", () => {
  it("the role's only tool is submit_feedback_route, and no other role gets it", () => {
    assert.deepEqual(allowedLabratTools("feedback-router", []), [
      "mcp__labrat__submit_feedback_route",
    ]);
    for (const role of ["worker", "gate-reviewer", "monitor", "review-artifact-author"] as const) {
      assert.ok(
        !allowedLabratTools(role, ["s1"]).includes("mcp__labrat__submit_feedback_route"),
        `${role} must not see submit_feedback_route`,
      );
    }
  });

  it("query options: no built-in tools, hermetic MCP/settings", () => {
    const ctx: FeedbackRouterContext = {
      taskId: "t",
      taskDir: "/tmp/none",
      protocolYaml,
      marks: [],
      earliestMarkedPhase: "segmentation",
      model: "haiku",
      permissionMode: "default",
    };
    const options = buildFeedbackRouterQueryOptions(
      ctx,
      // The server instance is irrelevant to the assertions below.
      null as unknown as Parameters<typeof buildFeedbackRouterQueryOptions>[1],
      new AbortController(),
      false,
    );
    assert.deepEqual(FEEDBACK_ROUTER_BUILTIN_TOOLS, []);
    assert.deepEqual(options.tools, []);
    assert.deepEqual(options.allowedTools, ["mcp__labrat__submit_feedback_route"]);
    assert.equal(options.strictMcpConfig, true);
    assert.deepEqual(options.settingSources, []);
  });
});

describe("collectLiveMarks", () => {
  it("returns only live changes_requested records, in declaration order, with sha256", async () => {
    const taskDir = await makeCompletedRun();
    try {
      await writeMark(taskDir, "measure", "later");
      await writeMark(taskDir, "segmentation", "earlier");
      await writeFile(
        join(taskDir, "review", "verdict", "intake.json"),
        JSON.stringify(humanVerdict("intake", "pass", "fine")),
      );
      const marks = await collectLiveMarks(taskDir, protocolYaml);
      assert.deepEqual(
        marks.map((m) => m.phase),
        ["segmentation", "measure"],
      );
      for (const m of marks) {
        assert.match(m.sha256, /^[0-9a-f]{64}$/);
        assert.equal(m.path, join("review", "verdict", `${m.phase}.json`));
      }
    } finally {
      await rm(taskDir, { recursive: true, force: true });
    }
  });
});

describe("invalidateForSendBack — routed send-back (LLM mocked at the router seam)", () => {
  it("human override wins: router never invoked, record audited as human-override", async () => {
    const taskDir = await makeCompletedRun();
    try {
      await writeMark(taskDir, "segmentation", "Fix the femur speckle.");
      const { fn, calls } = stubRouter(outcomeOf(proposal("intake", "high")));

      const { phase, route } = await invalidateForSendBack(
        taskDir,
        protocolYaml,
        "measure",
        { router: fn },
      );
      assert.equal(phase, "measure");
      assert.equal(calls.length, 0, "router must not run under an explicit override");

      const record = await readRouteRecord(taskDir, route.route_id);
      assert.equal(record.source, "human-override");
      assert.equal(record.acceptance, "human-override");
      assert.equal(record.accepted_phase, "measure");
      assert.equal(record.model, null);
      assert.equal(record.proposal, null);
      // The live mark is audited in the record even though the override won.
      assert.deepEqual(
        record.feedback_files.map((f) => f.path),
        ["review/verdict/segmentation.json"],
      );
    } finally {
      await rm(taskDir, { recursive: true, force: true });
    }
  });

  it("high-confidence upstream route is auto-accepted and invalidation restarts there", async () => {
    const taskDir = await makeCompletedRun();
    try {
      await writeMark(taskDir, "measure", "thickness wrong because the mask leaked");
      const { fn, calls } = stubRouter(outcomeOf(proposal("segmentation", "high")));

      const { phase, task, route } = await invalidateForSendBack(
        taskDir,
        protocolYaml,
        undefined,
        { router: fn },
      );
      assert.equal(phase, "segmentation");
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.earliestMarkedPhase, "measure");

      // Code-owned invalidation applied from the ACCEPTED phase.
      assert.equal(await exists(join(taskDir, "phases", "segmentation")), false);
      assert.ok(await exists(join(taskDir, "phases", "segmentation.attempt-1")));
      assert.ok(await exists(join(taskDir, "phases", "measure.attempt-1")));
      assert.ok(await exists(join(taskDir, "phases", "intake")), "upstream intact");
      assert.deepEqual(task.phasesComplete, ["intake"]);
      assert.equal(task.currentPhase, "segmentation");

      const record = await readRouteRecord(taskDir, route.route_id);
      assert.equal(record.source, "llm");
      assert.equal(record.acceptance, "auto-high");
      assert.equal(record.accepted_phase, "segmentation");
      assert.equal(record.proposal?.restart_phase, "segmentation");
      assert.equal(record.model?.name, "haiku");
      assert.deepEqual(record.validation_errors, []);

      const inv = await readInvalidationRecord(taskDir, route.route_id);
      assert.equal(inv.status, "applied");
      assert.deepEqual(inv.downstream_phases, ["segmentation", "measure"]);
      assert.deepEqual(
        inv.archived.map((a) => a.path),
        ["phases/segmentation.attempt-1", "phases/measure.attempt-1"],
      );

      // The human mark stays LIVE — consumed only when its own re-run gate
      // passes (consumeSendBackVerdict, phase-local; never at routing time).
      assert.ok(await exists(join(taskDir, "review", "verdict", "measure.json")));
    } finally {
      await rm(taskDir, { recursive: true, force: true });
    }
  });

  it("downstream proposal is rejected: earliest-mark fallback with the reason recorded", async () => {
    const taskDir = await makeCompletedRun();
    try {
      await writeMark(taskDir, "segmentation", "segmentation looks wrong");
      const { fn } = stubRouter(outcomeOf(proposal("measure", "high")));

      const { phase, route } = await invalidateForSendBack(taskDir, protocolYaml, undefined, {
        router: fn,
      });
      assert.equal(phase, "segmentation");

      const record = await readRouteRecord(taskDir, route.route_id);
      assert.equal(record.source, "deterministic-fallback");
      assert.equal(record.acceptance, "fallback");
      assert.match(record.validation_errors.join(" "), /downstream/);
      // The rejected proposal is still audited verbatim.
      assert.equal(record.proposal?.restart_phase, "measure");
    } finally {
      await rm(taskDir, { recursive: true, force: true });
    }
  });

  it("null / low-confidence / timeout / thrown router all fall back safely", async () => {
    const cases: Array<{ name: string; outcome: FeedbackRouterOutcome | Error; reason: RegExp }> = [
      { name: "null route", outcome: outcomeOf(proposal(null, "high")), reason: /null restart_phase/ },
      { name: "low confidence", outcome: outcomeOf(proposal("intake", "low")), reason: /below the auto-accept bar/ },
      { name: "timeout", outcome: outcomeOf(null, "timeout"), reason: /timeout/ },
      { name: "router crash", outcome: new Error("boom"), reason: /router error: boom/ },
    ];
    for (const c of cases) {
      const taskDir = await makeCompletedRun();
      try {
        await writeMark(taskDir, "segmentation", "something is off");
        const { fn } = stubRouter(c.outcome);
        const { phase, route } = await invalidateForSendBack(taskDir, protocolYaml, undefined, {
          router: fn,
        });
        assert.equal(phase, "segmentation", c.name);
        const record = await readRouteRecord(taskDir, route.route_id);
        assert.equal(record.acceptance, "fallback", c.name);
        assert.match(record.validation_errors.join(" "), c.reason, c.name);
      } finally {
        await rm(taskDir, { recursive: true, force: true });
      }
    }
  });

  it("invalid router output (unknown phase) is rejected by code, not adopted", async () => {
    const taskDir = await makeCompletedRun();
    try {
      await writeMark(taskDir, "segmentation", "bad");
      const { fn } = stubRouter(outcomeOf(proposal("not-a-phase", "high")));
      const { phase, route } = await invalidateForSendBack(taskDir, protocolYaml, undefined, {
        router: fn,
      });
      assert.equal(phase, "segmentation");
      const record = await readRouteRecord(taskDir, route.route_id);
      assert.match(record.validation_errors.join(" "), /not a protocol phase/);
    } finally {
      await rm(taskDir, { recursive: true, force: true });
    }
  });

  it("multiple live marks: an accepted route at the earliest mark covers all later marks", async () => {
    const taskDir = await makeCompletedRun();
    try {
      await writeMark(taskDir, "segmentation", "mask leaked");
      await writeMark(taskDir, "measure", "thickness wrong");
      const { fn, calls } = stubRouter(outcomeOf(proposal("segmentation", "high")));

      const { phase, route } = await invalidateForSendBack(taskDir, protocolYaml, undefined, {
        router: fn,
      });
      assert.equal(phase, "segmentation");
      // The router saw both records and the earliest-mark bound.
      assert.deepEqual(
        calls[0]?.marks.map((m) => m.phase),
        ["segmentation", "measure"],
      );

      // Invalidation from the accepted phase covers every later marked phase.
      assert.ok(await exists(join(taskDir, "phases", "segmentation.attempt-1")));
      assert.ok(await exists(join(taskDir, "phases", "measure.attempt-1")));

      const record = await readRouteRecord(taskDir, route.route_id);
      assert.deepEqual(
        record.feedback_files.map((f) => f.path),
        ["review/verdict/segmentation.json", "review/verdict/measure.json"],
      );
      // BOTH original human records survive routing — each is consumed only
      // after its own phase re-passes its fresh gate.
      assert.ok(await exists(join(taskDir, "review", "verdict", "segmentation.json")));
      assert.ok(await exists(join(taskDir, "review", "verdict", "measure.json")));
    } finally {
      await rm(taskDir, { recursive: true, force: true });
    }
  });

  it("no live mark and no explicit phase: today's error, router never asked to invent work", async () => {
    const taskDir = await makeCompletedRun();
    try {
      const { fn, calls } = stubRouter(outcomeOf(proposal("intake", "high")));
      await assert.rejects(
        () => invalidateForSendBack(taskDir, protocolYaml, undefined, { router: fn }),
        /No phase to rerun/,
      );
      assert.equal(calls.length, 0);
      assert.equal(
        await exists(join(taskDir, "review", "routing")),
        false,
        "no routing record for a rejected request",
      );
    } finally {
      await rm(taskDir, { recursive: true, force: true });
    }
  });

  it("an unknown explicit override is rejected structurally before any record/mutation", async () => {
    const taskDir = await makeCompletedRun();
    try {
      await writeMark(taskDir, "segmentation", "x");
      await assert.rejects(
        () => invalidateForSendBack(taskDir, protocolYaml, "nope"),
        /has no phase "nope"/,
      );
      assert.equal(await exists(join(taskDir, "review", "routing")), false);
      assert.ok(await exists(join(taskDir, "phases", "segmentation")), "no mutation");
    } finally {
      await rm(taskDir, { recursive: true, force: true });
    }
  });

  it("without an agents.feedback-router profile no LLM runs — deterministic fallback recorded", async () => {
    const taskDir = await makeCompletedRun();
    try {
      await writeMark(taskDir, "segmentation", "x");
      // No opts.router and protocolYaml has no feedback-router profile.
      const { phase, route } = await invalidateForSendBack(taskDir, protocolYaml);
      assert.equal(phase, "segmentation");
      const record = await readRouteRecord(taskDir, route.route_id);
      assert.equal(record.source, "deterministic-fallback");
      assert.equal(record.model, null);
      assert.match(record.validation_errors.join(" "), /no feedback-router profile/);
    } finally {
      await rm(taskDir, { recursive: true, force: true });
    }
  });
});
