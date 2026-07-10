import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildMonitorQueryOptions,
  classifyReviewerAudit,
  MONITOR_FORBIDDEN_TOOLS,
  scanVerificationEvidence,
  type MonitorSessionConfig,
  type VerificationEvidence,
} from "./monitor.js";
import { monitorOverridesGate } from "../orchestrator/gate.js";
import {
  createLabratToolServer,
  createOrchestratorSignals,
  type LabratToolContext,
} from "./signals.js";

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
  it("overrides a PASS only on the deterministic-floor rubber_stamp", () => {
    assert.equal(monitorOverridesGate("pass", "rubber_stamp"), true);
    assert.equal(monitorOverridesGate("pass-with-concerns", "rubber_stamp"), true);
  });
  it("does NOT override a PASS on advisory insufficient_evidence (F2)", () => {
    // insufficient_evidence is the model's judgement on an evidence-present
    // pass — advisory only, so a GENUINE phase is never failed by it.
    assert.equal(monitorOverridesGate("pass", "insufficient_evidence"), false);
    assert.equal(
      monitorOverridesGate("pass-with-concerns", "insufficient_evidence"),
      false,
    );
  });
  it("does not override an ok verdict", () => {
    assert.equal(monitorOverridesGate("pass", "ok"), false);
  });
  it("never overrides an already-failing reviewer decision", () => {
    assert.equal(monitorOverridesGate("fail", "rubber_stamp"), false);
    assert.equal(monitorOverridesGate("fail-upstream", "insufficient_evidence"), false);
  });
});

describe("buildMonitorQueryOptions — F8: read-only enforced by tool AVAILABILITY", () => {
  function sessionConfig(
    over: Partial<MonitorSessionConfig> = {},
  ): MonitorSessionConfig {
    return {
      taskId: "task-001",
      taskDir: "/tmp/does-not-need-to-exist-for-this-test",
      phaseId: "classify",
      gateDecision: "pass",
      reviewerDefaulted: false,
      model: "haiku",
      permissionMode: "bypassPermissions",
      ...over,
    };
  }

  function mcpServer() {
    const ctx: LabratToolContext = {
      taskId: "task-001",
      taskDir: "/tmp/does-not-need-to-exist-for-this-test",
      currentPhase: "classify",
      phaseOutputs: [],
      subphaseIds: [],
      signals: createOrchestratorSignals(),
    };
    return createLabratToolServer({ ctx, role: "monitor" });
  }

  // Regression contract for F8: `allowedTools` alone ONLY auto-approves — it
  // does NOT restrict which tools the model can see and call (SDK
  // AgentQueryOptions). Pre-fix, the monitor query set `allowedTools` but no
  // `tools`/`disallowedTools`, so Write/Edit/Bash were silently still
  // available. This test fails if that regresses: it inspects the actual
  // options object `runMonitorQuery` hands to the SDK, so it can't drift from
  // runtime behavior the way a config-shape-only assertion could.
  it("restricts the model's built-in tool set to Read/Grep/Glob — no Write/Edit/NotebookEdit/Bash", () => {
    const options = buildMonitorQueryOptions(sessionConfig(), mcpServer());

    // `tools` (not just `allowedTools`) must be set — this is the field that
    // actually restricts availability.
    assert.ok(Array.isArray(options.tools), "options.tools must be an explicit array, not the open 'claude_code' preset or undefined");
    for (const forbidden of MONITOR_FORBIDDEN_TOOLS) {
      assert.ok(
        !(options.tools as string[]).includes(forbidden),
        `options.tools must not include ${forbidden}`,
      );
    }
    assert.deepEqual([...(options.tools as string[])].sort(), ["Glob", "Grep", "Read"]);
  });

  // Regression contract: `tools` alone only removes BUILT-IN write tools. The
  // SDK still loads ambient .mcp.json / user-settings / plugin MCP servers
  // and filesystem hooks by default — none of which `tools` gates. Since the
  // monitor reads untrusted artifacts/ by design, an ambient writable/exec
  // MCP server (or a PostToolUse hook) is a residual write/exec path unless
  // the session is hermetically isolated.
  it("isolates the session from ambient MCP servers and settings/hooks (strictMcpConfig + settingSources: [])", () => {
    const options = buildMonitorQueryOptions(sessionConfig(), mcpServer());
    assert.equal(options.strictMcpConfig, true, "strictMcpConfig must be true — load ONLY the mcpServers passed here, no ambient .mcp.json/plugin servers");
    assert.deepEqual(options.settingSources, [], "settingSources must be [] — no filesystem settings/hooks from the deployment environment");
  });

  it("still allows the MCP submit_monitor_verdict tool through mcpServers, unaffected by the tools restriction", () => {
    const options = buildMonitorQueryOptions(sessionConfig(), mcpServer());
    assert.ok(options.mcpServers && "labrat" in options.mcpServers, "the labrat MCP server (carrying submit_monitor_verdict) must still be wired");
    assert.ok(
      (options.allowedTools ?? []).includes("mcp__labrat__submit_monitor_verdict"),
      "submit_monitor_verdict must be auto-approved so the monitor can still signal its verdict",
    );
  });

  it("works under bypassPermissions too — the real path when protocol.yaml declares no monitor agent (gate.ts fallback)", () => {
    const options = buildMonitorQueryOptions(
      sessionConfig({ permissionMode: "bypassPermissions" }),
      mcpServer(),
    );
    assert.equal(options.permissionMode, "bypassPermissions");
    assert.deepEqual([...(options.tools as string[])].sort(), ["Glob", "Grep", "Read"]);
  });
});
