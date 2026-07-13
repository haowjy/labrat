import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { startManualRun, type StartManualRunDeps } from "./index.js";

// Unit tests for the POST /api/enqueue backing logic. Both seams are
// injected — protocol lookup and the detached spawn — so nothing here reads
// the real registry or launches a real run; the route-level rejection tests
// live in server.test.ts.

const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

/** A project root with a tasks/ dir and one real input file inside it. */
async function makeRoot(): Promise<{ root: string; tasksDir: string; input: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "labrat-enqueue-"));
  dirs.push(root);
  const tasksDir = path.join(root, "tasks");
  await mkdir(tasksDir, { recursive: true });
  await mkdir(path.join(root, "data"), { recursive: true });
  await writeFile(path.join(root, "data", "sample.zip"), "not-really-a-zip");
  return { root, tasksDir, input: "data/sample.zip" };
}

function fakeDeps(known: readonly string[]): {
  deps: StartManualRunDeps;
  launches: Parameters<StartManualRunDeps["launch"]>[0][];
} {
  const launches: Parameters<StartManualRunDeps["launch"]>[0][] = [];
  return {
    launches,
    deps: {
      listProtocols: async () => known,
      launch: (opts) => {
        launches.push(opts);
        return 4242;
      },
    },
  };
}

describe("startManualRun", () => {
  it("happy path: 202 shape, absolute input, log under control/, spawn args", async () => {
    const { root, tasksDir, input } = await makeRoot();
    const { deps, launches } = fakeDeps(["toy-stats"]);

    const result = await startManualRun({ tasksDir, scienceHome: "/x" }, { input, protocol: "toy-stats" }, deps);

    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.value.started, true);
    assert.equal(result.value.protocol, "toy-stats");
    assert.equal(result.value.input, path.join(root, "data", "sample.zip"));
    assert.equal(result.value.pid, 4242);
    assert.ok(result.value.log.startsWith(path.join(root, "control") + path.sep));

    assert.equal(launches.length, 1);
    assert.equal(launches[0]!.runRoot, root);
    assert.equal(launches[0]!.inputAbs, path.join(root, "data", "sample.zip"));
    assert.equal(launches[0]!.protocol, "toy-stats");
  });

  it("rejects a missing/blank input or protocol with 400 and never launches", async () => {
    const { tasksDir } = await makeRoot();
    const { deps, launches } = fakeDeps(["toy-stats"]);
    for (const body of [
      {},
      { input: "", protocol: "toy-stats" },
      { input: 42, protocol: "toy-stats" },
      { input: "data/sample.zip" },
      { input: "data/sample.zip", protocol: "   " },
      null,
      "a string body",
    ]) {
      const result = await startManualRun({ tasksDir, scienceHome: "/x" }, body, deps);
      assert.equal(result.ok, false, JSON.stringify(body));
      assert.equal(!result.ok && result.status, 400);
    }
    assert.equal(launches.length, 0);
  });

  it("rejects an unknown protocol, naming the known ones", async () => {
    const { tasksDir, input } = await makeRoot();
    const { deps, launches } = fakeDeps(["toy-stats", "microct-oa-mouse-knee"]);
    const result = await startManualRun(
      { tasksDir, scienceHome: "/x" },
      { input, protocol: "not-a-protocol" },
      deps,
    );
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.error : "", /not-a-protocol/);
    assert.match(!result.ok ? result.error : "", /toy-stats/);
    assert.equal(launches.length, 0);
  });

  it("rejects an input path that escapes the project root (traversal guard)", async () => {
    const { tasksDir } = await makeRoot();
    const { deps, launches } = fakeDeps(["toy-stats"]);
    for (const input of ["../outside.zip", "/etc/passwd", "data/../../x.zip"]) {
      const result = await startManualRun(
        { tasksDir, scienceHome: "/x" },
        { input, protocol: "toy-stats" },
        deps,
      );
      assert.equal(result.ok, false, input);
      assert.match(!result.ok ? result.error : "", /outside the project root/);
    }
    assert.equal(launches.length, 0);
  });

  it("rejects an input path that does not exist", async () => {
    const { tasksDir } = await makeRoot();
    const { deps, launches } = fakeDeps(["toy-stats"]);
    const result = await startManualRun(
      { tasksDir, scienceHome: "/x" },
      { input: "data/missing.zip", protocol: "toy-stats" },
      deps,
    );
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.error : "", /does not exist/);
    assert.equal(launches.length, 0);
  });
});
