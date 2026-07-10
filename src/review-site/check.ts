import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  analyzeJs,
  extractCssUrls,
  parseHtml,
  type HtmlElement,
  type JsAnalysis,
} from "./parse.js";

/**
 * `check_review_site` — the deterministic review-site linter (design
 * review-template.md §2, gates G1-G8).
 *
 * It depends ONLY on the review-site CONTRACT (§1, invariants I1-I7): an
 * entry point, a self-contained relative-path folder, `.js`-global run data,
 * an export-a-verdict surface, and a manifest that names the run the site was
 * built from. It knows nothing about bonemorph / 3D / Plotly, so it gates any
 * protocol's review site identically.
 *
 * This is the STRUCTURAL gate: it proves the site is self-contained, wired to
 * real in-folder files, and faithful to the run it names. It is defense in
 * depth WITH — not a replacement for — the dashboard's runtime CSP (Lane A),
 * which is the security boundary that contains the site at serve time. The
 * linter closes the structural bypass classes (external loads, runtime fetch,
 * arbitrary-exec `data:`/`javascript:` sources) statically, before serve.
 *
 * SECURITY: producer code is parsed, NEVER executed. All markup/JS analysis is
 * a static parse (see `parse.ts`) — the reviewer runs this in its own process,
 * so executing `data/*.js` here would be arbitrary code execution inside the
 * reviewer. Pure over its inputs (a folder on disk + the phase's
 * `cdn_allowlist` + the run's measurements); returns a findings report, never
 * throws on a contract violation (only on genuinely unreadable input).
 */

export type GateId = "G1" | "G2" | "G3" | "G4" | "G5" | "G6" | "G7" | "G8";

export type Finding = {
  readonly gate: GateId;
  readonly ok: boolean;
  /** One line per problem; empty on a clean gate. */
  readonly detail: string;
};

export type ReviewSiteReport = {
  readonly ok: boolean;
  readonly siteDir: string;
  /** Whether G8 could authoritatively verify the site against the run. */
  readonly fidelity: "verified" | "unverified";
  readonly findings: readonly Finding[];
};

export type CheckReviewSiteOptions = {
  /** Absolute path to the review-site folder (contains `index.html`). */
  readonly siteDir: string;
  /** External origins the phase permits (protocol.yaml `cdn_allowlist`, G6). */
  readonly cdnAllowlist: readonly string[];
  /**
   * Absolute path to the run's measurement file for the G8 hash check. When
   * omitted, the harness gate instead supplies `measurementsRoot` and the
   * linter resolves the manifest's declared `produced_from` path under it.
   */
  readonly resultsPath?: string;
  /**
   * Absolute root the manifest's `produced_from.measurement` path resolves
   * against (the harness passes `<taskDir>/artifacts`). Lets G8 hash the real
   * on-disk measurement the site names, with a traversal guard.
   */
  readonly measurementsRoot?: string;
  /**
   * Harness-known run id. The manifest `sample_id` MUST equal it (H1b) — this
   * is the authoritative anti-swap check, since a toy measurement file carries
   * no `sample_id` of its own.
   */
  readonly expectedSampleId?: string;
  /**
   * When true (the harness gate sets it), fidelity MUST be verifiable: a
   * missing/unreadable measurement FAILS G8 rather than degrading to a
   * structural-only pass (H1). The standalone Lane 0 fixture leaves it false.
   */
  readonly requireFidelity?: boolean;
};

const HEX64 = /^[0-9a-f]{64}$/;

type HtmlFile = {
  readonly relPath: string;
  readonly absPath: string;
  readonly text: string;
  readonly elements: readonly HtmlElement[];
  readonly ids: ReadonlySet<string>;
  readonly refs: readonly HtmlRef[];
  /** Inline `<script>` (no `src`) bodies, statically analysed. */
  readonly inlineScripts: readonly JsAnalysis[];
  /** Relative `.js` `<script src>` targets, for G4 id resolution. */
  readonly scriptSrcRefs: readonly string[];
};

type JsFile = {
  readonly relPath: string;
  readonly absPath: string;
  readonly text: string;
  readonly analysis: JsAnalysis;
};

/** Where a URL reference appears — governs which schemes are legal (G2). */
type RefContext = "exec" | "resource" | "css" | "nav";
type HtmlRef = { readonly value: string; readonly context: RefContext };

/** `src` on these loads executable/framed content; a `data:`/`blob:` there is code. */
const EXEC_SRC_TAGS = new Set(["script", "iframe", "embed", "object", "frame"]);

async function existsAt(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(root: string, ext: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(root, { recursive: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    if (!name.endsWith(ext)) continue;
    const abs = join(root, name);
    const info = await stat(abs).catch(() => undefined);
    if (info?.isFile()) out.push(abs);
  }
  return out.sort();
}

/** Every URL-bearing reference on a page (attributes + CSS), with its context. */
function collectRefs(elements: readonly HtmlElement[]): HtmlRef[] {
  const refs: HtmlRef[] = [];
  for (const el of elements) {
    const src = el.attrs.get("src");
    if (src !== undefined) {
      refs.push({ value: src.trim(), context: EXEC_SRC_TAGS.has(el.tag) ? "exec" : "resource" });
    }
    const href = el.attrs.get("href");
    if (href !== undefined) {
      const nav = el.tag === "a" || el.tag === "area" || el.tag === "base";
      refs.push({ value: href.trim(), context: nav ? "nav" : "exec" });
    }
    const style = el.attrs.get("style");
    if (style !== undefined) {
      for (const u of extractCssUrls(style)) refs.push({ value: u, context: "css" });
    }
    if (el.tag === "style" && el.rawText) {
      for (const u of extractCssUrls(el.rawText)) refs.push({ value: u, context: "css" });
    }
  }
  return refs;
}

type RefKind =
  | "fragment"
  | "data"
  | "blob"
  | "external"
  | "file-scheme"
  | "script-scheme"
  | "benign-scheme"
  | "opaque-scheme"
  | "absolute"
  | "parent-traversal"
  | "relative";

function classifyRef(value: string): RefKind {
  if (value === "" || value.startsWith("#")) return "fragment";
  if (/^data:/i.test(value)) return "data";
  if (/^blob:/i.test(value)) return "blob";
  if (/^https?:\/\//i.test(value)) return "external";
  if (/^file:\/\//i.test(value)) return "file-scheme";
  if (/^(?:javascript|vbscript):/i.test(value)) return "script-scheme";
  if (/^(?:mailto|tel|sms):/i.test(value)) return "benign-scheme";
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return "opaque-scheme";
  if (value.startsWith("/")) return "absolute";
  if (value.split(/[/\\]/).includes("..")) return "parent-traversal";
  return "relative";
}

/** Resolve a relative ref against the page that declared it; must stay inside `siteDir`. */
function resolvesInside(siteDir: string, pageAbs: string, ref: string): string | null {
  const noQuery = ref.split(/[?#]/)[0] ?? ref;
  const abs = resolve(dirname(pageAbs), noQuery);
  const rel = relative(siteDir, abs);
  if (rel.startsWith("..") || rel.startsWith(`..${sep}`) || resolve(siteDir, rel) !== abs) {
    return null;
  }
  return abs;
}

function finding(gate: GateId, problems: readonly string[]): Finding {
  return { gate, ok: problems.length === 0, detail: problems.join("; ") };
}

// --- G1: entry resolves -----------------------------------------------------
async function checkG1(siteDir: string): Promise<Finding> {
  const indexPath = join(siteDir, "index.html");
  if (!(await existsAt(indexPath))) {
    return finding("G1", [`index.html missing at ${siteDir}`]);
  }
  const info = await stat(indexPath);
  if (info.size === 0) return finding("G1", ["index.html is empty"]);
  return finding("G1", []);
}

// --- G2: self-contained (relative in-folder files; no exec/external source) --
async function checkG2(siteDir: string, htmls: readonly HtmlFile[]): Promise<Finding> {
  const problems: string[] = [];
  for (const page of htmls) {
    for (const { value: ref, context } of page.refs) {
      const kind = classifyRef(ref);
      switch (kind) {
        case "fragment":
        case "benign-scheme":
        case "external": // G6 owns external-origin policy.
          break;
        case "absolute":
          problems.push(`${page.relPath}: absolute path "${ref}"`);
          break;
        case "parent-traversal":
          problems.push(`${page.relPath}: "${ref}" escapes the folder ("..")`);
          break;
        case "file-scheme":
          problems.push(`${page.relPath}: file:// ref "${ref}"`);
          break;
        case "script-scheme":
          problems.push(`${page.relPath}: script-URL ref "${ref}" (arbitrary code source)`);
          break;
        case "opaque-scheme":
          problems.push(`${page.relPath}: non-relative ref "${ref}" resolves to no in-folder file`);
          break;
        case "data":
        case "blob":
          // Inline data on an <img> etc. is self-contained; on a script/link/
          // iframe or in CSS it is an arbitrary exec/style source.
          if (context === "exec" || context === "css") {
            problems.push(`${page.relPath}: ${kind}: ref in a ${context} position (arbitrary exec/style source)`);
          }
          break;
        case "relative": {
          const abs = resolvesInside(siteDir, page.absPath, ref);
          if (abs === null) {
            problems.push(`${page.relPath}: relative ref "${ref}" does not resolve inside the folder`);
          } else if (!(await existsAt(abs))) {
            problems.push(`${page.relPath}: relative ref "${ref}" points to a missing file (${relative(siteDir, abs)})`);
          }
          break;
        }
      }
    }
  }
  return finding("G2", problems);
}

// --- G3: data globals present (statically, never executed) ------------------
type ManifestInfo = {
  readonly sampleId: unknown;
  readonly producedFrom: unknown;
  readonly verdictSchema: unknown;
  readonly dataGlobals: readonly string[];
};

async function checkG3(
  siteDir: string,
  dataJs: readonly JsFile[],
): Promise<{ readonly finding: Finding; readonly manifest: ManifestInfo | null }> {
  const problems: string[] = [];
  const manifestPath = join(siteDir, "data", "manifest.js");
  if (!(await existsAt(manifestPath))) {
    return { finding: finding("G3", ["data/manifest.js missing"]), manifest: null };
  }

  // Aggregate every window.* global assigned across data/*.js (static parse).
  const globals = new Map<string, boolean>(); // name -> non-empty
  const globalValues = new Map<string, unknown>();
  for (const f of dataJs) {
    if (f.text.trim().length === 0) problems.push(`${f.relPath} is empty`);
    if (f.analysis.syntaxError) {
      problems.push(`${f.relPath}: could not parse (${f.analysis.syntaxError})`);
      continue;
    }
    const assigned = f.analysis.windowGlobals.filter((g) => g.nonEmpty);
    if (assigned.length === 0 && f.text.trim().length > 0) {
      problems.push(`${f.relPath} assigns no non-empty window.* global`);
    }
    for (const g of f.analysis.windowGlobals) {
      globals.set(g.name, (globals.get(g.name) ?? false) || g.nonEmpty);
      if (g.value !== undefined) globalValues.set(g.name, g.value);
    }
  }

  const manifestValue = globalValues.get("REVIEW_MANIFEST");
  if (!globals.get("REVIEW_MANIFEST")) {
    return {
      finding: finding("G3", [...problems, "data/manifest.js does not assign window.REVIEW_MANIFEST"]),
      manifest: null,
    };
  }
  if (manifestValue === undefined || typeof manifestValue !== "object" || manifestValue === null) {
    // Assigned but not a static object literal — the contract requires a
    // literal manifest the gate can read (I3/G8).
    return {
      finding: finding("G3", [...problems, "window.REVIEW_MANIFEST is not a static object literal"]),
      manifest: null,
    };
  }

  const mf = manifestValue as Record<string, unknown>;
  const declared = Array.isArray(mf["data_globals"])
    ? mf["data_globals"].filter((x): x is string => typeof x === "string")
    : [];
  for (const name of declared) {
    if (!globals.get(name)) {
      problems.push(`declared data global window.${name} is missing or empty`);
    }
  }
  const manifest: ManifestInfo = {
    sampleId: mf["sample_id"],
    producedFrom: mf["produced_from"],
    verdictSchema: mf["verdict_schema"],
    dataGlobals: declared,
  };
  return { finding: finding("G3", problems), manifest };
}

// --- G4: JS statically valid + referenced element IDs exist ----------------
function checkG4(htmls: readonly HtmlFile[], allJs: readonly JsFile[]): Finding {
  const problems: string[] = [];
  const byAbs = new Map(allJs.map((j) => [j.absPath, j] as const));
  for (const f of allJs) {
    if (f.analysis.syntaxError) {
      problems.push(`${f.relPath}: invalid JS (${f.analysis.syntaxError})`);
    }
  }
  for (const page of htmls) {
    const analyses: JsAnalysis[] = [...page.inlineScripts];
    page.inlineScripts.forEach((a, idx) => {
      if (a.syntaxError) problems.push(`${page.relPath}: inline <script> #${idx + 1} invalid JS (${a.syntaxError})`);
    });
    for (const ref of page.scriptSrcRefs) {
      const abs = resolve(dirname(page.absPath), ref.split(/[?#]/)[0] ?? ref);
      const match = byAbs.get(abs);
      if (match) analyses.push(match.analysis);
    }
    for (const a of analyses) {
      for (const id of a.getElementByIds) {
        if (!page.ids.has(id)) {
          problems.push(`${page.relPath}: getElementById("${id}") has no matching element id in the page`);
        }
      }
    }
  }
  return finding("G4", problems);
}

// --- G5: no runtime data loading (I3: data ships as .js globals) ------------
function checkG5(htmls: readonly HtmlFile[], allJs: readonly JsFile[]): Finding {
  const problems: string[] = [];
  const sources: { label: string; analysis: JsAnalysis }[] = allJs.map((f) => ({
    label: f.relPath,
    analysis: f.analysis,
  }));
  for (const page of htmls) {
    page.inlineScripts.forEach((a, idx) =>
      sources.push({ label: `${page.relPath} inline <script> #${idx + 1}`, analysis: a }),
    );
  }
  for (const { label, analysis } of sources) {
    for (const call of analysis.fetchCalls) {
      const shown = call.url === null ? "fetch(<dynamic>)" : `fetch("${call.url}")`;
      problems.push(`${label}: ${shown} — the site must ship data as .js globals, never fetch at runtime (I3)`);
    }
    for (const sink of analysis.networkSinks) {
      problems.push(`${label}: uses ${sink} (I3: no runtime data loading)`);
    }
    if (analysis.dynamicImports > 0) {
      problems.push(`${label}: dynamic import() loads code at runtime (I3: load via <script> only)`);
    }
  }
  return finding("G5", problems);
}

// --- G6: external origins ⊆ cdn_allowlist ----------------------------------
function normalizeOrigin(entry: string): string {
  try {
    return new URL(entry).origin;
  } catch {
    return entry.replace(/\/+$/, "");
  }
}

function checkG6(htmls: readonly HtmlFile[], cdnAllowlist: readonly string[]): Finding {
  const allowed = new Set(cdnAllowlist.map(normalizeOrigin));
  const problems: string[] = [];
  for (const page of htmls) {
    for (const { value: ref } of page.refs) {
      if (classifyRef(ref) !== "external") continue;
      let origin: string;
      try {
        origin = new URL(ref).origin;
      } catch {
        problems.push(`${page.relPath}: unparseable external ref "${ref}"`);
        continue;
      }
      if (!allowed.has(origin)) {
        problems.push(`${page.relPath}: external origin ${origin} not in cdn_allowlist [${[...allowed].join(", ")}]`);
      }
    }
  }
  return finding("G6", problems);
}

// --- G7: verdict export surface + schema string referenced ------------------
function checkG7(
  htmls: readonly HtmlFile[],
  allJs: readonly JsFile[],
  manifest: ManifestInfo | null,
): Finding {
  const problems: string[] = [];
  const htmlText = htmls.map((h) => h.text).join("\n");
  const jsText = allJs.map((j) => j.text).join("\n");

  const hasExportControl =
    /\.download\s*=/.test(jsText) ||
    /\bdownload\b/i.test(htmlText) ||
    /id\s*=\s*["'][^"']*export/i.test(htmlText);
  if (!hasExportControl) {
    problems.push("no verdict export control (a `download` surface or an export element)");
  }

  const referencesSchema = /\bschema\b/.test(jsText);
  const manifestHasSchema = typeof manifest?.verdictSchema === "string" && manifest.verdictSchema.length > 0;
  if (!referencesSchema || !manifestHasSchema) {
    problems.push("verdict `schema` string not referenced (I5: the export must carry a schema)");
  }
  return finding("G7", problems);
}

// --- G8: provenance fidelity ------------------------------------------------
/** Resolve the manifest's declared measurement path under `root`, guarded. */
function resolveMeasurement(root: string, declaredPath: string): string | null {
  if (declaredPath.length === 0 || isAbsolute(declaredPath)) return null;
  const abs = resolve(root, declaredPath);
  const rel = relative(root, abs);
  if (rel.startsWith("..") || rel.startsWith(`..${sep}`)) return null;
  return abs;
}

async function checkG8(
  manifest: ManifestInfo | null,
  opts: CheckReviewSiteOptions,
): Promise<{ finding: Finding; fidelity: "verified" | "unverified" }> {
  if (manifest === null) {
    return { finding: finding("G8", ["manifest unavailable (see G3)"]), fidelity: "unverified" };
  }
  const problems: string[] = [];
  const sampleId = typeof manifest.sampleId === "string" ? manifest.sampleId : "";
  if (sampleId.length === 0) problems.push("manifest sample_id missing");

  // The manifest sample_id must equal the harness-known run id (H1b): a toy
  // measurement carries no sample_id of its own, so this is the anti-swap check.
  if (opts.expectedSampleId && sampleId && opts.expectedSampleId !== sampleId) {
    problems.push(`manifest sample_id "${sampleId}" ≠ run id "${opts.expectedSampleId}"`);
  }

  const pf = manifest.producedFrom;
  const measurement =
    pf !== null && typeof pf === "object" && typeof (pf as Record<string, unknown>)["measurement"] === "string"
      ? ((pf as Record<string, unknown>)["measurement"] as string)
      : "";
  const at = measurement.lastIndexOf("@");
  const declaredPath = at === -1 ? "" : measurement.slice(0, at);
  const declaredHash = at === -1 ? "" : measurement.slice(at + 1);
  if (at === -1 || !HEX64.test(declaredHash)) {
    problems.push(`manifest produced_from.measurement is not "path@<sha256>" (got "${measurement}")`);
  }

  // Locate the real on-disk measurement: an explicit resultsPath (CLI) or the
  // declared path resolved under the harness-supplied measurementsRoot.
  const measurementFile =
    opts.resultsPath ??
    (opts.measurementsRoot && declaredPath
      ? resolveMeasurement(opts.measurementsRoot, declaredPath)
      : null);

  let fidelity: "verified" | "unverified" = "unverified";
  if (measurementFile && (await existsAt(measurementFile))) {
    fidelity = "verified";
    const bytes = await readFile(measurementFile);
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (declaredHash && declaredHash !== actualHash) {
      problems.push(
        `manifest produced_from hash ${declaredHash.slice(0, 12)}… ≠ measurement ${actualHash.slice(0, 12)}… (stale/mismatched site)`,
      );
    }
    // If the measurement itself names a sample_id, it must match too.
    try {
      const parsed: unknown = JSON.parse(bytes.toString("utf8"));
      if (parsed !== null && typeof parsed === "object") {
        const runSampleId = (parsed as Record<string, unknown>)["sample_id"];
        if (typeof runSampleId === "string" && sampleId && runSampleId !== sampleId) {
          problems.push(`manifest sample_id "${sampleId}" ≠ measurement sample_id "${runSampleId}"`);
        }
      }
    } catch {
      /* non-JSON measurement — hash check still applies. */
    }
  } else if (opts.requireFidelity) {
    // The harness gate requires an authoritative check; a missing measurement
    // must FAIL, not silently degrade to a structural-only pass (H1).
    problems.push(
      `fidelity required but the measurement is unavailable (${measurementFile ?? "no path supplied"})`,
    );
  }

  return { finding: finding("G8", problems), fidelity };
}

/** Run G1-G8 against a review-site folder. */
export async function checkReviewSite(opts: CheckReviewSiteOptions): Promise<ReviewSiteReport> {
  const siteDir = resolve(opts.siteDir);

  const htmlPaths = await listFiles(siteDir, ".html");
  const jsPaths = await listFiles(siteDir, ".js");

  const allJs: JsFile[] = await Promise.all(
    jsPaths.map(async (absPath) => {
      const text = await readFile(absPath, "utf8");
      return { absPath, relPath: relative(siteDir, absPath), text, analysis: analyzeJs(text) };
    }),
  );

  const htmls: HtmlFile[] = await Promise.all(
    htmlPaths.map(async (absPath) => {
      const text = await readFile(absPath, "utf8");
      const elements = parseHtml(text);
      const ids = new Set<string>();
      const inlineScripts: JsAnalysis[] = [];
      const scriptSrcRefs: string[] = [];
      for (const el of elements) {
        const id = el.attrs.get("id");
        if (id !== undefined && id.length > 0) ids.add(id);
        if (el.tag === "script") {
          const src = el.attrs.get("src");
          if (src === undefined) {
            if (el.rawText && el.rawText.trim().length > 0) inlineScripts.push(analyzeJs(el.rawText));
          } else if (classifyRef(src.trim()) === "relative" && src.trim().endsWith(".js")) {
            scriptSrcRefs.push(src.trim());
          }
        }
      }
      return {
        absPath,
        relPath: relative(siteDir, absPath),
        text,
        elements,
        ids,
        refs: collectRefs(elements),
        inlineScripts,
        scriptSrcRefs,
      };
    }),
  );

  const dataDir = join(siteDir, "data") + sep;
  const dataJs = allJs
    .filter((j) => j.absPath.startsWith(dataDir))
    .sort((a, b) => a.absPath.localeCompare(b.absPath));

  const g1 = await checkG1(siteDir);
  const g2 = await checkG2(siteDir, htmls);
  const { finding: g3, manifest } = await checkG3(siteDir, dataJs);
  const g4 = checkG4(htmls, allJs);
  const g5 = checkG5(htmls, allJs);
  const g6 = checkG6(htmls, opts.cdnAllowlist);
  const g7 = checkG7(htmls, allJs, manifest);
  const { finding: g8, fidelity } = await checkG8(manifest, opts);

  const findings = [g1, g2, g3, g4, g5, g6, g7, g8];
  return { ok: findings.every((f) => f.ok), siteDir, fidelity, findings };
}
