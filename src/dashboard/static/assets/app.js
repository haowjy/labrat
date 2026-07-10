/*
 * LabRat dashboard client — Preact trusted shell entry point. Boots the
 * component tree from components/App.js into #app. All real logic (data
 * loaders, the review-chain/provenance/reviews views, the F1 postMessage
 * bridge, the verdict panel) lives under components/ and lib/; this file's
 * only job is mounting.
 *
 * index.html loads review-site.js (a classic script, see that file) BEFORE
 * this module, so `window.REVIEW_SANDBOX` / `window.reviewSiteSrc` are
 * already global by the time ReviewsView reads them — same boot order the
 * vanilla shell used, just consumed as `window.X` from a module instead of
 * an implicit shared global-scope reference from another classic script.
 */
import { html, render } from "./vendor/preact-htm.js";
import { App } from "./components/App.js";

render(html`<${App} />`, document.getElementById("app"));
