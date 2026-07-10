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
});
