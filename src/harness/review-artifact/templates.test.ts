import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  REVIEW_TEMPLATE_IDS,
  resolveReviewTemplateDir,
} from "./templates.js";

// The real vendored skill dir, so the resolved template dirs actually exist.
const SKILL_DIR = fileURLToPath(
  new URL("../../../skills/review-artifact-builder", import.meta.url),
);

describe("resolveReviewTemplateDir", () => {
  it("resolves each review type to its existing vendored template dir", () => {
    for (const type of ["spatial-3d", "quantitative", "document"] as const) {
      const dir = resolveReviewTemplateDir(SKILL_DIR, { type });
      assert.equal(
        dir,
        join(SKILL_DIR, "assets", "templates", type),
      );
      assert.ok(
        existsSync(join(dir, "index.html")),
        `expected ${type}/index.html to exist`,
      );
    }
  });

  it("honors an explicit registered template id over the type default", () => {
    const dir = resolveReviewTemplateDir(SKILL_DIR, {
      type: "spatial-3d",
      template: "quantitative",
    });
    assert.equal(dir, join(SKILL_DIR, "assets", "templates", "quantitative"));
  });

  it("exposes exactly the three registered template ids", () => {
    assert.deepEqual([...REVIEW_TEMPLATE_IDS].sort(), [
      "document",
      "quantitative",
      "spatial-3d",
    ]);
  });

  it("rejects an unregistered template id", () => {
    assert.throws(
      () => resolveReviewTemplateDir(SKILL_DIR, { type: "spatial-3d", template: "nope" }),
      /unknown review template id/,
    );
  });

  it("rejects a traversal attempt in the template id (cannot escape)", () => {
    // Even if the schema failed to reject a path-like id, the registry does not
    // treat it as a known id and refuses to resolve outside the vendored root.
    for (const template of ["../../etc", "..", "a/b"]) {
      assert.throws(
        () => resolveReviewTemplateDir(SKILL_DIR, { type: "document", template }),
        /unknown review template id/,
        `template "${template}" should be rejected`,
      );
    }
  });
});
