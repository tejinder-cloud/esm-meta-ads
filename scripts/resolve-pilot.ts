import { isMetaConfigured } from "../shared/env.js";
import { resolvePilot, PILOT_DAILY_BUDGET } from "../runtime/writelayer-proof.js";

/**
 * Step 1 of the Phase B live-write proof: resolve the pilot campaign from the
 * LIVE read layer and print it. Strictly read-only — no writes, no Slack.
 *
 *   npm run proof:resolve
 */

if (!isMetaConfigured()) {
  console.error("❌ Meta is not configured — set META_ACCESS_TOKEN and META_AD_ACCOUNT_ID in .env.");
  process.exit(1);
}

const { match, candidates } = await resolvePilot();

console.log(`\nPilot resolution — ACTIVE, name contains "New Zealand", ₹${PILOT_DAILY_BUDGET}/day:\n`);

if (candidates.length === 0) {
  console.log("  (none matched) — no ACTIVE New Zealand campaign at ₹1,000/day. Nothing to do.\n");
  process.exit(0);
}

if (candidates.length > 1) {
  console.log(`  ⚠️ ${candidates.length} matched — STOP, do not guess. Candidates:\n`);
  for (const c of candidates) {
    console.log(`    ${c.id}  ${c.status}  ₹${c.dailyBudget}/day  ${c.name}`);
  }
  console.log("");
  process.exit(0);
}

const c = match!;
console.log("  ✅ exactly one match:\n");
console.log(`    id:             ${c.id}`);
console.log(`    name:           ${c.name}`);
console.log(`    current status: ${c.status}`);
console.log(`    daily budget:   ₹${c.dailyBudget}/day\n`);
