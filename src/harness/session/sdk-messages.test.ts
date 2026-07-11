import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { extractBackgroundTasks } from "./sdk-messages.js";

// The function accepts SDKMessage but guards at runtime, so we test with
// partial objects cast through `unknown` — the function's runtime checks
// handle the shape, not the TS type.

describe("extractBackgroundTasks", () => {
  it("returns task list from a background_tasks_changed message", () => {
    const msg = {
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [
        { task_id: "t1", task_type: "bash", description: "python segmentation.py" },
        { task_id: "t2", task_type: "bash", description: "python landmarks.py" },
      ],
      uuid: "u1",
      session_id: "s1",
    } as unknown as SDKMessage;
    const result = extractBackgroundTasks(msg);
    assert.deepEqual(result, [
      { taskId: "t1", taskType: "bash", description: "python segmentation.py" },
      { taskId: "t2", taskType: "bash", description: "python landmarks.py" },
    ]);
  });

  it("returns empty array when tasks list is empty (all background work finished)", () => {
    const msg = {
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [],
      uuid: "u2",
      session_id: "s1",
    } as unknown as SDKMessage;
    const result = extractBackgroundTasks(msg);
    assert.deepEqual(result, []);
  });

  it("returns undefined for non-background messages", () => {
    assert.equal(
      extractBackgroundTasks({ type: "assistant" } as unknown as SDKMessage),
      undefined,
    );
    assert.equal(
      extractBackgroundTasks({
        type: "system",
        subtype: "task_notification",
      } as unknown as SDKMessage),
      undefined,
    );
    assert.equal(extractBackgroundTasks(null as unknown as SDKMessage), undefined);
    assert.equal(extractBackgroundTasks("string" as unknown as SDKMessage), undefined);
  });
});
