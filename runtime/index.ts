import bolt from "@slack/bolt";
import { env, validateEnv, optionalFeatureStatus, describeEnv, MissingEnvError } from "../shared/env.js";
import { runAgent } from "../shared/agent.js";

const { App } = bolt;

/**
 * Runtime service for the ESM Overseas Meta Ads team.
 *
 * Listens to Slack (#esm-meta-ads, Socket Mode — no public URL needed) and
 * routes operator messages to the manager agent. This is the single process
 * Railway deploys (`npm run build` then `npm start`).
 *
 * For now the "manager" is a hello-world: it acknowledges the operator's
 * message in plain English using the Claude Agent SDK (model claude-opus-4-8)
 * with the ESM Overseas team context. Full delegation logic comes later.
 */

/**
 * Minimal manager prompt — a connectivity/round-trip test, not the real
 * delegation logic yet. The shared TEAM_CONTEXT (client, India/INR, gates) is
 * prepended automatically by runAgent().
 */
const MANAGER_SYSTEM_PROMPT = `You are the Manager of the ESM Overseas Meta Ads team and the operator's point of contact in Slack.
This is an early connectivity test, so do NOT do any real work or delegate to other agents yet.
Simply acknowledge the operator's message in plain, friendly English in 1-2 sentences, confirming you received it and are connected. Keep it short.`;

/** Print a clear, friendly message for missing required secrets, then exit. */
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
  // Fail fast with a friendly, complete list if any REQUIRED secret is missing
  // (Anthropic + Slack — the secrets needed to run right now).
  validateEnv();

  // Optional features (Meta, Google Sheets, Gemini) aren't wired up yet.
  // If their secrets are missing, note it and start anyway — don't block.
  for (const { feature } of optionalFeatureStatus()) {
    console.log(`ℹ️  ${feature} is not yet configured — that feature is unavailable for now. (Set its secrets in .env / Railway to enable it.)`);
  }

  const channelId = env.slackChannelId();

  const app = new App({
    token: env.slackBotToken(),
    appToken: env.slackAppToken(),
    signingSecret: env.slackSigningSecret(),
    socketMode: true,
  });

  // Identify ourselves so we can ignore our own messages (no self-reply loops).
  const auth = await app.client.auth.test();
  const botUserId = auth.user_id;

  /** Run the manager agent on the operator's text and reply in-thread. */
  async function respond(
    text: string,
    threadTs: string,
    say: (args: { thread_ts: string; text: string }) => Promise<unknown>,
  ): Promise<void> {
    const clean = text.trim();
    if (!clean) {
      await say({ thread_ts: threadTs, text: "Hi — what would you like the team to work on?" });
      return;
    }
    try {
      const reply = await runAgent({ systemPrompt: MANAGER_SYSTEM_PROMPT, prompt: clean });
      await say({ thread_ts: threadTs, text: reply || "(no response)" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await say({ thread_ts: threadTs, text: `⚠️ Something went wrong: ${message}` });
    }
  }

  // Plain messages posted in the channel.
  app.message(async ({ message, say }) => {
    // Only handle ordinary user messages (no edits, joins, bot_message, etc.).
    if (message.subtype !== undefined) return;
    if (message.channel !== channelId) return;
    // Ignore our own messages and any other bot's messages — prevents loops.
    if (message.bot_id || message.user === botUserId) return;
    // Mentions are handled by the app_mention listener; skip here to avoid a double reply.
    if (botUserId && (message.text ?? "").includes(`<@${botUserId}>`)) return;
    await respond(message.text ?? "", message.ts, say);
  });

  // Direct @mentions of the bot.
  app.event("app_mention", async ({ event, say }) => {
    if (event.channel !== channelId) return;
    if (event.bot_id) return; // ignore mentions originating from a bot
    const text = (event.text ?? "").replace(/<@[^>]+>/g, "").trim();
    await respond(text, event.ts, say);
  });

  await app.start();
  console.log(`✅ ESM Meta Ads runtime started. Listening on #esm-meta-ads (${channelId}) as ${botUserId}.`);
}

main().catch((err) => {
  if (err instanceof MissingEnvError) reportMissingSecrets(err);
  console.error("Failed to start runtime:", err);
  process.exit(1);
});
