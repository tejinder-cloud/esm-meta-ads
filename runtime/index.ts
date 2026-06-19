import bolt from "@slack/bolt";
import { env, validateEnv, describeEnv, MissingEnvError } from "../shared/env.js";
import { runAgent } from "../shared/agent.js";

const { App } = bolt;

/**
 * Runtime service for the ESM Overseas Meta Ads team.
 *
 * Listens to Slack (#esm-meta-ads, Socket Mode — no public URL needed) and
 * routes operator messages to the manager agent, which orchestrates the rest
 * of the team. This is the single process Railway deploys
 * (`npm run build` then `npm start`).
 */

/** The manager agent's role. It orchestrates the other nine agents. */
const MANAGER_SYSTEM_PROMPT = `You are the Manager of the ESM Overseas Meta Ads team.
You are the operator's single point of contact in Slack. Understand what the operator wants,
delegate to the right specialist agents (media planner, competitive intel, creative strategist,
image production, campaign builder, video production, tracking & data, analyst, optimizer), and
report back clearly. Enforce the approval gates: stop and ask the operator before using generated
images, before any budget/spend/scaling/kill decision, and do not start work without a brief.`;

/** Print a clear, friendly message for missing secrets, then exit. */
function reportMissingSecrets(err: MissingEnvError): never {
  console.error("\n❌  Cannot start the ESM Meta Ads runtime — required secret(s) are not set:\n");
  for (const name of err.missing) {
    console.error(`   • ${name} — ${describeEnv(name)}`);
  }
  console.error(
    "\nFix: copy .env.example to .env and fill in these values (local), " +
      "or set them as Railway environment variables (production).\n",
  );
  process.exit(1);
}

async function main() {
  // Fail fast with a friendly, complete list if any secret is missing.
  validateEnv();

  const channelId = env.slackChannelId();

  const app = new App({
    token: env.slackBotToken(),
    appToken: env.slackAppToken(),
    signingSecret: env.slackSigningSecret(),
    socketMode: true,
  });

  // Respond when the operator mentions the bot in the channel.
  app.event("app_mention", async ({ event, say }) => {
    if (event.channel !== channelId) return;

    const text = (event.text ?? "").replace(/<@[^>]+>/g, "").trim();
    if (!text) {
      await say({ thread_ts: event.ts, text: "Hi — what would you like the team to work on?" });
      return;
    }

    try {
      const reply = await runAgent({ systemPrompt: MANAGER_SYSTEM_PROMPT, prompt: text });
      await say({ thread_ts: event.ts, text: reply || "(no response)" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await say({ thread_ts: event.ts, text: `⚠️ Something went wrong: ${message}` });
    }
  });

  await app.start();
  console.log(`✅ ESM Meta Ads runtime started. Listening on #esm-meta-ads (${channelId}).`);
}

main().catch((err) => {
  if (err instanceof MissingEnvError) reportMissingSecrets(err);
  console.error("Failed to start runtime:", err);
  process.exit(1);
});
