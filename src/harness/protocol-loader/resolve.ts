import { access, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { RuntimeDep, SkillRequires } from "../../schema/index.js";

export function resolveClaudeScienceHome(
  override?: string,
): string {
  return (
    override ??
    process.env["CLAUDE_SCIENCE_HOME"] ??
    join(homedir(), ".claude-science")
  );
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Find protocol skill dir by scanning org skill registries. */
export async function findProtocolSkillDir(
  protocolName: string,
  claudeScienceHome: string,
): Promise<string> {
  const orgsRoot = join(claudeScienceHome, "orgs");
  if (!(await pathExists(orgsRoot))) {
    throw new Error(
      `Claude Science orgs directory not found: ${orgsRoot}`,
    );
  }

  const orgIds = await readdir(orgsRoot);
  for (const orgId of orgIds) {
    const candidate = join(orgsRoot, orgId, "skills", protocolName);
    const protocolYaml = join(candidate, "protocol.yaml");
    if (await pathExists(protocolYaml)) {
      return candidate;
    }
  }

  throw new Error(
    `Protocol skill "${protocolName}" not found under ${orgsRoot}/*/skills/`,
  );
}

/** Resolve a registry skill directory by name. */
export async function findRegistrySkillDir(
  skillName: string,
  claudeScienceHome: string,
): Promise<string> {
  const orgsRoot = join(claudeScienceHome, "orgs");
  const orgIds = await readdir(orgsRoot);
  for (const orgId of orgIds) {
    const candidate = join(orgsRoot, orgId, "skills", skillName);
    if (await pathExists(join(candidate, "SKILL.md"))) {
      return candidate;
    }
  }
  throw new Error(
    `Registry skill "${skillName}" not found under ${orgsRoot}/*/skills/`,
  );
}

export type ResolvedSkill = {
  readonly ref: string;
  readonly path: string;
  readonly kind: "resource" | "registry";
  readonly body: string;
  readonly requires?: SkillRequires;
};

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

function parseSkillFrontmatter(
  raw: string,
): { readonly frontmatter: Record<string, unknown>; readonly body: string } {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match?.[1]) {
    return { frontmatter: {}, body: raw };
  }
  const parsed = parseYaml(match[1]);
  const frontmatter =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  return { frontmatter, body: match[2] ?? "" };
}

function parseRequiresFromFrontmatter(
  frontmatter: Record<string, unknown>,
): SkillRequires | undefined {
  const requires = frontmatter["requires"];
  if (requires === undefined || requires === null) {
    return undefined;
  }
  if (typeof requires !== "object" || Array.isArray(requires)) {
    return undefined;
  }
  return requires as SkillRequires;
}

/** Resolve one skills[] entry from protocol.yaml. */
export async function resolveSkillRef(
  ref: string,
  protocolSkillDir: string,
  claudeScienceHome: string,
): Promise<ResolvedSkill> {
  if (ref.startsWith("resources/")) {
    const resourceName = ref.slice("resources/".length);
    const resourcePath = join(
      protocolSkillDir,
      "resources",
      `${resourceName}.md`,
    );
    if (!(await pathExists(resourcePath))) {
      throw new Error(`Protocol resource not found: ${ref} → ${resourcePath}`);
    }
    const raw = await readFile(resourcePath, "utf8");
    const { frontmatter, body } = parseSkillFrontmatter(raw);
    const requires = parseRequiresFromFrontmatter(frontmatter);
    return {
      ref,
      path: resourcePath,
      kind: "resource",
      body,
      ...(requires !== undefined ? { requires } : {}),
    };
  }

  const skillDir = await findRegistrySkillDir(ref, claudeScienceHome);
  const skillPath = join(skillDir, "SKILL.md");
  const raw = await readFile(skillPath, "utf8");
  const { frontmatter, body } = parseSkillFrontmatter(raw);
  const requires = parseRequiresFromFrontmatter(frontmatter);
  return {
    ref,
    path: skillPath,
    kind: "registry",
    body,
    ...(requires !== undefined ? { requires } : {}),
  };
}

export async function loadSkillMarkdown(
  skillName: string,
  claudeScienceHome: string,
): Promise<string> {
  const skillDir = await findRegistrySkillDir(skillName, claudeScienceHome);
  const raw = await readFile(join(skillDir, "SKILL.md"), "utf8");
  const { body } = parseSkillFrontmatter(raw);
  return body.trim();
}

/** Union runtime deps from resolved phase skills (worker + reviewer roles). */
export function collectSkillRuntimeDeps(
  skills: readonly ResolvedSkill[],
): RuntimeDep[] {
  const out: RuntimeDep[] = [];
  for (const skill of skills) {
    const req = skill.requires;
    if (!req) continue;
    if (req.worker?.runtime) {
      out.push(...req.worker.runtime);
    }
    if (req.reviewer?.runtime) {
      out.push(...req.reviewer.runtime);
    }
  }
  return out;
}

/** Union worker tool names from resolved phase skills. */
export function collectSkillWorkerTools(
  skills: readonly ResolvedSkill[],
): string[] {
  const out = new Set<string>();
  for (const skill of skills) {
    const tools = skill.requires?.worker?.tools;
    if (!tools) continue;
    for (const t of tools) {
      out.add(t);
    }
  }
  return [...out];
}
