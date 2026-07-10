/** Hand-rolled validation utilities — pure, no I/O. */

export type ValidationError = {
  readonly path: string;
  readonly message: string;
};

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly ValidationError[] };

export function success<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

export function failure<T>(
  errors: readonly ValidationError[],
): ValidationResult<T> {
  return { ok: false, errors };
}

export function singleError<T>(
  path: string,
  message: string,
): ValidationResult<T> {
  return failure([{ path, message }]);
}

export function mergeResults<T>(
  results: readonly ValidationResult<unknown>[],
): ValidationResult<T> {
  const errors: ValidationError[] = [];
  for (const r of results) {
    if (!r.ok) {
      errors.push(...r.errors);
    }
  }
  if (errors.length > 0) {
    return failure(errors);
  }
  return success(undefined as T);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function expectRecord(
  value: unknown,
  path: string,
): ValidationResult<Record<string, unknown>> {
  if (!isRecord(value)) {
    return singleError(path, "expected object");
  }
  return success(value);
}

export function expectString(
  value: unknown,
  path: string,
): ValidationResult<string> {
  if (typeof value !== "string") {
    return singleError(path, "expected string");
  }
  return success(value);
}

export function expectNonEmptyString(
  value: unknown,
  path: string,
): ValidationResult<string> {
  const s = expectString(value, path);
  if (!s.ok) return s;
  if (s.value.length === 0) {
    return singleError(path, "expected non-empty string");
  }
  return s;
}

export function expectNumber(
  value: unknown,
  path: string,
): ValidationResult<number> {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return singleError(path, "expected number");
  }
  return success(value);
}

export function expectBoolean(
  value: unknown,
  path: string,
): ValidationResult<boolean> {
  if (typeof value !== "boolean") {
    return singleError(path, "expected boolean");
  }
  return success(value);
}

export function expectArray(
  value: unknown,
  path: string,
): ValidationResult<unknown[]> {
  if (!Array.isArray(value)) {
    return singleError(path, "expected array");
  }
  return success(value);
}

export function expectEnum<const T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): ValidationResult<T> {
  const s = expectString(value, path);
  if (!s.ok) return s;
  if (!(allowed as readonly string[]).includes(s.value)) {
    return singleError(
      path,
      `expected one of: ${allowed.join(", ")}; got ${JSON.stringify(s.value)}`,
    );
  }
  return success(s.value as T);
}

export function expectOptional<T>(
  value: unknown,
  path: string,
  validator: (v: unknown, p: string) => ValidationResult<T>,
): ValidationResult<T | undefined> {
  if (value === undefined || value === null) {
    return success(undefined);
  }
  return validator(value, path);
}

export function expectStringArray(
  value: unknown,
  path: string,
): ValidationResult<string[]> {
  const arr = expectArray(value, path);
  if (!arr.ok) return arr;
  const out: string[] = [];
  for (let i = 0; i < arr.value.length; i++) {
    const item = expectString(arr.value[i], `${path}[${i}]`);
    if (!item.ok) return item;
    out.push(item.value);
  }
  return success(out);
}

export function expectStringMap(
  value: unknown,
  path: string,
): ValidationResult<Record<string, string>> {
  const rec = expectRecord(value, path);
  if (!rec.ok) return rec;
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(rec.value)) {
    const s = expectString(val, `${path}.${key}`);
    if (!s.ok) return s;
    out[key] = s.value;
  }
  return success(out);
}

/**
 * Matches `YYYY-MM-DDTHH:MM:SS[.sss](Z|+HH:MM|-HH:MM)` — the ISO 8601 subset
 * every writer in this codebase actually produces (`Date.prototype.toISOString()`,
 * or the same shape without milliseconds). `Date.parse` alone is too lenient
 * (e.g. it happily accepts bare `"2026"`), so this regex runs first.
 */
const ISO_DATE_TIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function expectIsoDateTime(
  value: unknown,
  path: string,
): ValidationResult<string> {
  const s = expectString(value, path);
  if (!s.ok) return s;
  if (!ISO_DATE_TIME_RE.test(s.value)) {
    return singleError(path, "expected ISO 8601 datetime string");
  }
  const t = Date.parse(s.value);
  if (Number.isNaN(t)) {
    return singleError(path, "expected ISO 8601 datetime string");
  }
  return s;
}
