/**
 * Opaque pagination cursors for the read-only author tools
 * (review-provenance design §3C). A cursor is base64url-encoded JSON of a
 * small record of non-negative integers — opaque to the model, cheap to
 * validate, and never a filesystem path.
 */

export function encodeCursor(fields: Readonly<Record<string, number>>): string {
  return Buffer.from(JSON.stringify(fields), "utf8").toString("base64url");
}

/**
 * Decode a cursor produced by {@link encodeCursor}. Returns null on any
 * malformed input (invalid base64, non-object JSON, non-integer or negative
 * values) — callers surface that as a tool error, never throw.
 */
export function decodeCursor(
  cursor: string,
): Readonly<Record<string, number>> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      return null;
    }
    out[key] = value;
  }
  return out;
}
