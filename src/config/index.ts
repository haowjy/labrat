import { existsSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import {
  expectEnum,
  expectNumber,
  expectOptional,
  expectRecord,
  expectString,
  singleError,
  success,
  type ValidationResult,
} from "../schema/validation.js";

/**
 * Single config seam for the whole harness (design: one deep module, not
 * scattered `process.env` reads). Precedence, lowest to highest:
 *
 *   built-in default < labrat.config.json < env var < protocol.yaml < agent-def
 *
 * The last two steps happen at the call sites that actually see the loaded
 * protocol/agent-def (worker/review session builders); this module resolves
 * everything up through the env-var layer, once, at the run entrypoint.
 */
export type LabratConfig = {
  readonly defaultModel: "sonnet" | "opus" | "haiku" | "inherit";
  readonly defaultPermissionMode:
    | "default"
    | "acceptEdits"
    | "bypassPermissions"
    | "plan";
  /** Absolute path, `~` expanded. */
  readonly scienceHome: string;
  /** null when unset — deliberately no personal-path default. */
  readonly microctSrc: string | null;
  /** null means the caller must pass a protocol name explicitly. */
  readonly defaultProtocol: string | null;
  /** Absolute path the folder-watcher polls for dropped inputs. */
  readonly incomingDir: string;
  readonly dashboard: {
    readonly port: number;
    readonly url: string;
    readonly user: string;
  };
  readonly retries: {
    readonly workerStall: number;
    readonly reviewAttempts: number;
    readonly phaseAttempts: number;
  };
};

/** Single source of truth for the science-home default (also used by
 * `runtime-setup/config.ts` so it doesn't carry its own copy). */
export const DEFAULT_SCIENCE_HOME = join(homedir(), ".claude-science");

/** Single source of truth for the dashboard default port/URL (also used by
 * `harness/events/index.ts` as its pre-`configureEvents()` fallback). */
export const DEFAULT_DASHBOARD_PORT = 4600;
export const DEFAULT_DASHBOARD_URL = `http://localhost:${DEFAULT_DASHBOARD_PORT}`;

const MODEL_VALUES = ["sonnet", "opus", "haiku", "inherit"] as const;
const PERMISSION_MODE_VALUES = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
] as const;

/** Shape of the optional `labrat.config.json` file — every key optional. */
type LabratConfigFile = {
  readonly defaultModel?: LabratConfig["defaultModel"];
  readonly defaultPermissionMode?: LabratConfig["defaultPermissionMode"];
  readonly scienceHome?: string;
  readonly microctSrc?: string;
  readonly defaultProtocol?: string;
  readonly incomingDir?: string;
  readonly dashboard?: {
    readonly port?: number;
    readonly url?: string;
    readonly user?: string;
  };
  readonly retries?: {
    readonly workerStall?: number;
    readonly reviewAttempts?: number;
    readonly phaseAttempts?: number;
  };
};

const KNOWN_TOP_LEVEL_KEYS = new Set([
  "defaultModel",
  "defaultPermissionMode",
  "scienceHome",
  "microctSrc",
  "defaultProtocol",
  "incomingDir",
  "dashboard",
  "retries",
]);
const KNOWN_DASHBOARD_KEYS = new Set(["port", "url", "user"]);
const KNOWN_RETRIES_KEYS = new Set(["workerStall", "reviewAttempts", "phaseAttempts"]);

/** Reject unknown keys so a typo (e.g. `defualtModel`) fails loudly instead
 * of being silently dropped, matching the strictness of value validation. */
function checkUnknownKeys(
  rec: Record<string, unknown>,
  path: string,
  known: ReadonlySet<string>,
): ValidationResult<void> {
  const unknown = Object.keys(rec).filter((k) => !known.has(k));
  if (unknown.length > 0) {
    return singleError(
      path,
      `unknown key(s): ${unknown.join(", ")}`,
    );
  }
  return success(undefined);
}

function validateConfigFile(value: unknown): ValidationResult<LabratConfigFile> {
  const rec = expectRecord(value, "$");
  if (!rec.ok) return rec;

  const unknownTopLevel = checkUnknownKeys(rec.value, "$", KNOWN_TOP_LEVEL_KEYS);
  if (!unknownTopLevel.ok) return unknownTopLevel;

  const defaultModel = expectOptional(
    rec.value["defaultModel"],
    "$.defaultModel",
    (v, p) => expectEnum(v, p, MODEL_VALUES),
  );
  if (!defaultModel.ok) return defaultModel;

  const defaultPermissionMode = expectOptional(
    rec.value["defaultPermissionMode"],
    "$.defaultPermissionMode",
    (v, p) => expectEnum(v, p, PERMISSION_MODE_VALUES),
  );
  if (!defaultPermissionMode.ok) return defaultPermissionMode;

  const scienceHome = expectOptional(
    rec.value["scienceHome"],
    "$.scienceHome",
    (v, p) => expectString(v, p),
  );
  if (!scienceHome.ok) return scienceHome;

  const microctSrc = expectOptional(
    rec.value["microctSrc"],
    "$.microctSrc",
    (v, p) => expectString(v, p),
  );
  if (!microctSrc.ok) return microctSrc;

  const defaultProtocol = expectOptional(
    rec.value["defaultProtocol"],
    "$.defaultProtocol",
    (v, p) => expectString(v, p),
  );
  if (!defaultProtocol.ok) return defaultProtocol;

  const incomingDir = expectOptional(
    rec.value["incomingDir"],
    "$.incomingDir",
    (v, p) => expectString(v, p),
  );
  if (!incomingDir.ok) return incomingDir;

  let dashboard: LabratConfigFile["dashboard"];
  if (rec.value["dashboard"] !== undefined && rec.value["dashboard"] !== null) {
    const dashRec = expectRecord(rec.value["dashboard"], "$.dashboard");
    if (!dashRec.ok) return dashRec;
    const unknownDashboard = checkUnknownKeys(
      dashRec.value,
      "$.dashboard",
      KNOWN_DASHBOARD_KEYS,
    );
    if (!unknownDashboard.ok) return unknownDashboard;
    const port = expectOptional(dashRec.value["port"], "$.dashboard.port", (v, p) =>
      expectNumber(v, p),
    );
    if (!port.ok) return port;
    const url = expectOptional(dashRec.value["url"], "$.dashboard.url", (v, p) =>
      expectString(v, p),
    );
    if (!url.ok) return url;
    const user = expectOptional(dashRec.value["user"], "$.dashboard.user", (v, p) =>
      expectString(v, p),
    );
    if (!user.ok) return user;
    dashboard = {
      ...(port.value !== undefined ? { port: port.value } : {}),
      ...(url.value !== undefined ? { url: url.value } : {}),
      ...(user.value !== undefined ? { user: user.value } : {}),
    };
  }

  let retries: LabratConfigFile["retries"];
  if (rec.value["retries"] !== undefined && rec.value["retries"] !== null) {
    const retRec = expectRecord(rec.value["retries"], "$.retries");
    if (!retRec.ok) return retRec;
    const unknownRetries = checkUnknownKeys(retRec.value, "$.retries", KNOWN_RETRIES_KEYS);
    if (!unknownRetries.ok) return unknownRetries;
    const workerStall = expectOptional(
      retRec.value["workerStall"],
      "$.retries.workerStall",
      (v, p) => expectNumber(v, p),
    );
    if (!workerStall.ok) return workerStall;
    const reviewAttempts = expectOptional(
      retRec.value["reviewAttempts"],
      "$.retries.reviewAttempts",
      (v, p) => expectNumber(v, p),
    );
    if (!reviewAttempts.ok) return reviewAttempts;
    const phaseAttempts = expectOptional(
      retRec.value["phaseAttempts"],
      "$.retries.phaseAttempts",
      (v, p) => expectNumber(v, p),
    );
    if (!phaseAttempts.ok) return phaseAttempts;
    retries = {
      ...(workerStall.value !== undefined ? { workerStall: workerStall.value } : {}),
      ...(reviewAttempts.value !== undefined
        ? { reviewAttempts: reviewAttempts.value }
        : {}),
      ...(phaseAttempts.value !== undefined
        ? { phaseAttempts: phaseAttempts.value }
        : {}),
    };
  }

  return {
    ok: true,
    value: {
      ...(defaultModel.value !== undefined ? { defaultModel: defaultModel.value } : {}),
      ...(defaultPermissionMode.value !== undefined
        ? { defaultPermissionMode: defaultPermissionMode.value }
        : {}),
      ...(scienceHome.value !== undefined ? { scienceHome: scienceHome.value } : {}),
      ...(microctSrc.value !== undefined ? { microctSrc: microctSrc.value } : {}),
      ...(defaultProtocol.value !== undefined
        ? { defaultProtocol: defaultProtocol.value }
        : {}),
      ...(incomingDir.value !== undefined ? { incomingDir: incomingDir.value } : {}),
      ...(dashboard !== undefined ? { dashboard } : {}),
      ...(retries !== undefined ? { retries } : {}),
    },
  };
}

function expandTilde(p: string): string;
function expandTilde(p: string | null): string | null;
function expandTilde(p: string | null): string | null {
  if (p === null) return null;
  return p.startsWith("~/") || p === "~" ? join(homedir(), p.slice(1)) : p;
}

/** Read+validate `labrat.config.json`, searching `cwd` then `scienceHome`. */
function readConfigFile(cwd: string, scienceHomeGuess: string): LabratConfigFile {
  const candidates = [
    join(cwd, "labrat.config.json"),
    join(scienceHomeGuess, "labrat.config.json"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (err) {
      throw new Error(
        `Failed to read config file ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `Malformed JSON in config file ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const validated = validateConfigFile(parsed);
    if (!validated.ok) {
      throw new Error(
        `Invalid config file ${path}: ${validated.errors
          .map((e) => `${e.path} ${e.message}`)
          .join("; ")}`,
      );
    }
    return validated.value;
  }
  return {};
}

function isModel(v: string | undefined): v is LabratConfig["defaultModel"] {
  return v !== undefined && (MODEL_VALUES as readonly string[]).includes(v);
}

function isPermissionMode(
  v: string | undefined,
): v is LabratConfig["defaultPermissionMode"] {
  return v !== undefined && (PERMISSION_MODE_VALUES as readonly string[]).includes(v);
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Resolve the one true {@link LabratConfig} for this process.
 *
 * Note on ENUM env vars (`LABRAT_MODEL`, `LABRAT_PERMISSION_MODE`): an
 * invalid value is intentionally ignored, falling back to the file/default
 * layer below it — unlike the config file, which throws on an invalid enum
 * value in `validateConfigFile`. Env vars come from the ambient shell and
 * are more likely to carry stray/unrelated values, so we're lenient there.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): LabratConfig {
  // Built-in defaults.
  const defaults: LabratConfig = {
    defaultModel: "sonnet",
    defaultPermissionMode: "bypassPermissions",
    scienceHome: DEFAULT_SCIENCE_HOME,
    microctSrc: null,
    defaultProtocol: null,
    incomingDir: join(cwd, "incoming"),
    dashboard: {
      port: DEFAULT_DASHBOARD_PORT,
      url: DEFAULT_DASHBOARD_URL,
      user: userInfo().username,
    },
    retries: { workerStall: 3, reviewAttempts: 2, phaseAttempts: 2 },
  };

  // Overlay labrat.config.json (search cwd, then the default scienceHome —
  // env CLAUDE_SCIENCE_HOME can't affect *where* we look for the file itself
  // since the file is what would set scienceHome in the first place).
  const file = readConfigFile(cwd, defaults.scienceHome);

  const scienceHome = expandTilde(
    env["CLAUDE_SCIENCE_HOME"] ?? file.scienceHome ?? defaults.scienceHome,
  );

  const port =
    parsePositiveInt(env["LABRAT_DASHBOARD_PORT"]) ??
    parsePositiveInt(env["PORT"]) ??
    file.dashboard?.port ??
    defaults.dashboard.port;

  const url =
    env["LABRAT_DASHBOARD_URL"] ?? file.dashboard?.url ?? `http://localhost:${port}`;

  const envModel = env["LABRAT_MODEL"];
  const envPermissionMode = env["LABRAT_PERMISSION_MODE"];

  return {
    defaultModel:
      (isModel(envModel) ? envModel : undefined) ??
      file.defaultModel ??
      defaults.defaultModel,
    defaultPermissionMode:
      (isPermissionMode(envPermissionMode) ? envPermissionMode : undefined) ??
      file.defaultPermissionMode ??
      defaults.defaultPermissionMode,
    scienceHome,
    microctSrc: expandTilde(
      env["LABRAT_MICROCT_SRC"] ?? file.microctSrc ?? defaults.microctSrc,
    ),
    defaultProtocol:
      env["LABRAT_PROTOCOL"] ?? file.defaultProtocol ?? defaults.defaultProtocol,
    incomingDir: expandTilde(
      env["LABRAT_INCOMING_DIR"] ?? file.incomingDir ?? defaults.incomingDir,
    ),
    dashboard: {
      port,
      url,
      user: env["LABRAT_USER"] ?? file.dashboard?.user ?? defaults.dashboard.user,
    },
    retries: {
      workerStall:
        parsePositiveInt(env["LABRAT_WORKER_STALL_RETRIES"]) ??
        file.retries?.workerStall ??
        defaults.retries.workerStall,
      reviewAttempts:
        parsePositiveInt(env["LABRAT_REVIEW_ATTEMPTS"]) ??
        file.retries?.reviewAttempts ??
        defaults.retries.reviewAttempts,
      phaseAttempts:
        parsePositiveInt(env["LABRAT_PHASE_ATTEMPTS"]) ??
        file.retries?.phaseAttempts ??
        defaults.retries.phaseAttempts,
    },
  };
}
