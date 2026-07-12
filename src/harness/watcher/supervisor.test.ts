import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig } from "../../config/index.js";
import {
  readWatcherStatus,
  resolveControlFile,
  writeWatcherControl,
  WATCHER_LOCK_FILE,
} from "../../control/index.js";
import { claimDrop, createSupervisor, type EnqueueFn } from "./supervisor.js";

/** Project-root shaped tmp tree: tasks/ + control/ siblings + a watchRoot. */
async function withProjectRoot<T>(
  fn: (ctx: { root: string; tasksRoot: string; watchRoot: string }) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "labrat-supervisor-"));
  const tasksRoot = join(root, "tasks");
  const watchRoot = join(root, "dropbox");
  await mkdir(tasksRoot, { recursive: true });
  try {
    return await fn({ root, tasksRoot, watchRoot });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function testConfig(root: string): ReturnType<typeof loadConfig> {
  return { ...loadConfig({}, root), watchRoots: {} };
}

const PROTOCOL = "microct-oa-mouse-knee";

async function runningControl(tasksRoot: string, watchRoot: string): Promise<void> {
  await writeWatcherControl(tasksRoot, {
    desired: "running",
    protocols: { [PROTOCOL]: { watchRoot } },
  });
}

/** Drops (excluding failure-record sidecars) currently in a state dir. */
async function drops(watchRoot: string, state: string): Promise<string[]> {
  try {
    return (await readdir(join(watchRoot, state)))
      .filter((n) => !n.endsWith(".error.json"))
      .sort();
  } catch {
    return [];
  }
}

describe("claimDrop (atomic-rename claim)", () => {
  it("wins on an existing drop, loses (false) on ENOENT — the race outcome", async () => {
    await withProjectRoot(async ({ watchRoot }) => {
      await mkdir(join(watchRoot, "incoming"), { recursive: true });
      await mkdir(join(watchRoot, "in-progress"), { recursive: true });
      await writeFile(join(watchRoot, "incoming", "a.zip"), "z");

      const from = join(watchRoot, "incoming", "a.zip");
      const to = join(watchRoot, "in-progress", "a.zip");
      assert.equal(await claimDrop(from, to), true);
      assert.ok(existsSync(to));
      // Second claimant: the file is gone → ENOENT → lost race, no throw.
      assert.equal(await claimDrop(from, join(watchRoot, "in-progress", "a.zip.2")), false);
    });
  });
});

describe("reconcileOnce", () => {
  it("stopped/absent control → stopped heartbeat, incoming untouched", async () => {
    await withProjectRoot(async ({ root, tasksRoot, watchRoot }) => {
      const calls: string[] = [];
      const supervisor = createSupervisor({
        config: testConfig(root),
        tasksRoot,
        debounceMs: 0,
        enqueue: async (p) => {
          calls.push(p);
          return { taskId: "task-2026-07-11-001", state: "done" };
        },
      });

      const result = await supervisor.reconcileOnce();
      assert.equal(result.leaseHeld, true);
      assert.equal(result.skipped, false);
      assert.equal(result.status!.desired, "stopped");
      assert.equal(result.status!.state, "stopped");
      assert.deepEqual(result.status!.protocols, {});
      assert.equal(calls.length, 0);
      // Heartbeat landed on disk at control/watcher-status.json.
      const onDisk = await readWatcherStatus(tasksRoot);
      assert.ok(onDisk);
      assert.ok(onDisk.ok);
      assert.equal(onDisk.value.state, "stopped");
      assert.equal(onDisk.value.pid, process.pid);
      // No state dirs were created while stopped.
      assert.equal(existsSync(watchRoot), false);
    });
  });

  it("settle → claim → background run → done/: the full move-based flow", async () => {
    await withProjectRoot(async ({ root, tasksRoot, watchRoot }) => {
      await runningControl(tasksRoot, watchRoot);
      const calls: Array<{ path: string; protocol: string }> = [];
      const enqueue: EnqueueFn = async (path, protocol) => {
        calls.push({ path, protocol });
        return { taskId: "task-2026-07-11-002", state: "done" };
      };
      const supervisor = createSupervisor({
        config: testConfig(root),
        tasksRoot,
        debounceMs: 0,
        enqueue,
      });

      // Tick 1 creates the state dirs; drop lands after.
      await supervisor.reconcileOnce();
      await writeFile(join(watchRoot, "incoming", "OA6-1RK.zip"), "dicom bytes");

      // Tick 2 observes (pending); tick 3 settles + claims + launches.
      await supervisor.reconcileOnce();
      await supervisor.reconcileOnce();
      await supervisor.waitForIdle();
      // Tick 4 harvests the finished run into the heartbeat.
      const { status } = await supervisor.reconcileOnce();

      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.protocol, PROTOCOL);
      // Claimed under a unique stored name (R6): <claimTs>-<intakeId>-<name>.
      assert.match(calls[0]!.path, /in-progress\/\d+-[0-9a-f]{8}-OA6-1RK\.zip$/);
      const done = await drops(watchRoot, "done");
      assert.equal(done.length, 1);
      assert.match(done[0]!, /^\d+-[0-9a-f]{8}-OA6-1RK\.zip$/);
      assert.deepEqual(await drops(watchRoot, "incoming"), []);
      assert.deepEqual(await drops(watchRoot, "in-progress"), []);

      // Heartbeat shape (the status contract).
      assert.equal(status!.desired, "running");
      assert.equal(status!.state, "running");
      assert.equal(status!.pid, process.pid);
      assert.ok(Date.parse(status!.since));
      assert.ok(Date.parse(status!.lastHeartbeat));
      assert.equal(status!.activeDrop, null);
      assert.equal(status!.configError, null);
      const p = status!.protocols[PROTOCOL]!;
      assert.equal(p.watchRoot, watchRoot);
      assert.equal(p.error, null);
      assert.deepEqual(p.counts, { incoming: 0, inProgress: 0, done: 1, failed: 0 });
      // lastDrop keeps the ORIGINAL display name, with the taskId once known.
      assert.deepEqual(p.lastDrop, {
        name: "OA6-1RK.zip",
        state: "done",
        taskId: "task-2026-07-11-002",
        at: p.lastDrop!.at,
      });
    });
  });

  it("the control loop keeps ticking while a run is in flight (R4) and stop is graceful", async () => {
    await withProjectRoot(async ({ root, tasksRoot, watchRoot }) => {
      await runningControl(tasksRoot, watchRoot);
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const supervisor = createSupervisor({
        config: testConfig(root),
        tasksRoot,
        debounceMs: 0,
        enqueue: async () => {
          await gate; // a long protocol run
          return { taskId: "task-2026-07-11-003", state: "done" };
        },
      });

      await supervisor.reconcileOnce();
      await writeFile(join(watchRoot, "incoming", "slow.zip"), "z");
      await supervisor.reconcileOnce();
      const claimed = await supervisor.reconcileOnce(); // claims + launches

      // While the run blocks, the loop still heartbeats and shows the drop.
      assert.equal(claimed.status!.state, "running");
      assert.equal(claimed.status!.activeDrop!.name, "slow.zip");
      assert.equal(claimed.status!.activeDrop!.taskId, null);
      const during = await supervisor.reconcileOnce();
      assert.equal(during.status!.activeDrop!.name, "slow.zip");
      assert.equal(during.status!.protocols[PROTOCOL]!.counts.inProgress, 1);

      // A second drop is NOT claimed while the one slot is busy.
      await writeFile(join(watchRoot, "incoming", "queued.zip"), "z");
      await supervisor.reconcileOnce();
      await supervisor.reconcileOnce();
      assert.deepEqual(await drops(watchRoot, "incoming"), ["queued.zip"]);

      // Desired stopped mid-run → "stopping" (graceful), never a kill.
      await writeWatcherControl(tasksRoot, {
        desired: "stopped",
        protocols: { [PROTOCOL]: { watchRoot } },
      });
      const stopping = await supervisor.reconcileOnce();
      assert.equal(stopping.status!.state, "stopping");

      release();
      await supervisor.waitForIdle();
      const stopped = await supervisor.reconcileOnce();
      assert.equal(stopped.status!.state, "stopped");
      assert.equal(stopped.status!.activeDrop, null);
      assert.equal((await drops(watchRoot, "done")).length, 1);
      // The queued drop stays in incoming/ — stopped means no new claims.
      assert.deepEqual(await drops(watchRoot, "incoming"), ["queued.zip"]);
    });
  });

  it("a .complete sentinel dispatches immediately and is consumed on claim", async () => {
    await withProjectRoot(async ({ root, tasksRoot, watchRoot }) => {
      await runningControl(tasksRoot, watchRoot);
      const supervisor = createSupervisor({
        config: testConfig(root),
        tasksRoot,
        debounceMs: 60_000, // debounce alone would never elapse in this test
        enqueue: async () => ({ taskId: "task-2026-07-11-004", state: "done" }),
      });
      await supervisor.reconcileOnce();
      await writeFile(join(watchRoot, "incoming", "a.zip"), "z");
      await writeFile(join(watchRoot, "incoming", "a.zip.complete"), "");
      await supervisor.reconcileOnce();
      await supervisor.waitForIdle();
      await supervisor.reconcileOnce();
      assert.equal((await drops(watchRoot, "done")).length, 1);
      assert.equal(existsSync(join(watchRoot, "incoming", "a.zip.complete")), false);
    });
  });

  it("enqueue failure → failed/ move + structured .error.json record + surfaced log", async () => {
    await withProjectRoot(async ({ root, tasksRoot, watchRoot }) => {
      await runningControl(tasksRoot, watchRoot);
      const logged: string[] = [];
      const supervisor = createSupervisor({
        config: testConfig(root),
        tasksRoot,
        debounceMs: 0,
        log: (m) => logged.push(m),
        enqueue: async () => {
          throw new Error("worker exploded");
        },
      });
      await supervisor.reconcileOnce();
      await writeFile(join(watchRoot, "incoming", "bad.zip"), "z");
      await supervisor.reconcileOnce();
      await supervisor.reconcileOnce();
      await supervisor.waitForIdle();
      const { status } = await supervisor.reconcileOnce();

      const failed = await drops(watchRoot, "failed");
      assert.equal(failed.length, 1);
      assert.match(failed[0]!, /^\d+-[0-9a-f]{8}-bad\.zip$/);
      assert.ok(
        logged.some((m) => m.includes("FAILED") && m.includes("worker exploded")),
        `expected a surfaced failure in the log, got: ${JSON.stringify(logged)}`,
      );
      // R10: structured failure record next to the drop.
      const record = JSON.parse(
        await readFile(join(watchRoot, "failed", `${failed[0]}.error.json`), "utf8"),
      ) as Record<string, unknown>;
      assert.equal(record["protocol"], PROTOCOL);
      assert.equal(record["sourceName"], "bad.zip");
      assert.equal(record["error"], "worker exploded");
      assert.equal(record["taskId"], null);

      const p = status!.protocols[PROTOCOL]!;
      // The sidecar record is not a drop: failed counts exactly 1.
      assert.equal(p.counts.failed, 1);
      assert.deepEqual(p.lastDrop, {
        name: "bad.zip",
        state: "failed",
        taskId: null,
        at: p.lastDrop!.at,
      });
    });
  });

  it("a task that ran but ended failed also moves to failed/, keeping its taskId", async () => {
    await withProjectRoot(async ({ root, tasksRoot, watchRoot }) => {
      await runningControl(tasksRoot, watchRoot);
      const supervisor = createSupervisor({
        config: testConfig(root),
        tasksRoot,
        debounceMs: 0,
        enqueue: async () => ({ taskId: "task-2026-07-11-005", state: "failed" }),
      });
      await supervisor.reconcileOnce();
      await writeFile(join(watchRoot, "incoming", "a.zip"), "z");
      await supervisor.reconcileOnce();
      await supervisor.reconcileOnce();
      await supervisor.waitForIdle();
      const { status } = await supervisor.reconcileOnce();
      assert.equal((await drops(watchRoot, "failed")).length, 1);
      assert.equal(status!.protocols[PROTOCOL]!.lastDrop!.taskId, "task-2026-07-11-005");
    });
  });

  it("R1: pre-existing in-progress/ drops are QUARANTINED to failed/, never re-enqueued", async () => {
    await withProjectRoot(async ({ root, tasksRoot, watchRoot }) => {
      await runningControl(tasksRoot, watchRoot);
      await mkdir(join(watchRoot, "in-progress"), { recursive: true });
      await writeFile(join(watchRoot, "in-progress", "orphan.zip"), "z");

      const calls: string[] = [];
      const supervisor = createSupervisor({
        config: testConfig(root),
        tasksRoot,
        debounceMs: 0,
        enqueue: async (p) => {
          calls.push(p);
          return { taskId: "task-2026-07-11-006", state: "done" };
        },
      });
      const { status } = await supervisor.reconcileOnce();

      // Crash-after-claim recovery: quarantine, NOT a duplicate scientific run.
      assert.equal(calls.length, 0);
      const failed = await drops(watchRoot, "failed");
      assert.equal(failed.length, 1);
      assert.match(failed[0]!, /orphan\.zip$/);
      const record = JSON.parse(
        await readFile(join(watchRoot, "failed", `${failed[0]}.error.json`), "utf8"),
      ) as Record<string, unknown>;
      assert.equal(record["error"], "supervisor-restart; execution state unknown");
      assert.equal(status!.protocols[PROTOCOL]!.counts.failed, 1);
    });
  });

  it("R6: the same basename dropped twice lands as two distinct terminal names", async () => {
    await withProjectRoot(async ({ root, tasksRoot, watchRoot }) => {
      await runningControl(tasksRoot, watchRoot);
      const supervisor = createSupervisor({
        config: testConfig(root),
        tasksRoot,
        debounceMs: 0,
        enqueue: async () => ({ taskId: "task-2026-07-11-007", state: "done" }),
      });
      await supervisor.reconcileOnce();

      for (let i = 0; i < 2; i += 1) {
        await writeFile(join(watchRoot, "incoming", "a.zip"), `round ${i}`);
        await supervisor.reconcileOnce();
        await supervisor.reconcileOnce();
        await supervisor.waitForIdle();
        await supervisor.reconcileOnce();
      }

      const done = await drops(watchRoot, "done");
      assert.equal(done.length, 2);
      assert.notEqual(done[0], done[1]);
      for (const name of done) assert.match(name, /^\d+-[0-9a-f]{8}-a\.zip$/);
    });
  });

  it("R2: a second supervisor cannot act while the lease is held; stale leases are taken over", async () => {
    await withProjectRoot(async ({ root, tasksRoot, watchRoot }) => {
      await runningControl(tasksRoot, watchRoot);
      const a = createSupervisor({
        config: testConfig(root),
        tasksRoot,
        enqueue: async () => ({ taskId: "task-2026-07-11-008", state: "done" }),
      });
      const b = createSupervisor({
        config: testConfig(root),
        tasksRoot,
        enqueue: async () => ({ taskId: "task-2026-07-11-009", state: "done" }),
      });

      const first = await a.reconcileOnce();
      assert.equal(first.leaseHeld, true);
      const denied = await b.reconcileOnce();
      assert.equal(denied.leaseHeld, false);
      assert.equal(denied.status, null);

      // Stale takeover: age the lease past 5× poll interval.
      const lockFile = resolveControlFile(tasksRoot, WATCHER_LOCK_FILE)!;
      const lease = JSON.parse(await readFile(lockFile, "utf8")) as Record<string, unknown>;
      lease["heartbeat"] = new Date(Date.now() - 60_000).toISOString();
      await writeFile(lockFile, JSON.stringify(lease));
      const takeover = await b.reconcileOnce();
      assert.equal(takeover.leaseHeld, true);
    });
  });

  it("R2: overlapping reconcileOnce calls in one process — the second skips", async () => {
    await withProjectRoot(async ({ root, tasksRoot }) => {
      const supervisor = createSupervisor({
        config: testConfig(root),
        tasksRoot,
        enqueue: async () => ({ taskId: "task-2026-07-11-010", state: "done" }),
      });
      const [first, second] = await Promise.all([
        supervisor.reconcileOnce(),
        supervisor.reconcileOnce(),
      ]);
      assert.equal(first.skipped, false);
      assert.equal(second.skipped, true);
      assert.equal(second.status, null);
    });
  });

  it("R8: a symlinked state dir fails that protocol closed, isolated from siblings", async () => {
    await withProjectRoot(async ({ root, tasksRoot, watchRoot }) => {
      const goodRoot = join(root, "good-dropbox");
      await writeWatcherControl(tasksRoot, {
        desired: "running",
        protocols: {
          [PROTOCOL]: { watchRoot },
          "toy-stats": { watchRoot: goodRoot },
        },
      });
      // Sabotage: in-progress is a symlink to elsewhere (same device — this
      // exercises the real-dir check; a cross-device dir trips the sibling
      // device-id check in the same validator, R9).
      const elsewhere = join(root, "elsewhere");
      await mkdir(elsewhere, { recursive: true });
      await mkdir(watchRoot, { recursive: true });
      await symlink(elsewhere, join(watchRoot, "in-progress"));

      const calls: string[] = [];
      const supervisor = createSupervisor({
        config: testConfig(root),
        tasksRoot,
        debounceMs: 0,
        enqueue: async (p) => {
          calls.push(p);
          return { taskId: "task-2026-07-11-011", state: "done" };
        },
      });
      await supervisor.reconcileOnce();
      // A drop into the sabotaged protocol is never claimed.
      await mkdir(join(watchRoot, "incoming"), { recursive: true });
      await writeFile(join(watchRoot, "incoming", "a.zip"), "z");
      // The healthy sibling still works.
      await writeFile(join(goodRoot, "incoming", "b.zip"), "z");
      await supervisor.reconcileOnce();
      await supervisor.reconcileOnce();
      await supervisor.waitForIdle();
      const { status } = await supervisor.reconcileOnce();

      assert.match(status!.protocols[PROTOCOL]!.error!, /not a real directory/);
      assert.ok(existsSync(join(watchRoot, "incoming", "a.zip")));
      assert.equal(calls.length, 1);
      assert.match(calls[0]!, /b\.zip$/);
      assert.equal(status!.protocols["toy-stats"]!.error, null);
    });
  });

  it("config-seam watchRoots are the baseline; control protocols override (R5)", async () => {
    await withProjectRoot(async ({ root, tasksRoot, watchRoot }) => {
      const configRoot = join(root, "config-dropbox");
      const config = { ...loadConfig({}, root), watchRoots: { [PROTOCOL]: configRoot } };
      await writeWatcherControl(tasksRoot, { desired: "running", protocols: {} });

      const supervisor = createSupervisor({
        config,
        tasksRoot,
        debounceMs: 0,
        enqueue: async () => ({ taskId: "task-2026-07-11-012", state: "done" }),
      });
      let result = await supervisor.reconcileOnce();
      assert.equal(result.status!.protocols[PROTOCOL]!.watchRoot, configRoot);
      assert.ok(existsSync(join(configRoot, "incoming")));

      // Dashboard edit lands in control/watcher.json → overrides the seam.
      await runningControl(tasksRoot, watchRoot);
      result = await supervisor.reconcileOnce();
      assert.equal(result.status!.protocols[PROTOCOL]!.watchRoot, watchRoot);
    });
  });

  it("R11: a malformed control file fails closed — no claims, configError surfaced", async () => {
    await withProjectRoot(async ({ root, tasksRoot, watchRoot }) => {
      await mkdir(join(root, "control"), { recursive: true });
      await writeFile(join(root, "control", "watcher.json"), '{"desired":"sideways"}');
      // A settled drop is waiting — it must NOT be claimed.
      await mkdir(join(watchRoot, "incoming"), { recursive: true });
      await writeFile(join(watchRoot, "incoming", "a.zip"), "z");

      const calls: string[] = [];
      const supervisor = createSupervisor({
        config: { ...loadConfig({}, root), watchRoots: { [PROTOCOL]: watchRoot } },
        tasksRoot,
        debounceMs: 0,
        enqueue: async (p) => {
          calls.push(p);
          return { taskId: "task-2026-07-11-013", state: "done" };
        },
      });
      const { status } = await supervisor.reconcileOnce();
      await supervisor.reconcileOnce();

      assert.equal(status!.state, "stopped");
      assert.match(status!.configError!, /invalid/);
      assert.equal(calls.length, 0);
      assert.ok(existsSync(join(watchRoot, "incoming", "a.zip")));
    });
  });

  it("writes the heartbeat via atomic rename (no partial JSON on disk)", async () => {
    await withProjectRoot(async ({ root, tasksRoot }) => {
      const supervisor = createSupervisor({
        config: testConfig(root),
        tasksRoot,
        enqueue: async () => ({ taskId: "task-2026-07-11-014", state: "done" }),
      });
      await supervisor.reconcileOnce();
      const raw = await readFile(join(root, "control", "watcher-status.json"), "utf8");
      assert.doesNotThrow(() => JSON.parse(raw));
    });
  });
});

/** Poll until `cond` holds (10ms cadence) or fail loudly. */
async function waitFor(cond: () => Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

/** chmod-based sabotage is a no-op for root (e.g. some CI containers). */
const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe("review-hardening regressions (sol review p81)", () => {
  it("F3: a failed terminal move never publishes a terminal state", async () => {
    await withProjectRoot(async ({ root, tasksRoot, watchRoot }) => {
      await runningControl(tasksRoot, watchRoot);
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const supervisor = createSupervisor({
        config: testConfig(root),
        tasksRoot,
        debounceMs: 0,
        enqueue: async () => {
          await gate;
          return { taskId: "task-2026-07-11-020", state: "done" };
        },
      });
      await supervisor.reconcileOnce();
      await writeFile(join(watchRoot, "incoming", "slow.zip"), "z");
      await supervisor.reconcileOnce();
      await supervisor.reconcileOnce(); // claims + launches

      // Sabotage: the done/ dir vanishes while the run is in flight, so the
      // terminal rename must fail.
      await rm(join(watchRoot, "done"), { recursive: true, force: true });
      release();
      await supervisor.waitForIdle();
      const { status } = await supervisor.reconcileOnce();

      const p = status!.protocols[PROTOCOL]!;
      // Disk truth: the input is still in in-progress/, nothing in done/.
      const stranded = await drops(watchRoot, "in-progress");
      assert.equal(stranded.length, 1);
      assert.deepEqual(await drops(watchRoot, "done"), []);
      // Status must AGREE with disk: no terminal state published.
      assert.equal(p.lastDrop!.state, "in-progress");
      // Both the stranding and the run context are durably surfaced.
      assert.match(p.error!, /terminal move/);
      const sidecar = JSON.parse(
        await readFile(
          join(watchRoot, "in-progress", `${stranded[0]}.error.json`),
          "utf8",
        ),
      ) as Record<string, unknown>;
      assert.match(String(sidecar["error"]), /terminal move to done\/ failed/);
      assert.match(String(sidecar["error"]), /run outcome was done/);
      assert.equal(sidecar["taskId"], "task-2026-07-11-020");

      // The invariant error survives later healthy ticks (done/ gets
      // recreated by validation) — it clears only on restart quarantine.
      const later = await supervisor.reconcileOnce();
      assert.match(later.status!.protocols[PROTOCOL]!.error!, /terminal move/);
    });
  });

  it("F2: graceful shutdown keeps heartbeating and refreshing the lease until the run finishes", async () => {
    await withProjectRoot(async ({ root, tasksRoot, watchRoot }) => {
      await runningControl(tasksRoot, watchRoot);
      await mkdir(join(watchRoot, "incoming"), { recursive: true });
      await writeFile(join(watchRoot, "incoming", "long.zip"), "z");
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const supervisor = createSupervisor({
        config: testConfig(root),
        tasksRoot,
        debounceMs: 0,
        pollIntervalMs: 25,
        enqueue: async () => {
          await gate;
          return { taskId: "task-2026-07-11-021", state: "done" };
        },
      });
      const controller = new AbortController();
      const daemon = supervisor.run(controller.signal);
      await waitFor(async () => {
        const s = await readWatcherStatus(tasksRoot);
        return s !== null && s.ok && s.value.activeDrop !== null;
      }, "the drop to be claimed");

      controller.abort();
      await sleep(120);
      const s1 = await readWatcherStatus(tasksRoot);
      assert.ok(s1 !== null && s1.ok);
      // Mid-shutdown with an active run: stopping, NOT running/stopped.
      assert.equal(s1.value.state, "stopping");
      await sleep(100);
      const s2 = await readWatcherStatus(tasksRoot);
      assert.ok(s2 !== null && s2.ok);
      assert.ok(
        Date.parse(s2.value.lastHeartbeat) > Date.parse(s1.value.lastHeartbeat),
        "heartbeat must keep advancing during graceful shutdown",
      );
      // The lease is being refreshed too — a takeover would quarantine the
      // still-active input.
      const lockFile = resolveControlFile(tasksRoot, WATCHER_LOCK_FILE)!;
      const lease = JSON.parse(await readFile(lockFile, "utf8")) as Record<string, unknown>;
      assert.ok(
        Date.now() - Date.parse(String(lease["heartbeat"])) < 1000,
        "lease heartbeat must stay fresh during graceful shutdown",
      );

      release();
      await daemon;
      const final = await readWatcherStatus(tasksRoot);
      assert.ok(final !== null && final.ok);
      assert.equal(final.value.state, "stopped");
      assert.equal(existsSync(lockFile), false, "lease released after shutdown");
      assert.equal((await drops(watchRoot, "done")).length, 1);
    });
  });

  it("F2: a former holder never overwrites a successor's lease or status at shutdown", async () => {
    await withProjectRoot(async ({ root, tasksRoot, watchRoot }) => {
      await runningControl(tasksRoot, watchRoot);
      await mkdir(join(watchRoot, "incoming"), { recursive: true });
      await writeFile(join(watchRoot, "incoming", "long.zip"), "z");
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const supervisor = createSupervisor({
        config: testConfig(root),
        tasksRoot,
        debounceMs: 0,
        pollIntervalMs: 25,
        enqueue: async () => {
          await gate;
          return { taskId: "task-2026-07-11-022", state: "done" };
        },
      });
      const controller = new AbortController();
      const daemon = supervisor.run(controller.signal);
      await waitFor(async () => {
        const s = await readWatcherStatus(tasksRoot);
        return s !== null && s.ok && s.value.activeDrop !== null;
      }, "the drop to be claimed");
      controller.abort();
      await sleep(80);

      // A successor takes the lease mid-shutdown (fresh foreign holder).
      const lockFile = resolveControlFile(tasksRoot, WATCHER_LOCK_FILE)!;
      const successor = {
        uuid: "successor-uuid",
        pid: 99999,
        startedAt: new Date().toISOString(),
        heartbeat: new Date().toISOString(),
      };
      await writeFile(lockFile, JSON.stringify(successor));
      await sleep(80);
      release();
      await daemon;

      // The old daemon must not have deleted/overwritten the successor's
      // lease, nor published its own "stopped" over the successor's status.
      const lease = JSON.parse(await readFile(lockFile, "utf8")) as Record<string, unknown>;
      assert.equal(lease["uuid"], "successor-uuid");
      const final = await readWatcherStatus(tasksRoot);
      assert.ok(final !== null && final.ok);
      assert.notEqual(final.value.state, "stopped");
    });
  });

  it("F9: a malformed watcher.lock is recovered, never a permanent EEXIST", async () => {
    await withProjectRoot(async ({ root, tasksRoot }) => {
      await mkdir(join(root, "control"), { recursive: true });
      await writeFile(join(root, "control", "watcher.lock"), "{not json at all");
      const supervisor = createSupervisor({
        config: testConfig(root),
        tasksRoot,
        enqueue: async () => ({ taskId: "task-2026-07-11-023", state: "done" }),
      });
      const result = await supervisor.reconcileOnce();
      assert.equal(result.leaseHeld, true, "malformed lease must be recoverable");
      // The recovered lock is a valid lease again.
      const lease = JSON.parse(
        await readFile(join(root, "control", "watcher.lock"), "utf8"),
      ) as Record<string, unknown>;
      assert.equal(typeof lease["uuid"], "string");
      assert.equal(typeof lease["heartbeat"], "string");
    });
  });

  it("F9: a lease whose heartbeat does not parse counts as stale (takeover succeeds)", async () => {
    await withProjectRoot(async ({ root, tasksRoot }) => {
      await mkdir(join(root, "control"), { recursive: true });
      await writeFile(
        join(root, "control", "watcher.lock"),
        JSON.stringify({
          uuid: "someone-else",
          pid: 1,
          startedAt: "whenever",
          heartbeat: "not-a-date",
        }),
      );
      const supervisor = createSupervisor({
        config: testConfig(root),
        tasksRoot,
        enqueue: async () => ({ taskId: "task-2026-07-11-024", state: "done" }),
      });
      const result = await supervisor.reconcileOnce();
      assert.equal(result.leaseHeld, true);
    });
  });

  it(
    "F9: an unreadable control file fails closed WITH a configError, not a silent stopped",
    { skip: runningAsRoot },
    async () => {
      await withProjectRoot(async ({ root, tasksRoot, watchRoot }) => {
        await runningControl(tasksRoot, watchRoot);
        const controlFile = join(root, "control", "watcher.json");
        await chmod(controlFile, 0o000);
        try {
          const calls: string[] = [];
          const supervisor = createSupervisor({
            config: testConfig(root),
            tasksRoot,
            debounceMs: 0,
            enqueue: async (p) => {
              calls.push(p);
              return { taskId: "task-2026-07-11-025", state: "done" };
            },
          });
          const { status } = await supervisor.reconcileOnce();
          assert.equal(status!.state, "stopped");
          assert.match(status!.configError!, /unreadable/);
          assert.equal(calls.length, 0);
        } finally {
          await chmod(controlFile, 0o644);
        }
      });
    },
  );

  it(
    "F7: a readdir failure during startup quarantine surfaces and is retried, not latched",
    { skip: runningAsRoot },
    async () => {
      await withProjectRoot(async ({ root, tasksRoot, watchRoot }) => {
        await runningControl(tasksRoot, watchRoot);
        const inProgressDir = join(watchRoot, "in-progress");
        await mkdir(inProgressDir, { recursive: true });
        await writeFile(join(inProgressDir, "stranded.zip"), "z");
        await chmod(inProgressDir, 0o000);
        try {
          const supervisor = createSupervisor({
            config: testConfig(root),
            tasksRoot,
            debounceMs: 0,
            enqueue: async () => ({ taskId: "task-2026-07-11-026", state: "done" }),
          });
          // While unreadable: the protocol surfaces the failure instead of
          // silently marking the (unscanned) quarantine done.
          const blocked = await supervisor.reconcileOnce();
          assert.match(blocked.status!.protocols[PROTOCOL]!.error!, /permission denied|EACCES/i);

          await chmod(inProgressDir, 0o755);
          const recovered = await supervisor.reconcileOnce();
          // The stranded drop IS quarantined once the dir is readable again.
          const failed = await drops(watchRoot, "failed");
          assert.equal(failed.length, 1);
          assert.match(failed[0]!, /stranded\.zip$/);
          assert.deepEqual(await drops(watchRoot, "in-progress"), []);
          assert.equal(recovered.status!.protocols[PROTOCOL]!.error, null);
        } finally {
          await chmod(inProgressDir, 0o755).catch(() => {});
        }
      });
    },
  );

  it("F5: rollback of a changed claim uses a UNIQUE name — never clobbers a new arrival or its sentinel", async () => {
    // Dynamic import: keeps this file loadable against pre-fix builds where
    // the rollback primitive does not exist yet.
    const { returnToIncoming } = await import("./supervisor.js");
    await withProjectRoot(async ({ watchRoot }) => {
      const incomingDir = join(watchRoot, "incoming");
      const inProgressDir = join(watchRoot, "in-progress");
      await mkdir(incomingDir, { recursive: true });
      await mkdir(inProgressDir, { recursive: true });
      // A NEW same-basename arrival (and its sentinel) landed after the
      // original a.zip was claimed.
      await writeFile(join(incomingDir, "a.zip"), "new arrival");
      await writeFile(join(incomingDir, "a.zip.complete"), "");
      const storedName = "1752249600000-abcd1234-a.zip";
      await writeFile(join(inProgressDir, storedName), "claimed bytes");

      await returnToIncoming(join(inProgressDir, storedName), incomingDir, storedName);

      assert.equal(await readFile(join(incomingDir, "a.zip"), "utf8"), "new arrival");
      assert.ok(existsSync(join(incomingDir, "a.zip.complete")));
      assert.equal(await readFile(join(incomingDir, storedName), "utf8"), "claimed bytes");
    });
  });

  it("R8/F5: a drop with a NESTED symlink is never claimed, even with a sentinel", async () => {
    await withProjectRoot(async ({ root, tasksRoot, watchRoot }) => {
      await runningControl(tasksRoot, watchRoot);
      const calls: string[] = [];
      const supervisor = createSupervisor({
        config: testConfig(root),
        tasksRoot,
        debounceMs: 0,
        enqueue: async (p) => {
          calls.push(p);
          return { taskId: "task-2026-07-11-027", state: "done" };
        },
      });
      await supervisor.reconcileOnce();

      const outside = join(root, "outside");
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, "secrets.bin"), "outside bytes");
      const series = join(watchRoot, "incoming", "series");
      await mkdir(series, { recursive: true });
      await writeFile(join(series, "slice-001.dcm"), "d");
      await symlink(join(outside, "secrets.bin"), join(series, "sneaky-link"));
      await writeFile(join(watchRoot, "incoming", "series.complete"), "");

      await supervisor.reconcileOnce();
      await supervisor.reconcileOnce();
      await supervisor.reconcileOnce();
      await supervisor.waitForIdle();
      await supervisor.reconcileOnce();

      assert.equal(calls.length, 0, "a tainted drop must never reach the orchestrator");
      assert.ok(existsSync(series), "the tainted drop stays in incoming/ (fail closed)");
      assert.deepEqual(await drops(watchRoot, "in-progress"), []);
      assert.deepEqual(await drops(watchRoot, "done"), []);
    });
  });

  it("F6: relative watchRoots and roots overlapping harness trees fail that protocol closed", async () => {
    await withProjectRoot(async ({ root, tasksRoot }) => {
      const config = {
        ...loadConfig({}, root),
        scienceHome: join(root, "science-home"),
        watchRoots: {
          "relative-proto": "relative/dropbox",
          "overlap-tasks": tasksRoot,
          "overlap-control": join(root, "control", "nested"),
        },
      };
      await writeWatcherControl(tasksRoot, { desired: "running", protocols: {} });
      const supervisor = createSupervisor({
        config,
        tasksRoot,
        debounceMs: 0,
        enqueue: async () => ({ taskId: "task-2026-07-11-028", state: "done" }),
      });
      const { status } = await supervisor.reconcileOnce();

      assert.match(status!.protocols["relative-proto"]!.error!, /absolute/);
      assert.match(status!.protocols["overlap-tasks"]!.error!, /overlaps the tasks dir/);
      assert.match(status!.protocols["overlap-control"]!.error!, /overlaps the control dir/);
      // Fail closed means NO state dirs were created — especially not
      // cwd-anchored ones for the relative root.
      assert.equal(existsSync(join(process.cwd(), "relative")), false);
      assert.equal(existsSync(join(tasksRoot, "incoming")), false);
      assert.equal(existsSync(join(root, "control", "nested")), false);
    });
  });
});
