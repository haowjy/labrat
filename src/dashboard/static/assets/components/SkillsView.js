import { html, useEffect, useState } from "../vendor/preact-htm.js";
import { getJSON } from "../lib/api.js";

/**
 * Claude Science skill browser. Reads GET /api/claude-science/skills and
 * organizes the registry into two tiers:
 *
 *   1. Protocols — every runnable skill (carries a protocol.yaml LabRat can
 *      execute). Each protocol nests a collapsible "Depends on" accordion
 *      listing its `parentSkills` (registry skills it builds on).
 *   2. Other skills — registry skills that are neither runnable nor named in
 *      any protocol's parentSkills (dependency skills surface under their
 *      protocol, not here).
 *
 * Read-only: browsing only. Importing a skill writes into the repo's source
 * tree (skills/), a dev-only vendoring action that has no place in this
 * researcher-facing view.
 */

function DependsOn({ parentSkills, byName }) {
  if (parentSkills.length === 0) return null;
  return html`
    <details class="skill-depends">
      <summary>Depends on (${parentSkills.length})</summary>
      <ul class="skill-dep-list">
        ${parentSkills.map((name) => {
          const dep = byName.get(name);
          return html`
            <li class="skill-dep" key=${name}>
              <span class="skill-dep-name">${name}</span>
              ${dep && dep.description
                ? html`<span class="skill-dep-desc">${dep.description}</span>`
                : null}
            </li>
          `;
        })}
      </ul>
    </details>
  `;
}

function SkillCard({ skill, byName }) {
  return html`
    <div class="skill-row">
      <div class="skill-row-head">
        <span class="skill-name">${skill.name}</span>
        <span class="skill-source">${skill.source}</span>
        ${skill.vendored
          ? html`<span class="skill-badges"
              ><span class="pill pill-running">vendored</span></span
            >`
          : null}
      </div>
      ${skill.description
        ? html`<div class="skill-desc">${skill.description}</div>`
        : null}
      ${byName
        ? html`<${DependsOn} parentSkills=${skill.parentSkills} byName=${byName} />`
        : null}
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

  const byName = new Map(skills.map((s) => [s.name, s]));
  const protocols = skills.filter((s) => s.runnable === true);
  const dependencyNames = new Set(protocols.flatMap((p) => p.parentSkills));
  const others = skills.filter(
    (s) => s.runnable !== true && !dependencyNames.has(s.name),
  );

  return html`
    <div class="skills-view">
      <div class="skills-head">
        <h2>Claude Science skills</h2>
        <p class="note">
          Browse the Claude Science registry. Protocols are the runnable
          pipelines LabRat executes; expand a protocol to see the skills it
          depends on. Everything else lives under "Other skills" below.
        </p>
      </div>

      <div class="skills-section">
        <h3 class="skills-section-head">Protocols</h3>
        ${protocols.length === 0
          ? html`<div class="empty">No runnable protocols found.</div>`
          : html`<div class="skill-list">
              ${protocols.map(
                (s) =>
                  html`<${SkillCard}
                    key=${`${s.source}/${s.name}`}
                    skill=${s}
                    byName=${byName}
                  />`,
              )}
            </div>`}
      </div>

      ${others.length > 0
        ? html`<div class="skills-section">
            <h3 class="skills-section-head">Other skills</h3>
            <div class="skill-list">
              ${others.map(
                (s) => html`<${SkillCard} key=${`${s.source}/${s.name}`} skill=${s} />`,
              )}
            </div>
          </div>`
        : null}
    </div>
  `;
}
