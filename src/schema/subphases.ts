import {
  expectArray,
  expectEnum,
  expectIsoDateTime,
  expectNonEmptyString,
  expectNumber,
  expectOptional,
  expectRecord,
  expectString,
  failure,
  type ValidationResult,
  success,
} from "./validation.js";

export const SUBPHASE_MARKS = ["pass", "fail", "human-review"] as const;
export type SubphaseMark = (typeof SUBPHASE_MARKS)[number];

export const SUBPHASE_CONFIDENCE = ["high", "medium", "low"] as const;
export type SubphaseConfidence = (typeof SUBPHASE_CONFIDENCE)[number];

/** Single append-only mark entry in phases/{phase}/subphases.json (design §11). */
export type SubphaseMarkEntry = {
  readonly subphase: string;
  readonly mark: SubphaseMark;
  readonly confidence?: SubphaseConfidence;
  readonly notes?: string;
  readonly attempt: number;
  readonly timestamp: string;
};

export type SubphasesJson = readonly SubphaseMarkEntry[];

const CLOSEABLE_MARKS: ReadonlySet<SubphaseMark> = new Set([
  "pass",
  "human-review",
]);

/** Latest mark determines closeable state (design §11). */
export function isCloseableMark(mark: SubphaseMark): boolean {
  return CLOSEABLE_MARKS.has(mark);
}

/** Returns the latest mark entry per subphase id (last in append order wins). */
export function latestMarksBySubphase(
  log: SubphasesJson,
): Map<string, SubphaseMarkEntry> {
  const map = new Map<string, SubphaseMarkEntry>();
  for (const entry of log) {
    map.set(entry.subphase, entry);
  }
  return map;
}

/** All declared subphases must have a closeable latest mark before record_phase. */
export function allSubphasesCloseable(
  declaredSubphaseIds: readonly string[],
  log: SubphasesJson,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  const latest = latestMarksBySubphase(log);
  for (const id of declaredSubphaseIds) {
    const entry = latest.get(id);
    if (!entry) {
      return { ok: false, reason: `subphase ${id} is unmarked` };
    }
    if (!isCloseableMark(entry.mark)) {
      return {
        ok: false,
        reason: `subphase ${id} latest mark is ${entry.mark}, not closeable`,
      };
    }
  }
  return { ok: true };
}

function validateMarkEntry(
  value: unknown,
  path: string,
): ValidationResult<SubphaseMarkEntry> {
  const rec = expectRecord(value, path);
  if (!rec.ok) return rec;

  const subphase = expectNonEmptyString(rec.value["subphase"], `${path}.subphase`);
  if (!subphase.ok) return subphase;

  const mark = expectEnum(rec.value["mark"], `${path}.mark`, SUBPHASE_MARKS);
  if (!mark.ok) return mark;

  const confidence = expectOptional(
    rec.value["confidence"],
    `${path}.confidence`,
    (v, p) => expectEnum(v, p, SUBPHASE_CONFIDENCE),
  );
  if (!confidence.ok) return confidence;

  const notes = expectOptional(rec.value["notes"], `${path}.notes`, (v, p) =>
    expectString(v, p),
  );
  if (!notes.ok) return notes;

  const attempt = expectNumber(rec.value["attempt"], `${path}.attempt`);
  if (!attempt.ok) return attempt;

  const timestamp = expectIsoDateTime(rec.value["timestamp"], `${path}.timestamp`);
  if (!timestamp.ok) return timestamp;

  if (
    (mark.value === "pass" || mark.value === "human-review") &&
    confidence.value === undefined
  ) {
    return failure([
      {
        path: `${path}.confidence`,
        message: `confidence required for mark ${mark.value}`,
      },
    ]);
  }

  return success({
    subphase: subphase.value,
    mark: mark.value,
    attempt: attempt.value,
    timestamp: timestamp.value,
    ...(confidence.value !== undefined ? { confidence: confidence.value } : {}),
    ...(notes.value !== undefined ? { notes: notes.value } : {}),
  });
}

export function validateSubphasesJson(
  value: unknown,
): ValidationResult<SubphasesJson> {
  const arr = expectArray(value, "$");
  if (!arr.ok) return arr;

  const out: SubphaseMarkEntry[] = [];
  for (let i = 0; i < arr.value.length; i++) {
    const entry = validateMarkEntry(arr.value[i], `$[${i}]`);
    if (!entry.ok) return entry;
    out.push(entry.value);
  }
  return success(out);
}

/** MCP mark_subphase tool input (without attempt/timestamp — harness adds those). */
export type MarkSubphaseInput = {
  readonly subphase: string;
  readonly mark: SubphaseMark;
  readonly confidence?: SubphaseConfidence;
  readonly notes?: string;
};

export function validateMarkSubphaseInput(
  value: unknown,
): ValidationResult<MarkSubphaseInput> {
  const rec = expectRecord(value, "$");
  if (!rec.ok) return rec;

  const subphase = expectNonEmptyString(rec.value["subphase"], "$.subphase");
  if (!subphase.ok) return subphase;

  const mark = expectEnum(rec.value["mark"], "$.mark", SUBPHASE_MARKS);
  if (!mark.ok) return mark;

  const confidence = expectOptional(
    rec.value["confidence"],
    "$.confidence",
    (v, p) => expectEnum(v, p, SUBPHASE_CONFIDENCE),
  );
  if (!confidence.ok) return confidence;

  const notes = expectOptional(rec.value["notes"], "$.notes", (v, p) =>
    expectString(v, p),
  );
  if (!notes.ok) return notes;

  if (
    (mark.value === "pass" || mark.value === "human-review") &&
    confidence.value === undefined
  ) {
    return failure([
      {
        path: "$.confidence",
        message: `confidence required for mark ${mark.value}`,
      },
    ]);
  }

  return success({
    subphase: subphase.value,
    mark: mark.value,
    ...(confidence.value !== undefined ? { confidence: confidence.value } : {}),
    ...(notes.value !== undefined ? { notes: notes.value } : {}),
  });
}
