import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createContext, runInContext, Script } from "node:vm";

/**
 * `check_review_site` — the deterministic review-site linter (design
 * review-template.md §2, gates G1-G8).
 *
 * It depends ONLY on the review-site CONTRACT (§1, invariants I1-I7): an
 * entry point, a self-contained relative-path folder, `.js`-global run data,
 * an export-a-verdict surface, and a manifest that names the run the site was
 * built from. It knows nothing about bonemorph / 3D / Plotly, so it gates any
 * protocol's review site identically. It is BOTH the gate check the reviewer
 * runs AND the worker's self-check (write once, use twice).
 *
 * Pure over its inputs (a folder on disk + the phase's `cdn_allowlist` + the
 * run's measurements file); returns a findings report, never throws on a
 * contract violation (only on genuinely unreadable input).
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
  readonly findings: readonly Finding[];
};

export type CheckReviewSiteOptions = {
  /** Absolute path to the review-site folder (contains `index.html`). */
  readonly siteDir: string;
  /** External origins the phase permits (protocol.yaml `cdn_allowlist`, G6). */
  readonly cdnAllowlist: readonly string[];
  /**
   * Absolute path to the run's `measurements/results.json` (G8 fidelity). When
   * absent, G8 falls back to a structural check that the manifest self-describes
   * its source (sample_id present, `produced_from` hash-shaped) — the standalone
   * Lane 0 fixture has no run tree, so it is checked structurally.
   */
  readonly resultsPath?: string;
  /** Expected sample id when the results file carries no `sample_id` field. */
  readonly expectedSampleId?: string;
};

const HEX64 = /^[0-9a-f]{64}$/;

type HtmlFile = { readonly relPath: string; readonly absPath: string; readonly text: string };
type JsFile = { readonly relPath: string; readonly absPath: string; readonly text: string };

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

/** All `href`/`src` attribute values across a page (both quote styles). */
function extractRefs(html: string): string[] {
  const refs: string[] = [];
  const re = /(?:href|src)\s*=\s*("([^"]*)"|'([^']*)')/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    refs.push((m[2] ?? m[3] ?? "").trim());
  }
  return refs;
}

type RefKind =
  | "fragment"
  | "data"
  | "external"
  | "file-scheme"
  | "opaque-scheme"
  | "absolute"
  | "parent-traversal"
  | "relative";

function classifyRef(value: string): RefKind {
  if (value === "" || value.startsWith("#")) return "fragment";
  if (value.startsWith("data:")) return "data";
  if (/^https?:\/\//i.test(value)) return "external";
  if (/^file:\/\//i.test(value)) return "file-scheme";
  // mailto:, tel:, javascript: — no file to resolve, not an external origin.
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

/** Run JS files in a shared fake-`window` sandbox and return the globals set. */
function collectWindowGlobals(files: readonly JsFile[]): {
  readonly globals: Record<string, unknown>;
  readonly error: string | null;
} {
  const sandbox: { window: Record<string, unknown> } = { window: {} };
  const ctx = createContext(sandbox);
  for (const f of files) {
    try {
      runInContext(f.text, ctx, { filename: f.absPath });
    } catch (err) {
      return {
        globals: sandbox.window,
        error: `${f.relPath}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  return { globals: sandbox.window, error: null };
}

function isNonEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
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

// --- G2: self-contained (relative, no `..`/absolute/file://, resolves in) ---
function checkG2(siteDir: string, htmls: readonly HtmlFile[]): Finding {
  const problems: string[] = [];
  for (const page of htmls) {
    for (const ref of extractRefs(page.text)) {
      const kind = classifyRef(ref);
      if (kind === "absolute") problems.push(`${page.relPath}: absolute path "${ref}"`);
      else if (kind === "parent-traversal")
        problems.push(`${page.relPath}: "${ref}" escapes the folder ("..")`);
      else if (kind === "file-scheme") problems.push(`${page.relPath}: file:// ref "${ref}"`);
      else if (kind === "relative" && resolvesInside(siteDir, page.absPath, ref) === null)
        problems.push(`${page.relPath}: relative ref "${ref}" does not resolve to a file inside the folder`);
    }
  }
  return finding("G2", problems);
}

// --- G3: data globals present ----------------------------------------------
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
  for (const f of dataJs) {
    if (f.text.trim().length === 0) problems.push(`${f.relPath} is empty`);
  }
  const { globals, error } = collectWindowGlobals(dataJs);
  if (error) {
    return { finding: finding("G3", [`data JS did not execute: ${error}`]), manifest: null };
  }
  // Each data/*.js must assign at least one non-empty window.* global.
  for (const f of dataJs) {
    const one = collectWindowGlobals([f]);
    const assigned = Object.keys(one.globals).filter((k) => isNonEmptyValue(one.globals[k]));
    if (!one.error && assigned.length === 0) {
      problems.push(`${f.relPath} assigns no non-empty window.* global`);
    }
  }
  const manifestGlobal = globals["REVIEW_MANIFEST"];
  if (!isNonEmptyValue(manifestGlobal) || typeof manifestGlobal !== "object") {
    return {
      finding: finding("G3", [...problems, "data/manifest.js does not assign window.REVIEW_MANIFEST"]),
      manifest: null,
    };
  }
  const mf = manifestGlobal as Record<string, unknown>;
  const declared = Array.isArray(mf["data_globals"])
    ? (mf["data_globals"] as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  for (const name of declared) {
    if (!isNonEmptyValue(globals[name])) {
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
  for (const f of allJs) {
    try {
      new Script(f.text, { filename: f.absPath });
    } catch (err) {
      problems.push(`${f.relPath}: invalid JS (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  // Every getElementById("X") in a page's scripts (inline + <script src> under
  // the site) must target an id present in that page.
  for (const page of htmls) {
    const inline = [...page.text.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
      .map((m) => m[1] ?? "")
      .join("\n");
    const srcRefs = extractRefs(page.text).filter((r) => classifyRef(r) === "relative" && r.endsWith(".js"));
    const scripts = [inline];
    for (const ref of srcRefs) {
      const match = allJs.find((j) => j.absPath === resolve(dirname(page.absPath), ref.split(/[?#]/)[0] ?? ref));
      if (match) scripts.push(match.text);
    }
    const ids = new Set(
      [...page.text.matchAll(/\bid\s*=\s*("([^"]*)"|'([^']*)')/gi)].map((m) => m[2] ?? m[3] ?? ""),
    );
    for (const js of scripts) {
      for (const m of js.matchAll(/getElementById\(\s*("([^"]*)"|'([^']*)')\s*\)/g)) {
        const id = m[2] ?? m[3] ?? "";
        if (!ids.has(id)) {
          problems.push(`${page.relPath}: getElementById("${id}") has no matching element id in the page`);
        }
      }
    }
  }
  return finding("G4", problems);
}

// --- G5: no local fetch / XHR of a relative or `.json` path ----------------
function checkG5(allJs: readonly JsFile[]): Finding {
  const problems: string[] = [];
  for (const f of allJs) {
    for (const m of f.text.matchAll(/\bfetch\s*\(\s*("([^"]*)"|'([^']*)'|`([^`]*)`)/g)) {
      const url = m[2] ?? m[3] ?? m[4] ?? "";
      const external = /^https?:\/\//i.test(url) || url.startsWith("data:");
      if (!external || url.endsWith(".json")) {
        problems.push(`${f.relPath}: fetch("${url}") of a local/JSON path (I3: data ships as .js globals, never fetched)`);
      }
    }
    if (/\bXMLHttpRequest\b/.test(f.text)) {
      problems.push(`${f.relPath}: uses XMLHttpRequest (I3: no runtime fetch of local data)`);
    }
  }
  return finding("G5", problems);
}

// --- G6: external origins ⊆ cdn_allowlist ----------------------------------
function checkG6(htmls: readonly HtmlFile[], cdnAllowlist: readonly string[]): Finding {
  const allowed = new Set(cdnAllowlist.map((o) => o.replace(/\/+$/, "")));
  const problems: string[] = [];
  for (const page of htmls) {
    for (const ref of extractRefs(page.text)) {
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
  const combined = `${htmlText}\n${jsText}`;

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
  void combined;
  return finding("G7", problems);
}

// --- G8: provenance fidelity ------------------------------------------------
async function checkG8(
  manifest: ManifestInfo | null,
  opts: CheckReviewSiteOptions,
): Promise<Finding> {
  if (manifest === null) {
    return finding("G8", ["manifest unavailable (see G3)"]);
  }
  const problems: string[] = [];
  const sampleId = typeof manifest.sampleId === "string" ? manifest.sampleId : "";
  if (sampleId.length === 0) problems.push("manifest sample_id missing");

  const pf = manifest.producedFrom;
  const measurement =
    pf !== null && typeof pf === "object" && typeof (pf as Record<string, unknown>)["measurement"] === "string"
      ? ((pf as Record<string, unknown>)["measurement"] as string)
      : "";
  const at = measurement.lastIndexOf("@");
  const declaredHash = at === -1 ? "" : measurement.slice(at + 1);
  if (at === -1 || !HEX64.test(declaredHash)) {
    problems.push(`manifest produced_from.measurement is not "path@<sha256>" (got "${measurement}")`);
  }

  if (opts.resultsPath && (await existsAt(opts.resultsPath))) {
    const bytes = await readFile(opts.resultsPath);
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (declaredHash && declaredHash !== actualHash) {
      problems.push(
        `manifest produced_from hash ${declaredHash.slice(0, 12)}… ≠ measurements/results.json ${actualHash.slice(0, 12)}… (stale/mismatched site)`,
      );
    }
    let runSampleId = opts.expectedSampleId ?? "";
    try {
      const parsed: unknown = JSON.parse(bytes.toString("utf8"));
      if (parsed !== null && typeof parsed === "object" && typeof (parsed as Record<string, unknown>)["sample_id"] === "string") {
        runSampleId = (parsed as Record<string, unknown>)["sample_id"] as string;
      }
    } catch {
      /* non-JSON results file — sample_id comparison falls back to expectedSampleId */
    }
    if (runSampleId && sampleId && runSampleId !== sampleId) {
      problems.push(`manifest sample_id "${sampleId}" ≠ run sample_id "${runSampleId}"`);
    }
  } else if (opts.expectedSampleId && sampleId && opts.expectedSampleId !== sampleId) {
    problems.push(`manifest sample_id "${sampleId}" ≠ expected "${opts.expectedSampleId}"`);
  }

  return finding("G8", problems);
}

/** Run G1-G8 against a review-site folder. */
export async function checkReviewSite(opts: CheckReviewSiteOptions): Promise<ReviewSiteReport> {
  const siteDir = resolve(opts.siteDir);

  const htmlPaths = await listFiles(siteDir, ".html");
  const jsPaths = await listFiles(siteDir, ".js");
  const htmls: HtmlFile[] = await Promise.all(
    htmlPaths.map(async (absPath) => ({
      absPath,
      relPath: relative(siteDir, absPath),
      text: await readFile(absPath, "utf8"),
    })),
  );
  const allJs: JsFile[] = await Promise.all(
    jsPaths.map(async (absPath) => ({
      absPath,
      relPath: relative(siteDir, absPath),
      text: await readFile(absPath, "utf8"),
    })),
  );
  const dataDir = join(siteDir, "data") + sep;
  const dataJs = allJs.filter((j) => j.absPath.startsWith(dataDir)).sort((a, b) => a.absPath.localeCompare(b.absPath));

  const g1 = await checkG1(siteDir);
  const g2 = checkG2(siteDir, htmls);
  const { finding: g3, manifest } = await checkG3(siteDir, dataJs);
  const g4 = checkG4(htmls, allJs);
  const g5 = checkG5(allJs);
  const g6 = checkG6(htmls, opts.cdnAllowlist);
  const g7 = checkG7(htmls, allJs, manifest);
  const g8 = await checkG8(manifest, opts);

  const findings = [g1, g2, g3, g4, g5, g6, g7, g8];
  return { ok: findings.every((f) => f.ok), siteDir, findings };
}
