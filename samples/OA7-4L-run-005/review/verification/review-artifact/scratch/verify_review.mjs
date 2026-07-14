import { checkReviewSite } from "/home/jimyao/gitrepos/labrat/src/review-site/check.js";
import { buildReviewSiteCsp } from "/home/jimyao/gitrepos/labrat/src/review-site/csp.js";

const taskDir = "/home/jimyao/gitrepos/labrat/tasks/task-2026-07-13-005";
const cdnAllowlist = [];
const report = await checkReviewSite({
  siteDir: taskDir + "/artifacts/review-site",
  cdnAllowlist,
  measurementsRoot: taskDir + "/artifacts",
  expectedSampleId: "task-2026-07-13-005",
  requireFidelity: true,
  contentSecurityPolicy: buildReviewSiteCsp(cdnAllowlist),
  landmarksAvailable: true,
});
console.log(JSON.stringify(report, null, 2));
