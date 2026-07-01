import { isMetaConfigured } from "../shared/env.js";
import { computeQuality, qualityDigestLine, campaignTable } from "../agents/tracking-data/index.js";

/**
 * Manual verification hook for the read-only quality layer (`npm run quality:check`).
 *
 * Prints the trailing-30-day account figures (spend, leads, qualified, CPL, CPQL)
 * and the per-campaign directional CPQL table — no Slack post, no Sheet write.
 * Strictly read-only toward Meta.
 *
 * Cross-check: `qualified_30d` here is the ad-ATTRIBUTED Purchase count from the
 * Insights API (28d click + view). Events Manager shows the RAW CAPI Purchase
 * event count (~49 for Jun 2–29). Attributed < raw is expected — the gap is CAPI
 * match quality (currently imperfect). If attributed is 0 or wildly off, stop and
 * investigate the CAPI setup before trusting CPQL.
 */

function inr(n: number | null): string {
  return n == null ? "—" : "₹" + Math.round(n).toLocaleString("en-IN");
}

if (!isMetaConfigured()) {
  console.error("❌ Meta is not configured — set META_ACCESS_TOKEN and META_AD_ACCOUNT_ID in .env.");
  process.exit(1);
}

const q = await computeQuality();

console.log("\n=== Quality layer — trailing 30 days (account, ₹) ===\n");
console.log(`  spend_30d:      ${inr(q.spend30)}`);
console.log(`  leads_30d:      ${q.leads30}`);
console.log(`  qualified_30d:  ${q.qualified30}${q.detected ? "" : "   ⚠️ signal not detected"}`);
console.log(`  CPL_30d:        ${inr(q.cpl30)}`);
console.log(`  CPQL_30d:       ${inr(q.cpql30)}`);
console.log(
  `  qualified_rate: ${q.qualifiedRate == null ? "—" : (q.qualifiedRate * 100).toFixed(1) + "%"} (qualified / leads)`,
);

console.log("\n=== Digest line (as posted to Slack) ===\n");
console.log("  " + qualityDigestLine(q));

console.log("\n=== Per-campaign CPQL (directional — depends on CAPI match quality) ===\n");
console.log(campaignTable(q));

console.log(
  "\nCross-check: `qualified_30d` is the ad-attributed Purchase count (28d click+view).",
);
console.log(
  "Events Manager shows the RAW CAPI Purchase events (~49 for Jun 2–29). Attributed < raw",
);
console.log("is expected (CAPI match quality). If it's 0 or way off, stop and check CAPI.\n");
