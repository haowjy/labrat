import { randomBytes } from "node:crypto";

/**
 * Minimal RFC 9562 UUIDv7 generator for {@link PersistedSseEvent} ids
 * (review-provenance §3B). v7 encodes a 48-bit unix-ms timestamp in the high
 * bits, so ids are globally sortable (and lexicographically sortable in their
 * canonical string form) without a racy cross-process counter — exactly what
 * the SSE replay/dedup merge by `(emittedAt, id)` needs. A 12-bit in-process
 * monotonic counter in `rand_a` keeps same-millisecond ids ordered too.
 *
 * Deliberately hand-rolled: Node 24 ships no v7 and the alternative is a
 * whole dependency for 30 lines.
 */

let lastMs = 0;
let counter = 0;

export function uuidv7(): string {
  let ms = Date.now();
  if (ms <= lastMs) {
    counter += 1;
    if (counter > 0xfff) {
      // Counter exhausted within one ms — borrow the next ms (still ordered).
      counter = 0;
      lastMs += 1;
    }
    ms = lastMs;
  } else {
    lastMs = ms;
    counter = 0;
  }

  const bytes = randomBytes(16);
  // 48-bit big-endian unix-ms timestamp.
  bytes[0] = (ms / 2 ** 40) & 0xff;
  bytes[1] = (ms / 2 ** 32) & 0xff;
  bytes[2] = (ms / 2 ** 24) & 0xff;
  bytes[3] = (ms / 2 ** 16) & 0xff;
  bytes[4] = (ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;
  // Version 7 in the high nibble; monotonic counter fills rand_a.
  bytes[6] = 0x70 | ((counter >> 8) & 0x0f);
  bytes[7] = counter & 0xff;
  // RFC 4122/9562 variant (10xx).
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;

  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
