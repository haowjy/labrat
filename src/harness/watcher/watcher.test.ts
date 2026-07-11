import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { startWatcher, type WatcherHandle } from "./index.js";

const DEBOUNCE_MS = 300;
const POLL_MS = 25;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(10);
  }
}

async function withTmpDirs<T>(
  fn: (incomingDir: string, tasksRoot: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "labrat-watcher-"));
  try {
    return await fn(join(root, "incoming"), join(root, "tasks"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("startWatcher", () => {
  it("enqueues a multi-file series exactly once, only after it settles", async () => {
    await withTmpDirs(async (incomingDir, tasksRoot) => {
      const calls: Array<{ inputPath: string; protocol: string }> = [];
      let watcher: WatcherHandle | undefined;
      try {
        watcher = startWatcher({
          incomingDir,
          tasksRoot,
          defaultProtocol: "toy-stats",
          debounceMs: DEBOUNCE_MS,
          pollIntervalMs: POLL_MS,
          onEnqueue: async (inputPath, protocol) => {
            calls.push({ inputPath, protocol });
          },
        });

        // Simulate a slice-by-slice copy: files arrive across two ticks.
        const seriesDir = join(incomingDir, "OA9-2LK");
        await mkdir(seriesDir, { recursive: true });
        await writeFile(join(seriesDir, "slice-001.dcm"), "a".repeat(64));
        await sleep(POLL_MS * 4); // let the watcher observe the first file
        await writeFile(join(seriesDir, "slice-002.dcm"), "b".repeat(64));

        // Well past the poll interval but within the debounce window since
        // the last change: must NOT have fired yet.
        await sleep(DEBOUNCE_MS / 2);
        assert.equal(calls.length, 0, "fired before the drop settled");

        await waitFor(() => calls.length === 1);
        assert.equal(calls[0]?.inputPath, seriesDir);
        assert.equal(calls[0]?.protocol, "toy-stats");

        // Stays enqueued-once: no re-fire on subsequent polls.
        await sleep(DEBOUNCE_MS * 2);
        assert.equal(calls.length, 1, "same drop enqueued more than once");
      } finally {
        watcher?.stop();
      }
    });
  });

  it("dedups drops already ingested as task inputs (restart case)", async () => {
    await withTmpDirs(async (incomingDir, tasksRoot) => {
      // A prior run already ingested this drop: tasks/<id>/task.json
      // records input "input/OA9-2LK".
      const taskDir = join(tasksRoot, "task-2026-07-11-001");
      await mkdir(taskDir, { recursive: true });
      await writeFile(
        join(taskDir, "task.json"),
        JSON.stringify({ id: "task-2026-07-11-001", input: "input/OA9-2LK" }),
      );

      const seriesDir = join(incomingDir, "OA9-2LK");
      await mkdir(seriesDir, { recursive: true });
      await writeFile(join(seriesDir, "slice-001.dcm"), "a".repeat(64));

      const calls: string[] = [];
      let watcher: WatcherHandle | undefined;
      try {
        watcher = startWatcher({
          incomingDir,
          tasksRoot,
          defaultProtocol: "toy-stats",
          debounceMs: DEBOUNCE_MS,
          pollIntervalMs: POLL_MS,
          onEnqueue: async (inputPath) => {
            calls.push(inputPath);
          },
        });

        // Give the drop ample time to settle and (wrongly) fire.
        await sleep(DEBOUNCE_MS * 3);
        assert.deepEqual(calls, [], "re-enqueued an already-ingested drop");
      } finally {
        watcher?.stop();
      }
    });
  });
});
