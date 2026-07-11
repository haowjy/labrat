import { html, useEffect, useState } from "../vendor/preact-htm.js";
import { getJSON } from "../lib/api.js";

/**
 * Claude Science skill browser (LabRat ↔ Claude Science import bridge). Reads
 * GET /api/claude-science/skills and lists every registry skill with its
 * source, a "runnable" badge (has a protocol.yaml LabRat can execute), and a
 * "vendored" badge (already copied into the repo's skills/ dir).
 *
 * Import is READ-ONLY here by design: bringing a skill in writes into the
 * repo's source tree (skills/<name>/), which is a developer/CLI action, not a
 * dashboard mutation — the dashboard is Process B and only reads disk under the
 * task tree. So the Import affordance surfaces the exact CLI command to run
 * (`labrat import-skill <name>`) rather than POSTing. Once imported, a page
 * refresh re-reads the listing and the row flips to "vendored".
 */
function badges(skill) {
  const items = [];
  if (skill.runnable) items.push(html`<span class="pill pill-pass">runnable</span>`);
  if (skill.vendored) items.push(html`<span class="pill pill-running">vendored</span>`);
  if (skill.builtin) items.push(html`<span class="pill pill-skip">builtin</span>`);
  return items;
}

function SkillRow({ skill }) {
  const cmd = `labrat import-skill ${skill.name}`;
  return html`
    <div class="skill-row">
      <div class="skill-row-head">
        <span class="skill-name">${skill.name}</span>
        <span class="skill-source">${skill.source}</span>
        <span class="skill-badges">${badges(skill)}</span>
      </div>
      ${skill.description
        ? html`<div class="skill-desc">${skill.description}</div>`
        : null}
      <div class="skill-import">
        ${skill.vendored
          ? html`<span class="note">Imported into skills/</span>`
          : html`<code class="skill-cmd" title="Run this in the repo to import">${cmd}</code>`}
      </div>
    </div>
  `;
}

export function SkillsView() {
  const [skills, setSkills] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getJSON("/api/claude-science/skills")
      .then((s) => {
        if (!cancelled) setSkills(s);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load Claude Science skills.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return html`<div class="empty">${error}</div>`;
  if (skills === null) return html`<div class="empty">Loading skills…</div>`;
  if (skills.length === 0) return html`<div class="empty">No Claude Science skills found.</div>`;

  return html`
    <div class="skills-view">
      <div class="skills-head">
        <h2>Claude Science skills</h2>
        <p class="note">
          Browse the registry. Runnable skills carry a protocol.yaml LabRat can
          execute; vendored skills are already in the repo's skills/ dir. Import
          a skill with the shown CLI command.
        </p>
      </div>
      <div class="skill-list">
        ${skills.map((s) => html`<${SkillRow} key=${`${s.source}/${s.name}`} skill=${s} />`)}
      </div>
    </div>
  `;
}
