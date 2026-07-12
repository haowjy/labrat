import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ProtocolYaml } from "../../schema/index.js";
import { archiveAndResetPhase } from "../orchestrator/invalidation.js";
import { reviewerToolTargetsSessionLog } from "./review.js";
import {
  createSessionLogger,
  isSessionLogPath,
  parseSessionLog,
  sessionLogPath,
  type SessionMessageV1,
} from "./session-log.js";

async function makeTaskDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "labrat-session-log-"));
}

function assistantMessage(text: string): unknown {
  return {
    type: "assistant",
    session_id: "sess_abc",
    message: { content: [{ type: "text", text }] },
  };
}

describe("createSessionLogger — ordering across continuations", () => {
  it("appends two queries to the SAME file with ascending query and message ordinals", async () => {
    const taskDir = await makeTaskDir();
    try {
      const logger = createSessionLogger({
        taskDir,
        taskId: "t1",
        phase: "segmentation",
        attempt: 1,
        role: "worker",
        secrets: [],
      });

      // First query yields two messages; a stall-reminder continuation
      // (continue: true) yields two more — same file, higher query_ordinal.
      await logger.append(assistantMessage("q1 m1"), { queryOrdinal: 1 });
      await logger.append(assistantMessage("q1 m2"), { queryOrdinal: 1 });
      await logger.append(assistantMessage("q2 m1"), { queryOrdinal: 2 });
      await logger.append(assistantMessage("q2 m2"), { queryOrdinal: 2 });

      const path = sessionLogPath(taskDir, "segmentation", "worker");
      const { messages, truncatedFinalLine } = parseSessionLog(
        await readFile(path, "utf8"),
      );

      assert.equal(truncatedFinalLine, false);
      assert.equal(messages.length, 4);
      assert.deepEqual(
        messages.map((m) => [m.query_ordinal, m.message_ordinal]),
        [
          [1, 1],
          [1, 2],
          [2, 3],
          [2, 4],
        ],
      );
      for (const m of messages) {
        assert.equal(m.schema_version, 1);
        assert.equal(m.task_id, "t1");
        assert.equal(m.phase, "segmentation");
        assert.equal(m.phase_attempt, 1);
        assert.equal(m.role, "worker");
        assert.equal(m.session_id, "sess_abc");
      }
    } finally {
      await rm(taskDir, { recursive: true, force: true });
    }
  });

  it("preserves yield order under concurrent (unawaited-between) appends", async () => {
    const taskDir = await makeTaskDir();
    try {
      const logger = createSessionLogger({
        taskDir,
        taskId: "t1",
        phase: "intake",
        attempt: 1,
        role: "worker",
        secrets: [],
      });
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          logger.append(assistantMessage(`m${i}`), { queryOrdinal: 1 }),
        ),
      );
      const { messages } = parseSessionLog(
        await readFile(sessionLogPath(taskDir, "intake", "worker"), "utf8"),
      );
      assert.deepEqual(
        messages.map((m) => m.message_ordinal),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      );
    } finally {
      await rm(taskDir, { recursive: true, force: true });
    }
  });
});

describe("session logs survive phase archival", () => {
  const protocolYaml = {
    kind: "protocol",
    name: "test-protocol",
    version: 1,
    expects: { modality: "microct", species: "mouse" },
    agents: { worker: { model: "test" }, reviewer: { model: "test" } },
    phases: [{ id: "segmentation", skills: [], inputs: [], outputs: [] }],
  } as unknown as ProtocolYaml;

  it("archiveAndResetPhase moves the session file intact under <phase>.attempt-N/", async () => {
    const taskDir = await makeTaskDir();
    try {
      const logger = createSessionLogger({
        taskDir,
        taskId: "t1",
        phase: "segmentation",
        attempt: 1,
        role: "worker",
        secrets: [],
      });
      await logger.append(assistantMessage("attempt 1 work"), { queryOrdinal: 1 });

      const { attempt } = await archiveAndResetPhase(taskDir, protocolYaml, "segmentation");
      assert.equal(attempt, 1);

      const archived = join(
        taskDir,
        "phases",
        "segmentation.attempt-1",
        "sessions",
        "worker.jsonl",
      );
      const { messages } = parseSessionLog(await readFile(archived, "utf8"));
      assert.equal(messages.length, 1);
      assert.equal(messages[0]?.phase_attempt, 1);

      // The live path is gone — the next attempt starts a fresh file.
      await assert.rejects(stat(sessionLogPath(taskDir, "segmentation", "worker")));
    } finally {
      await rm(taskDir, { recursive: true, force: true });
    }
  });
});

describe("sanitization — secrets, hidden thinking, blobs", () => {
  it("redacts secret-keyed values, drops thinking blocks + signatures, redacts configured secret strings", async () => {
    const taskDir = await makeTaskDir();
    try {
      const logger = createSessionLogger({
        taskDir,
        taskId: "t1",
        phase: "intake",
        attempt: 2,
        role: "gate-reviewer",
        secrets: ["sk-live-hunter2"],
      });
      await logger.append(
        {
          type: "assistant",
          session_id: "sess_abc",
          message: {
            content: [
              { type: "thinking", thinking: "hidden reasoning", signature: "sig==" },
              { type: "text", text: "Ran curl with sk-live-hunter2 as the key" },
              {
                type: "tool_use",
                name: "Bash",
                input: { command: "echo hi", api_key: "sk-live-hunter2", Token: "abc" },
              },
            ],
          },
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        { queryOrdinal: 1 },
      );

      const raw = await readFile(sessionLogPath(taskDir, "intake", "gate-reviewer"), "utf8");
      assert.ok(!raw.includes("sk-live-hunter2"), "configured secret leaked");
      assert.ok(!raw.includes("hidden reasoning"), "thinking block leaked");
      assert.ok(!raw.includes("sig=="), "signature leaked");

      const { messages } = parseSessionLog(raw);
      const sdk = messages[0]?.sdk_message as {
        message: { content: readonly Record<string, unknown>[] };
        usage: unknown;
      };
      // Thinking block dropped entirely; text + tool_use retained.
      assert.equal(sdk.message.content.length, 2);
      assert.equal(sdk.message.content[0]?.["text"], "Ran curl with [REDACTED] as the key");
      const toolInput = sdk.message.content[1]?.["input"] as Record<string, unknown>;
      assert.equal(toolInput["command"], "echo hi");
      assert.equal(toolInput["api_key"], "[REDACTED]");
      assert.equal(toolInput["Token"], "[REDACTED]");
      assert.deepEqual(sdk.usage, { input_tokens: 10, output_tokens: 5 });
      assert.equal(messages[0]?.phase_attempt, 2);
    } finally {
      await rm(taskDir, { recursive: true, force: true });
    }
  });

  it("caps oversized strings with explicit truncation metadata", async () => {
    const taskDir = await makeTaskDir();
    try {
      const logger = createSessionLogger({
        taskDir,
        taskId: "t1",
        phase: "intake",
        attempt: 1,
        role: "worker",
        secrets: [],
      });
      const big = "A ".repeat(200 * 1024); // 400 KiB; spaces keep it out of the base64-blob heuristic
      await logger.append(assistantMessage(big), { queryOrdinal: 1 });

      const { messages } = parseSessionLog(
        await readFile(sessionLogPath(taskDir, "intake", "worker"), "utf8"),
      );
      const sdk = messages[0]?.sdk_message as {
        message: { content: readonly { text: unknown }[] };
      };
      const capped = sdk.message.content[0]?.text as {
        truncated: boolean;
        text: string;
        truncated_bytes: number;
        sha256: string;
      };
      assert.equal(capped.truncated, true);
      assert.equal(Buffer.byteLength(capped.text, "utf8"), 256 * 1024);
      assert.equal(capped.truncated_bytes, 400 * 1024 - 256 * 1024);
      assert.match(capped.sha256, /^[0-9a-f]{64}$/);
    } finally {
      await rm(taskDir, { recursive: true, force: true });
    }
  });
});

describe("parseSessionLog — crash tolerance", () => {
  const line = (n: number): string =>
    JSON.stringify({
      schema_version: 1,
      captured_at: "2026-07-12T00:00:00.000Z",
      task_id: "t1",
      phase: "intake",
      phase_attempt: 1,
      role: "worker",
      query_ordinal: 1,
      message_ordinal: n,
      session_id: null,
      sdk_message: {},
    } satisfies SessionMessageV1);

  it("tolerates a truncated (unterminated) final line", () => {
    const content = `${line(1)}\n${line(2)}\n${line(3).slice(0, 40)}`;
    const result = parseSessionLog(content);
    assert.equal(result.truncatedFinalLine, true);
    assert.equal(result.messages.length, 2);
  });

  it("rejects a malformed INTERIOR line with its 1-based line number", () => {
    const content = `${line(1)}\nnot json at all\n${line(3)}\n`;
    assert.throws(() => parseSessionLog(content), /line 2/);
  });
});

describe("reviewer independence guard — deny predicate", () => {
  it("rejects Read/Grep/Glob targeting session logs, live and archived", () => {
    assert.equal(
      reviewerToolTargetsSessionLog("Read", {
        file_path: "phases/x/sessions/worker.jsonl",
      }),
      true,
    );
    assert.equal(
      reviewerToolTargetsSessionLog("Grep", {
        path: "/tasks/t1/phases/segmentation.attempt-2/sessions",
      }),
      true,
    );
    assert.equal(
      reviewerToolTargetsSessionLog("Glob", { pattern: "phases/*/sessions/*.jsonl" }),
      true,
    );
  });

  it("allows normal artifact and phase-record paths", () => {
    assert.equal(
      reviewerToolTargetsSessionLog("Read", { file_path: "artifacts/labels.nii.gz" }),
      false,
    );
    assert.equal(
      reviewerToolTargetsSessionLog("Read", { file_path: "phases/x/record.json" }),
      false,
    );
    assert.equal(isSessionLogPath("review/verification/x/report.md"), false);
  });
});
