import { join, resolve, sep } from "node:path";
import type { ReviewArtifactType } from "../../schema/index.js";

/**
 * Review-artifact template registry (design §3.D "Templates and output paths").
 *
 * Maps a review type — or an explicit registered `template` id — to a vendored
 * template directory beneath the `review-artifact-builder` skill. Resolution is
 * pure path math over a fixed allowlist: an id that is not registered, or that
 * would resolve outside the vendored `assets/templates/` root, is rejected. The
 * skill directory itself is resolved by the caller (D2) through the same
 * Claude Science registry machinery `protocol-loader/resolve.ts` uses — this
 * module never touches `process.cwd()` or the vendored checkout.
 */

/** The registered template ids, keyed by review type plus any named variants. */
export const REVIEW_TEMPLATE_IDS = [
  "spatial-3d",
  "quantitative",
  "document",
] as const;

export type ReviewTemplateId = (typeof REVIEW_TEMPLATE_IDS)[number];

/** The default template id a review `type` selects when no `template` is named. */
const DEFAULT_TEMPLATE_FOR_TYPE: Record<
  Exclude<ReviewArtifactType, "none">,
  ReviewTemplateId
> = {
  "spatial-3d": "spatial-3d",
  quantitative: "quantitative",
  document: "document",
};

/** The templates root relative to the resolved skill directory. */
export const TEMPLATES_SUBDIR = join("assets", "templates");

function isRegisteredId(id: string): id is ReviewTemplateId {
  return (REVIEW_TEMPLATE_IDS as readonly string[]).includes(id);
}

/**
 * Resolve the vendored template directory for a review artifact.
 *
 * @param skillDir Absolute path to the resolved `review-artifact-builder` skill.
 * @param spec `type` is the phase's resolved review type (never `none`); an
 *   optional `template` overrides the type's default with a registered id.
 * @returns Absolute path to the immutable template dir the harness will copy
 *   into the author's staging tree.
 * @throws When the type has no template, the `template` id is unregistered, or
 *   the resolved path would escape `assets/templates/` (defense in depth — ids
 *   are already an allowlist and the schema rejects path-like `template`s).
 */
export function resolveReviewTemplateDir(
  skillDir: string,
  spec: {
    readonly type: Exclude<ReviewArtifactType, "none">;
    readonly template?: string;
  },
): string {
  const id = spec.template ?? DEFAULT_TEMPLATE_FOR_TYPE[spec.type];
  if (id === undefined) {
    throw new Error(`no review template registered for type "${spec.type}"`);
  }
  if (!isRegisteredId(id)) {
    throw new Error(`unknown review template id "${id}"`);
  }

  const templatesRoot = resolve(skillDir, TEMPLATES_SUBDIR);
  const dir = resolve(templatesRoot, id);
  if (dir !== templatesRoot && !dir.startsWith(templatesRoot + sep)) {
    throw new Error(
      `review template "${id}" resolves outside the vendored templates root`,
    );
  }
  return dir;
}
