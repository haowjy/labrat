import {
  listClaudeScienceSkills,
  listVendoredSkillNames,
} from "../../harness/claude-science/registry.js";

/**
 * GET /api/claude-science/skills backing loader. Composes the harness registry
 * reader (browse the Claude Science registry) with the repo's vendored-skills
 * set (what's already imported) into one flat listing the dashboard renders.
 *
 * Read-only: this surface lists skills; import is a CLI action (`labrat
 * import-skill`), not a dashboard write — see the component note. `scienceHome`
 * is threaded from the single config seam via DashboardConfig, never read from
 * env here.
 */
export type ClaudeScienceSkillView = {
  readonly name: string;
  readonly source: string;
  readonly builtin: boolean;
  readonly runnable: boolean;
  readonly description: string;
  /** Already copied into the repo's skills/ dir. */
  readonly vendored: boolean;
};

export async function listClaudeScienceSkillsView(
  scienceHome: string,
): Promise<ClaudeScienceSkillView[]> {
  const [skills, vendored] = await Promise.all([
    listClaudeScienceSkills(scienceHome, { includeBuiltins: true }),
    listVendoredSkillNames(),
  ]);
  return skills.map((s) => ({
    name: s.name,
    source: s.source,
    builtin: s.builtin,
    runnable: s.runnable,
    description: s.description,
    vendored: vendored.has(s.name),
  }));
}
