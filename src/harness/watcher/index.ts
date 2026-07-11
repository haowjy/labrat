import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Folder-watch settle detection: decide when a drop in `incoming/` has
 * STOPPED CHANGING and is safe to claim.
 *
 * Poll-based by design (not `fs.watch`): a micro-CT series lands as ~877
 * files copied in one at a time. `fs.watch` on Linux is non-recursive and
 * fires a burst of per-file events that still have to be coalesced into a
 * per-drop stability signal, so the natural implementation is "compute a
 * signature per drop on an interval and wait for it to stop moving".
 *
 * Completion protocol (contract R3): signature-debounce is BEST-EFFORT. The
 * preferred ingestion is producer-side atomicity — copy to a staging name,
 * then atomically rename the finished drop into `incoming/`. A producer may
 * also write a `<name>.complete` sentinel to mark a drop finished, which
 * settles it immediately. The debounce is the safety net for producers that
 * do neither; the supervisor additionally RE-SIGNATURES after claiming.
 *
 * This module is deliberately dumb: it detects settled drops and nothing
 * else. Claiming (atomic rename to `in-progress/`), dispatch, and status are
 * the supervisor's job — and DEDUP IS THE FILESYSTEM: once a drop is renamed
 * out of `incoming/` it stops being observed, so there is no in-memory
 * "handled" set to go stale across restarts (the recovered skeleton's
 * startup-only-dedup bug).
 */

/** Optional producer-written completion sentinel: `<drop-name>.complete`. */
export const COMPLETE_SENTINEL_SUFFIX = ".complete";

/** What "no change" means for a drop: the root's `dev:ino` identity plus
 * file count + total bytes + newest mtime, computed over the entry
 * (recursively for a slice directory). The dev:ino prefix means a REPLACED
 * root (same name, new inode) can never alias the old one's signature.
 * Uses `lstat` throughout — a symlink inside a drop is counted as the link
 * itself and NEVER followed, so a drop cannot pull an outside tree (or a
 * symlink loop) into the walk. */
export function signatureOf(path: string): string | null {
  let files = 0;
  let bytes = 0;
  let maxMtime = 0;
  const walk = (p: string): void => {
    const st = lstatSync(p);
    maxMtime = Math.max(maxMtime, st.mtimeMs);
    if (st.isDirectory()) {
      for (const entry of readdirSync(p)) walk(join(p, entry));
    } else {
      files += 1;
      bytes += st.size;
    }
  };
  try {
    const root = lstatSync(path);
    walk(path);
    return `${root.dev}:${root.ino}:${files}:${bytes}:${maxMtime}`;
  } catch {
    // Entry vanished or is mid-rename; treat as "no signature yet".
    return null;
  }
}

/** Type filter for `incoming/` entries (contract R8): only a REGULAR
 * `.zip`/`.dcm` file or a REAL directory (DICOM slice series). Symlinks,
 * sockets, FIFOs, and devices are never eligible (lstat + explicit type
 * check — `isFile()` is false for every non-regular file kind). */
export function isEligibleDrop(incomingDir: string, name: string): boolean {
  if (name.startsWith(".") || name.endsWith(COMPLETE_SENTINEL_SUFFIX)) return false;
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(join(incomingDir, name));
  } catch {
    return false;
  }
  if (st.isSymbolicLink()) return false;
  if (st.isDirectory()) return true;
  const lower = name.toLowerCase();
  return st.isFile() && (lower.endsWith(".zip") || lower.endsWith(".dcm"));
}

type PendingEntry = {
  signature: string;
  lastChangeAt: number;
};

export type SettledDrop = {
  readonly name: string;
  /** Signature at settle time — the supervisor re-signatures after the claim
   * and returns the drop to `incoming/` if it moved (contract R3). */
  readonly signature: string;
  /** True when a `<name>.complete` sentinel settled it. */
  readonly sentinel: boolean;
};

export type SettleTracker = {
  /** Poll `incomingDir` once. Returns the drops (name-sorted) whose signature
   * has been unchanged for at least `debounceMs`, or that carry a completion
   * sentinel. Settled names are forgotten — if the caller does not claim
   * them, the next poll simply re-detects them from disk. */
  readonly poll: (incomingDir: string) => SettledDrop[];
};

/**
 * One tracker per watched `incoming/` dir. Timestamps are captured FRESH per
 * observation (immediately after each entry's signature walk) — never once
 * per poll — so a slow walk over one large drop can neither age nor renew a
 * sibling's debounce window (the recovered skeleton's stale-clock bug).
 */
export function createSettleTracker(debounceMs = 3000): SettleTracker {
  const pending = new Map<string, PendingEntry>();

  return {
    poll(incomingDir: string): SettledDrop[] {
      let entries: string[];
      try {
        entries = readdirSync(incomingDir);
      } catch {
        return []; // incoming/ vanished; keep polling.
      }

      const names = new Set(entries);
      const settled: SettledDrop[] = [];
      const seen = new Set<string>();

      for (const name of entries.sort()) {
        if (!isEligibleDrop(incomingDir, name)) continue;
        seen.add(name);

        const signature = signatureOf(join(incomingDir, name));
        if (signature === null) continue;
        // Fresh timestamp per observation, AFTER the (possibly slow)
        // signature walk for this entry.
        const observedAt = Date.now();

        // Producer-declared completion beats the debounce (R3).
        if (names.has(`${name}${COMPLETE_SENTINEL_SUFFIX}`)) {
          pending.delete(name);
          settled.push({ name, signature, sentinel: true });
          continue;
        }

        const prior = pending.get(name);
        if (!prior || prior.signature !== signature) {
          pending.set(name, { signature, lastChangeAt: observedAt });
          continue;
        }
        if (observedAt - prior.lastChangeAt >= debounceMs) {
          pending.delete(name);
          settled.push({ name, signature, sentinel: false });
        }
      }

      // Forget pending entries that disappeared before settling.
      for (const name of pending.keys()) {
        if (!seen.has(name)) pending.delete(name);
      }

      return settled;
    },
  };
}
