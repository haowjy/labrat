import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  importSkill,
  listClaudeScienceSkills,
  listVendoredSkillNames,
  skillDescription,
} from "./registry.js";

/*
 * The import bridge is the demo's "walk Claude Science, find a skill, bring it
 * into LabRat" path. These tests pin the two contracts that make it safe: the
 * registry reader's classification (source / runnable / description) against a
 * checked-in fixture registry, and importSkill's copy + no-clobber guard.
 */

const FIXTURE_REGISTRY = fileURLToPath(
  new URL("../../../fixtures/claude-science-registry/", import.meta.url),
);

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "labrat-cs-registry-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("skillDescription", () => {
  it("takes the first (substantial) sentence of a frontmatter description", () => {
    const raw =
      "---\nname: x\ndescription: >\n  Predict something useful from an input file.\n  A second sentence that is dropped.\n---\n# X";
    assert.equal(skillDescription(raw), "Predict something useful from an input file.");
  });

  it("keeps the whole value when the first sentence is a short fragment", () => {
    const raw = "---\nname: x\ndescription: The Tang et al. protocol for knees.\n---\n# X";
    assert.equal(skillDescription(raw), "The Tang et al. protocol for knees.");
  });

  it("falls back to the first prose line when no description field", () => {
    const raw = "---\nname: x\n---\n# Heading\n\nFirst prose line.";
    assert.equal(skillDescription(raw), "First prose line.");
  });

  it("falls back to the heading when there is no prose", () => {
    assert.equal(skillDescription("# Just A Heading"), "Just A Heading");
  });
});

describe("listClaudeScienceSkills", () => {
  it("lists org skills with runnable + description, builtins excluded by default", async () => {
    const skills = await listClaudeScienceSkills(FIXTURE_REGISTRY);
    assert.deepEqual(
      skills.map((s) => s.name),
      ["prose-skill", "runnable-skill"],
    );

    const runnable = skills.find((s) => s.name === "runnable-skill")!;
    assert.equal(runnable.source, "org-alpha");
    assert.equal(runnable.builtin, false);
    assert.equal(runnable.runnable, true);
    assert.equal(runnable.description, "A runnable fixture protocol for exercising the reader.");

    const prose = skills.find((s) => s.name === "prose-skill")!;
    assert.equal(prose.runnable, false);
    assert.equal(prose.description, "First prose line of the body.");
  });

  it("includes runtime built-ins when asked, tagged builtin", async () => {
    const skills = await listClaudeScienceSkills(FIXTURE_REGISTRY, {
      includeBuiltins: true,
    });
    const builtin = skills.find((s) => s.name === "builtin-skill")!;
    assert.equal(builtin.builtin, true);
    assert.equal(builtin.source, "builtin");
    // Builtins sort after org skills.
    assert.equal(skills[skills.length - 1]!.name, "builtin-skill");
  });

  it("returns [] for a home with no orgs/ dir", async () => {
    assert.deepEqual(await listClaudeScienceSkills("/does/not/exist"), []);
  });
});

describe("importSkill", () => {
  it("copies the whole skill tree into the vendored dir and reports files", async () => {
    await withTmp(async (repoSkills) => {
      const result = await importSkill("runnable-skill", FIXTURE_REGISTRY, repoSkills);
      assert.equal(result.name, "runnable-skill");
      assert.equal(result.source, "org-alpha");
      assert.equal(result.overwritten, false);
      assert.deepEqual(
        [...result.files].sort(),
        ["SKILL.md", "protocol.yaml", "resources/notes.md"],
      );
      const copied = await readFile(join(repoSkills, "runnable-skill", "protocol.yaml"), "utf8");
      assert.match(copied, /phases/);
    });
  });

  it("refuses to clobber an existing vendored dir without force", async () => {
    await withTmp(async (repoSkills) => {
      await mkdir(join(repoSkills, "runnable-skill"), { recursive: true });
      await writeFile(join(repoSkills, "runnable-skill", "keep.txt"), "mine");
      await assert.rejects(
        () => importSkill("runnable-skill", FIXTURE_REGISTRY, repoSkills),
        /already vendored/,
      );
      // Guard did not touch the existing dir.
      assert.equal(await readFile(join(repoSkills, "runnable-skill", "keep.txt"), "utf8"), "mine");
    });
  });

  it("overwrites when force is passed and flags overwritten", async () => {
    await withTmp(async (repoSkills) => {
      await mkdir(join(repoSkills, "runnable-skill"), { recursive: true });
      const result = await importSkill("runnable-skill", FIXTURE_REGISTRY, repoSkills, {
        force: true,
      });
      assert.equal(result.overwritten, true);
      await readFile(join(repoSkills, "runnable-skill", "SKILL.md"), "utf8");
    });
  });

  it("force is a true replace — stale files from a prior import do not survive", async () => {
    await withTmp(async (repoSkills) => {
      // Simulate a prior import that vendored a file the source has since deleted.
      await mkdir(join(repoSkills, "runnable-skill", "resources"), { recursive: true });
      await writeFile(join(repoSkills, "runnable-skill", "stale.md"), "gone upstream");
      await writeFile(join(repoSkills, "runnable-skill", "resources", "stale.py"), "x = 1");

      await importSkill("runnable-skill", FIXTURE_REGISTRY, repoSkills, { force: true });

      // Current source files landed…
      await readFile(join(repoSkills, "runnable-skill", "SKILL.md"), "utf8");
      // …and the orphans are gone, not merged over.
      await assert.rejects(() =>
        readFile(join(repoSkills, "runnable-skill", "stale.md"), "utf8"),
      );
      await assert.rejects(() =>
        readFile(join(repoSkills, "runnable-skill", "resources", "stale.py"), "utf8"),
      );
    });
  });

  it("throws a helpful error for an unknown skill", async () => {
    await withTmp(async (repoSkills) => {
      await assert.rejects(
        () => importSkill("no-such-skill", FIXTURE_REGISTRY, repoSkills),
        /not found in Claude Science registry/,
      );
    });
  });
});

describe("listVendoredSkillNames", () => {
  it("returns the set of subdir names", async () => {
    await withTmp(async (dir) => {
      await mkdir(join(dir, "a"));
      await mkdir(join(dir, "b"));
      await writeFile(join(dir, "not-a-dir.txt"), "");
      const names = await listVendoredSkillNames(dir);
      assert.deepEqual([...names].sort(), ["a", "b"]);
    });
  });
});
