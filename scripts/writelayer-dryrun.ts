import { isMetaConfigured } from "../shared/env.js";
import {
  listCampaigns,
  pauseCampaign,
  resumeCampaign,
  setCampaignDailyBudget,
} from "../shared/meta.js";

/**
 * Manual hook for the Meta WRITE layer in DRY-RUN (`npm run writelayer:dryrun`).
 *
 * With NO argument: lists the account's campaigns (read-only) so you can pick one.
 * With a campaign ID: prints the exact request each of the three write actions
 * WOULD POST — pause, resume, and set daily budget ₹1,000 — sending NOTHING.
 *
 *   npm run writelayer:dryrun                 # list campaigns
 *   npm run writelayer:dryrun -- <campaignId> # dry-run all three actions
 *
 * Every write function is called with its default execute=false, so this touches
 * the account only via reads (to fetch current status/budget for the printout).
 */

if (!isMetaConfigured()) {
  console.error("❌ Meta is not configured — set META_ACCESS_TOKEN and META_AD_ACCOUNT_ID in .env.");
  process.exit(1);
}

const campaignId = process.argv[2];

if (!campaignId) {
  const camps = await listCampaigns();
  console.log("\nNo campaign ID given. Account campaigns (read-only) — pass one as an arg:\n");
  for (const c of camps) {
    const budget = c.dailyBudget == null ? "budget: ad-set level" : `₹${c.dailyBudget}/day`;
    console.log(`  ${c.id}  ${c.status.padEnd(9)} ${budget.padEnd(22)} ${c.name}`);
  }
  console.log(`\n${camps.length} campaign(s). Re-run: npm run writelayer:dryrun -- <campaignId>\n`);
} else {
  console.log(`\nDRY-RUN write layer for campaign ${campaignId} — nothing will be sent to Meta.\n`);
  // All three default to execute=false → they print the intended request only.
  await pauseCampaign(campaignId);
  await resumeCampaign(campaignId);
  await setCampaignDailyBudget(campaignId, 1000);
  console.log("\n✅ Dry-run complete — 0 writes performed (execute=false throughout).\n");
}
