import {
  expectEnum,
  expectRecord,
  type ValidationResult,
  success,
} from "./validation.js";

export const MONITOR_VERDICTS = [
  "ok",
  "rubber_stamp",
  "insufficient_evidence",
] as const;

export type MonitorVerdict = (typeof MONITOR_VERDICTS)[number];

/**
 * submit_monitor_verdict MCP tool input (Lane D2). The independent monitor
 * SIGNALS its verdict through this tool — it never writes review/monitor/
 * itself. The harness reconciles this model verdict with the deterministic
 * floor and writes the authoritative review/monitor/{phase}.json.
 */
export type SubmitMonitorVerdictInput = {
  readonly verdict: MonitorVerdict;
  readonly reasons: readonly string[];
};

export function validateSubmitMonitorVerdictInput(
  value: unknown,
): ValidationResult<SubmitMonitorVerdictInput> {
  const rec = expectRecord(value, "$");
  if (!rec.ok) return rec;

  const verdict = expectEnum(rec.value["verdict"], "$.verdict", MONITOR_VERDICTS);
  if (!verdict.ok) return verdict;

  const rawReasons = rec.value["reasons"];
  let reasons: string[] = [];
  if (rawReasons !== undefined) {
    if (!Array.isArray(rawReasons)) {
      return {
        ok: false,
        errors: [{ path: "$.reasons", message: "expected array of strings" }],
      };
    }
    reasons = rawReasons.filter((r): r is string => typeof r === "string");
  }

  return success({ verdict: verdict.value, reasons });
}
