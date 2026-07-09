import { fileURLToPath } from "node:url";

/**
 * Absolute path to the self-contained static assets (HTML/CSS/JS). No CDN, no
 * external fonts — everything the review-chain UI needs ships in `assets/`.
 * Resolved from this module's URL so it works whether run via tsx or compiled.
 */
export const STATIC_ROOT = fileURLToPath(new URL("./assets/", import.meta.url));
