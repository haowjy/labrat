import { cp, readdir, readFile, rm, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

/**
 * The LabRat ↔ Claude Science import bridge (inverse of
 * scripts/export-skills-to-claude-science.sh). LabRat *runs* skills that live
 * in the Claude Science registry; this module lets it *browse* that registry
 * and *import* one into the repo's vendored `skills/` tree — the open-source
 * source of truth the export script pushes back.
 *
 * Pure by construction: every entry point takes an explicit `home` (the
 * resolved `scienceHome` from the single config seam, src/config) and, for
 * import, an explicit `repoSkillsDir`. Nothing here reads process.env — the
 * harness threads the resolved paths in.
 *
 * Registry layout (real, on disk):
 *   <home>/orgs/<orgId>/skills/<name>/{SKILL.md, protocol.yaml?, resources/…}
 *   <home>/runtime/<version>/skills/<name>/{SKILL.md, …}   (Claude Science built-ins)
 */

/** Repo-vendored skills dir (`<repo>/skills/`), resolved from this module's
 * URL so it works under tsx or compiled — same idiom as dashboard STATIC_ROOT.
 * This is the import target and the "already vendored" reference. */
export const REPO_SKILLS_DIR = fileURLToPath(
  new URL("../../../skills/", import.meta.url),
);

export type ClaudeScienceSkill = {
  readonly name: string;
  /** Org id for an org skill, or "builtin" for a runtime built-in. */
  readonly source: string;
  readonly builtin: boolean;
  /** Has a protocol.yaml — LabRat can execute it as a protocol. */
  readonly runnable: boolean;
  /** SKILL.md frontmatter description (first sentence) or first prose line. */
  readonly description: string;
  /** Absolute path to the skill dir (import source). */
  readonly dir: string;
};

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/** Immediate subdirectory names of `dir`, sorted; [] if `dir` is absent. */
async function subdirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

/**
 * A short one-line description for a SKILL.md: the frontmatter `description`
 * (parsed via YAML so folded/literal block scalars like `description: >`
 * collapse correctly) trimmed to its first sentence, else the first non-heading
 * prose line of the body, else the first `# heading`. Pure — no I/O. Returns ""
 * when nothing usable is found.
 */
export function skillDescription(raw: string): string {
  const match = FRONTMATTER_RE.exec(raw);
  const body = match?.[2] ?? raw;

  if (match?.[1]) {
    let description: unknown;
    try {
      const parsed = parseYaml(match[1]) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        description = (parsed as Record<string, unknown>)["description"];
      }
    } catch {
      description = undefined;
    }
    if (typeof description === "string" && description.trim() !== "") {
      const value = description.replace(/\s+/g, " ").trim();
      // First sentence, but only if it's substantial — a short leading
      // fragment usually means the splitter tripped on an abbreviation
      // ("et al.", "e.g."), so fall back to a length-capped summary instead.
      const firstSentence = value.split(/(?<=[.!?])\s/)[0]?.trim() ?? "";
      if (firstSentence.length >= 40) return firstSentence;
      return value.length > 160 ? `${value.slice(0, 159).trimEnd()}…` : value;
    }
  }

  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    return trimmed;
  }

  const heading = body.split(/\r?\n/).find((l) => l.trim().startsWith("#"));
  return heading ? heading.replace(/^#+\s*/, "").trim() : "";
}

async function readSkill(
  dir: string,
  name: string,
  source: string,
  builtin: boolean,
): Promise<ClaudeScienceSkill | null> {
  const skillMd = join(dir, "SKILL.md");
  if (!(await isFile(skillMd))) return null;
  const raw = await readFile(skillMd, "utf8").catch(() => "");
  return {
    name,
    source,
    builtin,
    runnable: await isFile(join(dir, "protocol.yaml")),
    description: skillDescription(raw),
    dir,
  };
}

/**
 * Walk the Claude Science registry under `home` and return one entry per skill.
 * Org skills (under orgs/<org>/skills/) come first, then runtime built-ins
 * (under runtime/<version>/skills/, tagged `builtin`) when `includeBuiltins` is
 * set. A dir without a SKILL.md is skipped. Sorted by (builtin, source, name).
 */
export async function listClaudeScienceSkills(
  home: string,
  opts: { readonly includeBuiltins?: boolean } = {},
): Promise<ClaudeScienceSkill[]> {
  const skills: ClaudeScienceSkill[] = [];

  const orgsRoot = join(home, "orgs");
  for (const orgId of await subdirs(orgsRoot)) {
    const skillsRoot = join(orgsRoot, orgId, "skills");
    for (const name of await subdirs(skillsRoot)) {
      const s = await readSkill(join(skillsRoot, name), name, orgId, false);
      if (s) skills.push(s);
    }
  }

  if (opts.includeBuiltins) {
    const runtimeRoot = join(home, "runtime");
    for (const version of await subdirs(runtimeRoot)) {
      const skillsRoot = join(runtimeRoot, version, "skills");
      for (const name of await subdirs(skillsRoot)) {
        const s = await readSkill(join(skillsRoot, name), name, "builtin", true);
        if (s) skills.push(s);
      }
    }
  }

  return skills.sort(
    (a, b) =>
      Number(a.builtin) - Number(b.builtin) ||
      a.source.localeCompare(b.source) ||
      a.name.localeCompare(b.name),
  );
}

/** Names already vendored in the repo's `skills/` dir (import targets that
 * exist). Used to flag "already imported" in the CLI/dashboard listings. */
export async function listVendoredSkillNames(
  repoSkillsDir: string = REPO_SKILLS_DIR,
): Promise<Set<string>> {
  return new Set(await subdirs(repoSkillsDir));
}

export type ImportResult = {
  readonly name: string;
  readonly source: string;
  readonly from: string;
  readonly to: string;
  /** Relative paths (posix-style) of every file copied, for the report. */
  readonly files: readonly string[];
  /** True when `force` overwrote an existing vendored dir. */
  readonly overwritten: boolean;
};

/** Every file path under `dir`, relative to it, sorted (for the copy report). */
async function walkFiles(dir: string, base: string = dir): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walkFiles(full, base)));
    } else if (e.isFile()) {
      out.push(relative(base, full).split(sep).join("/"));
    }
  }
  return out.sort();
}

/**
 * Import a Claude Science skill into the repo's vendored `skills/<name>/`
 * (inverse of the export script). Locates `name` in the registry (org skills
 * first, then runtime built-ins), copies its whole tree, and reports what
 * landed. Idempotent by refusal: if `skills/<name>/` already exists it throws
 * unless `force` is passed, in which case the tree is overwritten.
 */
export async function importSkill(
  name: string,
  home: string,
  repoSkillsDir: string = REPO_SKILLS_DIR,
  opts: { readonly force?: boolean } = {},
): Promise<ImportResult> {
  const all = await listClaudeScienceSkills(home, { includeBuiltins: true });
  const skill = all.find((s) => s.name === name);
  if (!skill) {
    throw new Error(
      `Skill "${name}" not found in Claude Science registry under ${home}. ` +
        `Run \`labrat skills\` to list available skills.`,
    );
  }

  const target = join(repoSkillsDir, name);
  const exists = await isDir(target);
  if (exists && !opts.force) {
    throw new Error(
      `Skill "${name}" is already vendored at ${target}. Pass --force to overwrite.`,
    );
  }

  // --force means a true REPLACE: a bare cp(force) only overwrites matching
  // paths and would leave stale files from a prior import that no longer
  // exist in the source. Clear the target first so nothing orphaned survives.
  if (exists) {
    await rm(target, { recursive: true, force: true });
  }
  await cp(skill.dir, target, { recursive: true, force: true });
  const files = await walkFiles(skill.dir);

  return {
    name,
    source: skill.source,
    from: skill.dir,
    to: target,
    files,
    overwritten: exists,
  };
}
