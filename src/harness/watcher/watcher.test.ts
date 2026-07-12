import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createSettleTracker, isEligibleDrop, signatureOf } from "./index.js";

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "labrat-watcher-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function names(drops: ReadonlyArray<{ name: string }>): string[] {
  return drops.map((d) => d.name);
}

describe("settle detection (debounce)", () => {
  it("does not settle a drop until its signature holds for debounceMs", async () => {
    await withTmpDir(async (dir) => {
      const tracker = createSettleTracker(80);
      await writeFile(join(dir, "a.zip"), "bytes");

      // First observation registers the drop, never settles it.
      assert.deepEqual(tracker.poll(dir), []);
      // Immediately after: signature unchanged but debounce not elapsed.
      assert.deepEqual(tracker.poll(dir), []);

      await sleep(100);
      assert.deepEqual(names(tracker.poll(dir)), ["a.zip"]);
    });
  });

  it("a change mid-copy resets the debounce window", async () => {
    await withTmpDir(async (dir) => {
      const tracker = createSettleTracker(80);
      const series = join(dir, "series");
      await mkdir(series);
      await writeFile(join(series, "slice-001.dcm"), "one");

      assert.deepEqual(tracker.poll(dir), []);
      await sleep(100);
      // Another slice lands before the settle poll → new signature, reset.
      await writeFile(join(series, "slice-002.dcm"), "two");
      assert.deepEqual(tracker.poll(dir), []);
      // Still inside the fresh window.
      assert.deepEqual(tracker.poll(dir), []);
      await sleep(100);
      assert.deepEqual(names(tracker.poll(dir)), ["series"]);
    });
  });

  it("an unclaimed settled drop is re-detected on the next poll (filesystem is the dedup)", async () => {
    await withTmpDir(async (dir) => {
      const tracker = createSettleTracker(0);
      await writeFile(join(dir, "a.zip"), "bytes");
      tracker.poll(dir);
      assert.deepEqual(names(tracker.poll(dir)), ["a.zip"]);
      // Caller did not claim it — it must come back, not be remembered away.
      tracker.poll(dir);
      assert.deepEqual(names(tracker.poll(dir)), ["a.zip"]);
    });
  });

  it("a drop with a NESTED non-regular entry never settles, even with a sentinel (R8)", async () => {
    await withTmpDir(async (dir) => {
      const outside = join(dir, "outside");
      await mkdir(outside);
      await writeFile(join(outside, "target.bin"), "outside bytes");

      const incoming = join(dir, "incoming");
      await mkdir(incoming);
      const series = join(incoming, "series");
      await mkdir(series);
      await writeFile(join(series, "slice-001.dcm"), "d");
      await symlink(join(outside, "target.bin"), join(series, "sneaky-link"));
      // Even a producer-declared completion must not settle a tainted drop.
      await writeFile(join(incoming, "series.complete"), "");

      const tracker = createSettleTracker(0);
      tracker.poll(incoming);
      assert.deepEqual(tracker.poll(incoming), []);
      assert.deepEqual(tracker.poll(incoming), []);
    });
  });

  it("a <name>.complete sentinel settles the drop immediately (bypasses debounce)", async () => {
    await withTmpDir(async (dir) => {
      const tracker = createSettleTracker(60_000); // debounce would never elapse
      await writeFile(join(dir, "a.zip"), "bytes");
      await writeFile(join(dir, "a.zip.complete"), "");

      const settled = tracker.poll(dir);
      assert.deepEqual(names(settled), ["a.zip"]);
      assert.equal(settled[0]!.sentinel, true);
      // The sentinel file itself is never a drop.
      assert.equal(isEligibleDrop(dir, "a.zip.complete"), false);
    });
  });
});

describe("type filter + symlink handling", () => {
  it("accepts directories and .zip/.dcm files; rejects other files and dotfiles", async () => {
    await withTmpDir(async (dir) => {
      await mkdir(join(dir, "series"));
      await writeFile(join(dir, "scan.ZIP"), "z");
      await writeFile(join(dir, "slice.dcm"), "d");
      await writeFile(join(dir, "notes.txt"), "t");
      await writeFile(join(dir, ".hidden.zip"), "h");

      assert.equal(isEligibleDrop(dir, "series"), true);
      assert.equal(isEligibleDrop(dir, "scan.ZIP"), true);
      assert.equal(isEligibleDrop(dir, "slice.dcm"), true);
      assert.equal(isEligibleDrop(dir, "notes.txt"), false);
      assert.equal(isEligibleDrop(dir, ".hidden.zip"), false);
      assert.equal(isEligibleDrop(dir, "no-such-entry"), false);
    });
  });

  it("a symlinked entry is never eligible (lstat, not stat)", async () => {
    await withTmpDir(async (dir) => {
      const outside = join(dir, "outside");
      await mkdir(outside);
      await writeFile(join(outside, "big.dcm"), "payload");
      const incoming = join(dir, "incoming");
      await mkdir(incoming);
      await symlink(outside, join(incoming, "linked-series"));

      assert.equal(isEligibleDrop(incoming, "linked-series"), false);
      const tracker = createSettleTracker(0);
      tracker.poll(incoming);
      assert.deepEqual(tracker.poll(incoming), []);
    });
  });

  it("signatureOf does not follow symlinks inside a drop", async () => {
    await withTmpDir(async (dir) => {
      const outside = join(dir, "outside");
      await mkdir(outside);
      await writeFile(join(outside, "target.bin"), "original");

      const drop = join(dir, "drop");
      await mkdir(drop);
      await writeFile(join(drop, "slice.dcm"), "d");
      await symlink(join(outside, "target.bin"), join(drop, "link"));

      const before = signatureOf(drop);
      assert.ok(before);
      // The nested symlink is reported as a non-regular entry (R8).
      assert.equal(before.nonRegular, join(drop, "link"));
      // Growing the symlink TARGET must not change the drop's signature —
      // the walk counts the link itself, never the outside tree.
      await sleep(10);
      await writeFile(join(outside, "target.bin"), "original plus a lot more bytes");
      assert.equal(signatureOf(drop)!.signature, before.signature);
    });
  });

  it("signature carries the root's dev:ino — a replaced root never aliases the old one", async () => {
    await withTmpDir(async (dir) => {
      await writeFile(join(dir, "a.zip"), "same bytes");
      const first = signatureOf(join(dir, "a.zip"));
      assert.ok(first);
      assert.equal(first.nonRegular, null);
      // Replace with an identical-content file: new inode, new signature.
      await rm(join(dir, "a.zip"));
      await writeFile(join(dir, "a.zip"), "same bytes");
      const second = signatureOf(join(dir, "a.zip"));
      assert.ok(second);
      assert.notEqual(second.signature, first.signature);
    });
  });
});
