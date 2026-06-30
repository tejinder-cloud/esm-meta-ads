import { WebClient } from "@slack/web-api";
import { env, validateEnv, isMetaConfigured } from "../shared/env.js";
import { runDailyReport } from "../agents/analyst/index.js";

/**
 * Manual test hook for the Analyst's daily report. Runs the digest ONCE right
 * now: posts to #esm-meta-ads and appends the day's row to the "daily-report"
 * Sheet tab — no waiting for the 08:00 IST schedule.
 *
 * `force: true` so it always posts even if today's row already exists (the Sheet
 * append still won't duplicate that row). Read-only toward Meta throughout.
 */

validateEnv();
if (!isMetaConfigured()) {
  console.error("❌ Meta is not configured — set META_ACCESS_TOKEN and META_AD_ACCOUNT_ID in .env to run the Analyst.");
  process.exit(1);
}

const slack = new WebClient(env.slackBotToken());
const channel = env.slackChannelId();

const result = await runDailyReport({
  postMessage: async (text) => {
    await slack.chat.postMessage({ channel, text });
  },
  force: true,
});

console.log("\n--- analyst:run result ---");
console.log(`date (yesterday, IST): ${result.dateKey}`);
console.log(`posted to Slack:       ${result.posted ? "yes" : "no"}${result.reason ? ` (${result.reason})` : ""}`);
if (result.error) console.log(`error:                 ${result.error}`);
if (result.message) {
  console.log("\n--- exact Slack message posted ---\n");
  console.log(result.message);
  console.log("\n----------------------------------");
}
