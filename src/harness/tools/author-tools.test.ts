/**
 * review-artifact-author read-only tools (design §3C):
 * - role scoping: the author gets EXACTLY read_past_history +
 *   view_human_feedback; worker/gate-reviewer/monitor get NEITHER;
 * - read_past_history: deterministic collapse, max_tokens pagination,
 *   expand cap + scope, no thinking/redacted content ever emitted;
 * - view_human_feedback: validated records only, malformed → errors;
 * - path traversal / out-of-scope phase inputs rejected;
 * - handlers are pure reads: no signals set, no files written.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createOrchestratorSignals, type LabratToolContext } from "./context.js";
import { handleReadPastHistory, handleViewHumanFeedback } from "./handlers.js";
import { allowedLabratTools } from "./server.js";
import type { SessionMessageV1, SessionRole } from "../session/session-log.js";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content.find((c) => c.type === "text");
  return block?.text ?? "";
}

function makeCtx(taskDir: string): LabratToolContext {
  return {
    taskId: "task-author-001",
    taskDir,
    currentPhase: "segmentation",
    phaseOutputs: [],
    subphaseIds: [],
    phaseOrder: ["intake", "segmentation", "postprocess"],
    signals: createOrchestratorSignals(),
  };
}

function sessionLine(
  phase: string,
  attempt: number,
  role: SessionRole,
  ordinal: number,
  sdkMessage: unknown,
): string {
  const line: SessionMessageV1 = {
    schema_version: 1,
    captured_at: `2026-07-01T00:0${ordinal}:00.000Z`,
    task_id: "task-author-001",
    phase,
    phase_attempt: attempt,
    role,
    query_ordinal: 1,
    message_ordinal: ordinal,
    session_id: "sess-abc",
    sdk_message: sdkMessage,
  };
  return `${JSON.stringify(line)}\n`;
}

async function writeFixture(taskDir: string): Promise<void> {
  // Live segmentation (attempt 2) — worker with tool calls + one message
  // carrying a hand-injected thinking block (a foreign writer scenario; the
  // real logger strips these before append).
  const segSessions = path.join(taskDir, "phases", "segmentation", "sessions");
  await mkdir(segSessions, { recursive: true });
  await writeFile(
    path.join(segSessions, "worker.jsonl"),
    sessionLine("segmentation", 2, "worker", 1, {
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "HIDDEN_REASONING_XYZZY" },
          { type: "text", text: "Segmenting the tibia volume now." },
          { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "run.py" } },
        ],
      },
    }) +
      sessionLine("segmentation", 2, "worker", 2, {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tu_1", is_error: true, content: "script failed" },
          ],
        },
      }) +
      sessionLine("segmentation", 2, "worker", 3, {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: `Fixed the threshold. ${"long tail ".repeat(80)}END-MARKER` },
          ],
        },
      }),
  );
  await writeFile(
    path.join(segSessions, "gate-reviewer.jsonl"),
    sessionLine("segmentation", 2, "gate-reviewer", 1, {
      type: "assistant",
      message: { content: [{ type: "text", text: "Verified labels against reference." }] },
    }),
  );
  await writeFile(
    path.join(taskDir, "phases", "segmentation", "summary.md"),
    "# Segmentation\nTibia labels produced with dice 0.94.\n",
  );

  // Archived segmentation attempt 1.
  const segArch = path.join(taskDir, "phases", "segmentation.attempt-1", "sessions");
  await mkdir(segArch, { recursive: true });
  await writeFile(
    path.join(segArch, "worker.jsonl"),
    sessionLine("segmentation", 1, "worker", 1, {
      type: "assistant",
      message: { content: [{ type: "text", text: "First attempt output." }] },
    }),
  );

  // Upstream intake (visible) and downstream postprocess (NOT visible).
  for (const phase of ["intake", "postprocess"]) {
    const dir = path.join(taskDir, "phases", phase, "sessions");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "worker.jsonl"),
      sessionLine(phase, 1, "worker", 1, {
        type: "assistant",
        message: { content: [{ type: "text", text: `${phase} work done.` }] },
      }),
    );
  }

  // Gate records: live pass for segmentation, archived fail for attempt 1.
  const gates = path.join(taskDir, "review", "gates");
  await mkdir(gates, { recursive: true });
  await writeFile(
    path.join(gates, "segmentation.json"),
    JSON.stringify({ phase: "segmentation", decision: "pass", summary: "Labels verified." }),
  );
  await writeFile(
    path.join(gates, "segmentation.attempt-1.json"),
    JSON.stringify({ phase: "segmentation", decision: "fail" }),
  );

  // Human verdicts: valid live intake, archived intake, malformed
  // segmentation, and a downstream postprocess record that must stay hidden.
  const verdicts = path.join(taskDir, "review", "verdict");
  await mkdir(verdicts, { recursive: true });
  const validVerdict = (phase: string, notes: string) =>
    JSON.stringify({
      phase,
      human_verdict: "changes_requested",
      corrected: false,
      notes,
      adjustments: [],
      agent_confidence: null,
      agent_gate_decision: "pass",
      agent_gate_feedback: null,
      reviewed_at: "2026-07-01T12:00:00.000Z",
    });
  await writeFile(path.join(verdicts, "intake.json"), validVerdict("intake", "Fix the crop box."));
  await writeFile(
    path.join(verdicts, "intake.attempt-1.json"),
    validVerdict("intake", "Older consumed note."),
  );
  await writeFile(
    path.join(verdicts, "segmentation.json"),
    JSON.stringify({ phase: "segmentation", human_verdict: "sabotage-me" }),
  );
  await writeFile(
    path.join(verdicts, "postprocess.json"),
    validVerdict("postprocess", "Downstream note that must stay hidden."),
  );
}

async function snapshotTree(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      out.push(path.relative(dir, full));
      if (entry.isDirectory()) {
        await walk(full);
      }
    }
  };
  await walk(dir);
  return out.sort();
}

async function main(): Promise<void> {
  const taskDir = await mkdtemp(path.join(tmpdir(), "labrat-author-tools-"));
  try {
    await writeFixture(taskDir);
    const ctx = makeCtx(taskDir);
    const treeBefore = await snapshotTree(taskDir);

    // ---- Role scoping: double enforcement via allowlist -------------------
    const authorAllowed = allowedLabratTools("review-artifact-author", []);
    assert.deepEqual(authorAllowed, [
      "mcp__labrat__read_past_history",
      "mcp__labrat__view_human_feedback",
    ]);
    for (const role of ["worker", "gate-reviewer", "monitor"] as const) {
      const allowed = allowedLabratTools(role, ["sub-a"]);
      assert.ok(
        !allowed.some((t) => t.includes("read_past_history") || t.includes("view_human_feedback")),
        `${role} must not receive author tools; got ${allowed.join(", ")}`,
      );
    }
    console.log("OK author allowlist is exactly the two read tools; other roles get neither");

    // ---- read_past_history: default scope + deterministic collapse --------
    let result = await handleReadPastHistory(ctx, {});
    assert.notEqual(result.isError, true, textOf(result));
    const view = JSON.parse(textOf(result)) as {
      schema_version: number;
      sessions: Array<{
        phase: string;
        attempt: number;
        role: string;
        outcome: string | null;
        assistant_summary: string;
        message_count: number;
        tool_calls: Array<{ name: string; count: number; error_count: number }>;
        messages: Array<{ id: string; kind: string; excerpt: string }>;
      }>;
      expanded: unknown[];
      next_cursor: string | null;
      truncated: boolean;
    };
    assert.equal(view.schema_version, 1);
    const phases = view.sessions.map((s) => `${s.phase}:${s.attempt}:${s.role}`);
    assert.deepEqual(phases, [
      "intake:1:worker",
      "segmentation:1:worker",
      "segmentation:2:worker",
      "segmentation:2:gate-reviewer",
    ]);
    assert.ok(!phases.some((p) => p.startsWith("postprocess")), "downstream phase leaked");
    console.log("OK collapse lists visible phases only, archived attempt before live");

    const segWorker = view.sessions.find((s) => s.phase === "segmentation" && s.attempt === 2 && s.role === "worker");
    assert.ok(segWorker);
    assert.equal(segWorker.outcome, "pass");
    assert.match(segWorker.assistant_summary, /summary\.md: # Segmentation Tibia labels/);
    assert.match(segWorker.assistant_summary, /gate: pass — Labels verified\./);
    assert.match(segWorker.assistant_summary, /messages: assistant=2 user=1/);
    assert.deepEqual(segWorker.tool_calls, [{ name: "Bash", count: 1, error_count: 1 }]);
    assert.equal(segWorker.message_count, 3);
    // Long assistant text is clipped to first/last 240 visible chars.
    const long = segWorker.messages.find((m) => m.id === "segmentation:2:worker:3");
    assert.ok(long);
    assert.match(long.excerpt, / … /);
    assert.match(long.excerpt, /END-MARKER$/);
    assert.ok(long.excerpt.length <= 490);
    // Archived attempt shows its own archived gate outcome.
    const segArch = view.sessions.find((s) => s.phase === "segmentation" && s.attempt === 1);
    assert.equal(segArch?.outcome, "fail");
    console.log("OK deterministic collapse: summary.md + gate headline + counts + tool status");

    // Thinking content never appears anywhere in the collapsed view.
    assert.ok(!textOf(result).includes("HIDDEN_REASONING_XYZZY"), "thinking leaked into collapse");

    // Determinism: identical input → byte-identical output.
    const again = await handleReadPastHistory(ctx, {});
    assert.equal(textOf(again), textOf(result));
    console.log("OK collapse is deterministic and never emits thinking");

    // ---- read_past_history: expand -----------------------------------------
    result = await handleReadPastHistory(ctx, { expand: ["segmentation:2:worker:1"] });
    const expandedView = JSON.parse(textOf(result)) as {
      expanded: Array<{ id: string; content: Record<string, unknown> }>;
    };
    assert.equal(expandedView.expanded.length, 1);
    const expandedText = JSON.stringify(expandedView.expanded);
    assert.match(expandedText, /Segmenting the tibia volume now\./);
    assert.ok(!expandedText.includes("HIDDEN_REASONING_XYZZY"), "thinking leaked through expand");
    console.log("OK expand returns sanitized stored content, thinking stripped");

    // Expand cap: 13 IDs rejected.
    const manyIds = Array.from({ length: 13 }, (_, i) => `segmentation:2:worker:${i + 1}`);
    result = await handleReadPastHistory(ctx, { expand: manyIds });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /at most 12 message IDs/);
    // Expand outside the visible scope rejected.
    result = await handleReadPastHistory(ctx, { expand: ["postprocess:1:worker:1"] });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /outside the author-visible scope/);
    console.log("OK expand cap (12) and phase-scope enforcement");

    // ---- read_past_history: max_tokens pagination --------------------------
    result = await handleReadPastHistory(ctx, { max_tokens: 500 });
    let page = JSON.parse(textOf(result)) as {
      sessions: Array<{ messages: Array<{ id: string }> }>;
      next_cursor: string | null;
      truncated: boolean;
    };
    assert.equal(page.truncated, true);
    assert.ok(page.next_cursor);
    assert.ok(textOf(result).length <= 500 * 4 * 1.25, "page grossly exceeds token budget");
    const seen = new Set<string>();
    let cursor: string | null = page.next_cursor;
    for (const s of page.sessions) for (const m of s.messages) seen.add(m.id);
    let hops = 0;
    while (cursor !== null) {
      assert.ok(++hops < 20, "pagination did not terminate");
      const next = await handleReadPastHistory(ctx, { max_tokens: 500, cursor });
      assert.notEqual(next.isError, true, textOf(next));
      page = JSON.parse(textOf(next)) as typeof page;
      for (const s of page.sessions) for (const m of s.messages) seen.add(m.id);
      cursor = page.next_cursor;
    }
    assert.equal(seen.size, 6, `expected all 6 messages across pages, saw ${seen.size}`);
    console.log("OK max_tokens truncates with a cursor; pages cover every message exactly");

    // Invalid inputs: bad cursor, out-of-range budget, traversal phase.
    result = await handleReadPastHistory(ctx, { cursor: "!!not-a-cursor!!" });
    assert.equal(result.isError, true);
    result = await handleReadPastHistory(ctx, { max_tokens: 100 });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /500\.\.6000/);
    result = await handleReadPastHistory(ctx, { phase: "../../../etc" });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /not in the author-visible scope/);
    result = await handleReadPastHistory(ctx, { phase: "postprocess" });
    assert.equal(result.isError, true);
    console.log("OK rejects bad cursor, out-of-range max_tokens, traversal + downstream phase");

    // ---- view_human_feedback ----------------------------------------------
    result = await handleViewHumanFeedback(ctx, {});
    assert.notEqual(result.isError, true, textOf(result));
    const fb = JSON.parse(textOf(result)) as {
      schema_version: number;
      feedback: Array<{
        phase: string;
        status: string;
        verdict: string;
        notes: string;
        source_path: string;
        reviewed_at: string;
      }>;
      errors: Array<{ source_path: string; error: string }>;
    };
    assert.equal(fb.schema_version, 1);
    assert.deepEqual(
      fb.feedback.map((f) => [f.phase, f.status]),
      [["intake", "live"]],
    );
    assert.equal(fb.feedback[0]?.verdict, "changes_requested");
    assert.equal(fb.feedback[0]?.notes, "Fix the crop box.");
    // The malformed segmentation record is an error, never prompt text.
    assert.equal(fb.errors.length, 1);
    assert.equal(fb.errors[0]?.source_path, "review/verdict/segmentation.json");
    assert.ok(!textOf(result).includes("sabotage-me"), "malformed verdict passed through");
    assert.ok(
      !textOf(result).includes("Downstream note"),
      "downstream feedback leaked into default scope",
    );
    console.log("OK feedback: validated records only, malformed → errors, downstream hidden");

    // include_archived pulls the consumed attempt record too, archived first.
    result = await handleViewHumanFeedback(ctx, { include_archived: true });
    const fbArch = JSON.parse(textOf(result)) as typeof fb;
    assert.deepEqual(
      fbArch.feedback.map((f) => [f.phase, f.status]),
      [
        ["intake", "archived"],
        ["intake", "live"],
      ],
    );
    console.log("OK feedback include_archived lists archived attempts before live");

    // Out-of-scope phase rejected.
    result = await handleViewHumanFeedback(ctx, { phase: "postprocess" });
    assert.equal(result.isError, true);
    result = await handleViewHumanFeedback(ctx, { phase: "../secrets" });
    assert.equal(result.isError, true);
    console.log("OK feedback rejects downstream + traversal phase input");

    // ---- Purity: no signals set, no files written --------------------------
    assert.equal(ctx.signals.phaseComplete, false);
    assert.equal(ctx.signals.blockedReason, null);
    assert.equal(ctx.signals.gateDecision, null);
    assert.equal(ctx.signals.monitorVerdict, null);
    assert.deepEqual(await snapshotTree(taskDir), treeBefore);
    console.log("OK handlers are pure reads: signals untouched, task tree unchanged");

    console.log("\nAll review-artifact-author tool tests passed.");
  } finally {
    await rm(taskDir, { recursive: true, force: true });
  }
}

await main();
