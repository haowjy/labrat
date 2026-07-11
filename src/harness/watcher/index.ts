import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Folder-watcher front door: poll `incomingDir`, and when a NEW drop (a
 * directory of DICOM slices, or a single .zip/.dcm file) SETTLES — no file
 * count, byte count, or mtime change for `debounceMs` — route it to a
 * protocol and hand it to `onEnqueue`.
 *
 * Poll-based by design (not `fs.watch`): a micro-CT series lands as ~877
 * files copied in one at a time. `fs.watch` on Linux is non-recursive and
 * fires a burst of per-file events that still have to be coalesced into a
 * per-drop stability signal, so the natural implementation is "compute a
 * signature per drop on an interval and wait for it to stop moving" — the
 * poll IS the settle check, with no event plumbing that can drop or double
 * fire.
 */
export type WatcherConfig = {
  readonly incomingDir: string;
  /** Called once per settled drop, with the absolute drop path and the
   * routed protocol name. */
  readonly onEnqueue: (inputPath: string, protocol: string) => Promise<void>;
  /** Fallback when the router is unsure (low confidence) or unavailable. */
  readonly defaultProtocol?: string | null;
  /** Tasks root scanned for already-ingested drops (restart dedup).
   * Defaults to `<cwd>/tasks`, matching `enqueueAndRun`. */
  readonly tasksRoot?: string;
  /** Drop is settled after this long with no change. Default 3000ms. */
  readonly debounceMs?: number;
  /** Signature-poll interval. Default 500ms. */
  readonly pollIntervalMs?: number;
  readonly log?: (message: string) => void;
};

export type WatcherHandle = {
  readonly stop: () => void;
};

/** What "no change" means for a drop: file count + total bytes + newest
 * mtime, computed over the entry (recursively for a slice directory). */
type Signature = string;

type PendingEntry = {
  signature: Signature;
  lastChangeAt: number;
};

function signatureOf(path: string): Signature | null {
  let files = 0;
  let bytes = 0;
  let maxMtime = 0;
  const walk = (p: string): void => {
    const st = statSync(p);
    maxMtime = Math.max(maxMtime, st.mtimeMs);
    if (st.isDirectory()) {
      for (const entry of readdirSync(p)) walk(join(p, entry));
    } else {
      files += 1;
      bytes += st.size;
    }
  };
  try {
    walk(path);
  } catch {
    // Entry vanished or is mid-rename; treat as "no signature yet".
    return null;
  }
  return `${files}:${bytes}:${maxMtime}`;
}

/**
 * Names already ingested into the task tree: for each `tasks/<id>/task.json`,
 * the recorded `input` is `input/<name>` (zip drops record the unzipped
 * folder, i.e. the basename minus `.zip`). Returns the set of `<name>`s.
 */
function ingestedInputNames(tasksRoot: string): Set<string> {
  const names = new Set<string>();
  let taskIds: string[];
  try {
    taskIds = readdirSync(tasksRoot);
  } catch {
    return names;
  }
  for (const taskId of taskIds) {
    try {
      const raw = readFileSync(join(tasksRoot, taskId, "task.json"), "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object") {
        const input = (parsed as Record<string, unknown>)["input"];
        if (typeof input === "string" && input.startsWith("input/")) {
          names.add(input.slice("input/".length));
        }
      }
    } catch {
      // Not a task dir / unreadable task.json — ignore.
    }
  }
  return names;
}

/** The name a drop would be recorded under in task.json's `input`. */
function recordedNameOf(entryName: string): string {
  return entryName.toLowerCase().endsWith(".zip")
    ? entryName.slice(0, -".zip".length)
    : entryName;
}

export function startWatcher(config: WatcherConfig): WatcherHandle {
  const {
    incomingDir,
    onEnqueue,
    defaultProtocol = null,
    tasksRoot = join(process.cwd(), "tasks"),
    debounceMs = 3000,
    pollIntervalMs = 500,
    log = () => {},
  } = config;

  mkdirSync(incomingDir, { recursive: true });

  // Dedup: entry names we've fully dispatched (enqueued or skipped) this
  // process, seeded across restarts by what the task tree already ingested.
  const handled = new Set<string>();
  const ingested = ingestedInputNames(tasksRoot);
  const pending = new Map<string, PendingEntry>();
  let ticking = false;

  async function routeProtocol(inputPath: string): Promise<string | null> {
    try {
      // Deferred import keeps startWatcher cheap and avoids pulling the
      // inspector/router graph in until a drop actually settles.
      const { inspectInput } = await import("../inspector/index.js");
      const { selectProtocol } = await import("../router/index.js");
      const routed = await selectProtocol(await inspectInput(inputPath), []);
      if (routed.confidence !== "low") return routed.protocolName;
    } catch {
      // Router unavailable/unsure — fall through to the configured default.
    }
    return defaultProtocol;
  }

  async function dispatch(name: string, path: string): Promise<void> {
    // Mark handled before any async work so overlapping ticks can't
    // double-fire the same drop.
    handled.add(name);
    pending.delete(name);

    if (ingested.has(recordedNameOf(name))) {
      log(`skip ${path} (already ingested as a task input)`);
      return;
    }

    const protocol = await routeProtocol(path);
    if (!protocol) {
      log(
        `skip ${path}: router gave no protocol and no defaultProtocol is configured`,
      );
      return;
    }

    log(`settled ${path} → enqueue protocol=${protocol}`);
    ingested.add(recordedNameOf(name));
    try {
      await onEnqueue(path, protocol);
    } catch (err) {
      log(
        `enqueue failed for ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      let entries: string[];
      try {
        entries = readdirSync(incomingDir);
      } catch {
        return; // incomingDir vanished; keep polling.
      }
      const now = Date.now();
      const seen = new Set<string>();

      for (const name of entries) {
        if (name.startsWith(".") || handled.has(name)) continue;
        seen.add(name);
        const path = join(incomingDir, name);
        const signature = signatureOf(path);
        if (signature === null) continue;

        const prior = pending.get(name);
        if (!prior || prior.signature !== signature) {
          if (!prior) log(`detected drop ${path}`);
          pending.set(name, { signature, lastChangeAt: now });
          continue;
        }
        if (now - prior.lastChangeAt >= debounceMs) {
          await dispatch(name, path);
        }
      }

      // Forget pending entries that disappeared before settling.
      for (const name of pending.keys()) {
        if (!seen.has(name)) pending.delete(name);
      }
    } finally {
      ticking = false;
    }
  }

  const timer = setInterval(() => {
    void tick();
  }, pollIntervalMs);
  void tick();

  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
