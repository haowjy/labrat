import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "./index.js";

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "labrat-config-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("loadConfig", () => {
  it("built-in defaults when nothing is set", async () => {
    await withTmpDir(async (dir) => {
      const config = loadConfig({}, dir);
      assert.equal(config.defaultModel, "sonnet");
      assert.equal(config.defaultPermissionMode, "bypassPermissions");
      assert.equal(config.scienceHome, join(homedir(), ".claude-science"));
      assert.equal(config.microctSrc, null);
      assert.equal(config.defaultProtocol, null);
      assert.equal(config.dashboard.port, 4600);
      assert.equal(config.dashboard.url, "http://localhost:4600");
      assert.equal(config.dashboard.user, userInfo().username);
      assert.deepEqual(config.retries, {
        workerStall: 3,
        reviewAttempts: 2,
        phaseAttempts: 2,
      });
    });
  });

  it("labrat.config.json overlays defaults", async () => {
    await withTmpDir(async (dir) => {
      await writeFile(
        join(dir, "labrat.config.json"),
        JSON.stringify({
          defaultModel: "haiku",
          defaultProtocol: "toy-stats",
          dashboard: { port: 5100 },
        }),
      );
      const config = loadConfig({}, dir);
      assert.equal(config.defaultModel, "haiku");
      assert.equal(config.defaultProtocol, "toy-stats");
      assert.equal(config.dashboard.port, 5100);
      assert.equal(config.dashboard.url, "http://localhost:5100");
    });
  });

  it("env overrides the file", async () => {
    await withTmpDir(async (dir) => {
      await writeFile(
        join(dir, "labrat.config.json"),
        JSON.stringify({ defaultModel: "haiku" }),
      );
      const config = loadConfig({ LABRAT_MODEL: "sonnet" }, dir);
      assert.equal(config.defaultModel, "sonnet");
    });
  });

  it("url follows the resolved port when not explicitly set", async () => {
    await withTmpDir(async (dir) => {
      const config = loadConfig({ LABRAT_DASHBOARD_PORT: "7777" }, dir);
      assert.equal(config.dashboard.port, 7777);
      assert.equal(config.dashboard.url, "http://localhost:7777");
    });
  });

  it("explicit LABRAT_DASHBOARD_URL wins over the derived one", async () => {
    await withTmpDir(async (dir) => {
      const config = loadConfig(
        {
          LABRAT_DASHBOARD_PORT: "7777",
          LABRAT_DASHBOARD_URL: "https://dashboard.example.com",
        },
        dir,
      );
      assert.equal(config.dashboard.url, "https://dashboard.example.com");
    });
  });

  it("rejects an invalid defaultModel in the config file", async () => {
    await withTmpDir(async (dir) => {
      await writeFile(
        join(dir, "labrat.config.json"),
        JSON.stringify({ defaultModel: "not-a-real-model" }),
      );
      assert.throws(() => loadConfig({}, dir), /Invalid config file/);
    });
  });

  it("rejects malformed JSON with a clear error naming the file", async () => {
    await withTmpDir(async (dir) => {
      await writeFile(join(dir, "labrat.config.json"), "{ not json");
      assert.throws(() => loadConfig({}, dir), /Malformed JSON.*labrat\.config\.json/);
    });
  });

  it("legacy PORT env var is honored for the dashboard", async () => {
    await withTmpDir(async (dir) => {
      const config = loadConfig({ PORT: "9999" }, dir);
      assert.equal(config.dashboard.port, 9999);
      assert.equal(config.dashboard.url, "http://localhost:9999");
    });
  });

  it("rejects an unknown top-level key in the config file", async () => {
    await withTmpDir(async (dir) => {
      await writeFile(
        join(dir, "labrat.config.json"),
        JSON.stringify({ defualtModel: "sonnet" }),
      );
      assert.throws(
        () => loadConfig({}, dir),
        /Invalid config file.*unknown key\(s\): defualtModel/,
      );
    });
  });

  it("rejects an unknown key under dashboard", async () => {
    await withTmpDir(async (dir) => {
      await writeFile(
        join(dir, "labrat.config.json"),
        JSON.stringify({ dashboard: { poort: 5100 } }),
      );
      assert.throws(
        () => loadConfig({}, dir),
        /Invalid config file.*unknown key\(s\): poort/,
      );
    });
  });

  it("LABRAT_WORKER_STALL_RETRIES=0 falls back to the default (not 0)", async () => {
    await withTmpDir(async (dir) => {
      const config = loadConfig({ LABRAT_WORKER_STALL_RETRIES: "0" }, dir);
      assert.equal(config.retries.workerStall, 3);
    });
  });

  it("a negative retry count falls back to the default", async () => {
    await withTmpDir(async (dir) => {
      const config = loadConfig({ LABRAT_REVIEW_ATTEMPTS: "-1" }, dir);
      assert.equal(config.retries.reviewAttempts, 2);
    });
  });

  it("expands a leading ~ in microctSrc from the config file", async () => {
    await withTmpDir(async (dir) => {
      await writeFile(
        join(dir, "labrat.config.json"),
        JSON.stringify({ microctSrc: "~/foo/src" }),
      );
      const config = loadConfig({}, dir);
      assert.equal(config.microctSrc, join(homedir(), "foo/src"));
    });
  });

  it("watchRoots defaults to an empty map", async () => {
    await withTmpDir(async (dir) => {
      assert.deepEqual(loadConfig({}, dir).watchRoots, {});
    });
  });

  it("watchRoots from the config file, with ~ expanded per protocol", async () => {
    await withTmpDir(async (dir) => {
      await writeFile(
        join(dir, "labrat.config.json"),
        JSON.stringify({
          watchRoots: {
            "microct-oa-mouse-knee": "/abs/dropbox",
            "toy-stats": "~/toy-dropbox",
          },
        }),
      );
      const config = loadConfig({}, dir);
      assert.deepEqual(config.watchRoots, {
        "microct-oa-mouse-knee": "/abs/dropbox",
        "toy-stats": join(homedir(), "toy-dropbox"),
      });
    });
  });

  it("rejects a non-string watchRoot in the config file", async () => {
    await withTmpDir(async (dir) => {
      await writeFile(
        join(dir, "labrat.config.json"),
        JSON.stringify({ watchRoots: { p1: 42 } }),
      );
      assert.throws(() => loadConfig({}, dir), /watchRoots\.p1/);
    });
  });

  it("LABRAT_WATCH_ROOTS env (JSON) overrides the file", async () => {
    await withTmpDir(async (dir) => {
      await writeFile(
        join(dir, "labrat.config.json"),
        JSON.stringify({ watchRoots: { p1: "/from-file" } }),
      );
      const config = loadConfig(
        { LABRAT_WATCH_ROOTS: JSON.stringify({ p1: "/from-env" }) },
        dir,
      );
      assert.deepEqual(config.watchRoots, { p1: "/from-env" });
    });
  });

  it("a malformed LABRAT_WATCH_ROOTS is ignored (lenient env layer)", async () => {
    await withTmpDir(async (dir) => {
      await writeFile(
        join(dir, "labrat.config.json"),
        JSON.stringify({ watchRoots: { p1: "/from-file" } }),
      );
      const config = loadConfig({ LABRAT_WATCH_ROOTS: "not json" }, dir);
      assert.deepEqual(config.watchRoots, { p1: "/from-file" });
    });
  });
});
