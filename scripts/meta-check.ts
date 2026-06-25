import { getAccountInsights } from "../shared/meta.js";

const r = await getAccountInsights("last_7d");
console.log("\nMeta account — last 7 days");
console.log(`  Spend:       ₹${r.spend.toFixed(2)}`);
console.log(`  Leads:       ${r.leads}`);
console.log(`  Cost/lead:   ${r.cpl === null ? "—" : "₹" + r.cpl.toFixed(2)}`);
console.log(`  Impressions: ${r.impressions}`);
console.log(`  Clicks:      ${r.clicks}  (CTR ${r.ctr.toFixed(2)}%)`);
console.log("");
