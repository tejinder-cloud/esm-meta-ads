import http from "node:http";
import bolt from "@slack/bolt";
import type { SayFn } from "@slack/bolt";
import { env, validateEnv, optionalFeatureStatus, describeEnv, isSheetsConfigured, MissingEnvError } from "../shared/env.js";
import { runAgent } from "../shared/agent.js";
import {
  isMediaPlanRequest,
  stripPlanCommand,
  runMediaPlanner,
  saveApprovedPlan,
} from "../agents/media-planner/index.js";

const { App } = bolt;

/**
 * Runtime service for the ESM Overseas Meta Ads team.
 *
 * Listens to Slack (#esm-meta-ads, Socket Mode) and routes operator messages to
 * the manager, which delegates to specialist agents. Currently wired up:
 *   - Manager: a hello-world acknowledgement for general messages.
 *   - Media Planner (Agent 1): media-plan / budget / forecast requests.
 *
 * Conversations are stateful per Slack thread (in-memory): a request starts a
 * thread, follow-up replies in that thread continue the same agent. This keeps
 * the "ask for missing inputs → propose → approve/change" flow coherent.
 */

const MANAGER_SYSTEM_PROMPT = `You are the Manager of the ESM Overseas Meta Ads team and the operator's point of contact in Slack.
This is a general message (not a media-plan request). Acknowledge it briefly in plain, friendly English in 1-2 sentences, and mention they can ask you to create a media plan / budget / forecast (or start a message with /plan) to engage the Media Planner. Keep it short.`;

// ---------------------------------------------------------------------------
// Conversation state (in-memory, keyed by Slack thread root timestamp).
// ---------------------------------------------------------------------------

type AgentKind = "media-planner";
type Phase = "gathering" | "proposed";

interface Turn {
  who: "Operator" | "Media Planner";
  text: string;
}

interface Conversation {
  agent: AgentKind;
  phase: Phase;
  transcript: Turn[];
  lastPlan?: string;
}

const conversations = new Map<string, Conversation>();

function renderTranscript(turns: Turn[]): string {
  return turns.map((t) => `${t.who}: ${t.text}`).join("\n\n");
}

// ---------------------------------------------------------------------------
// Health endpoint (for Railway) — see startHealthServer below.
// ---------------------------------------------------------------------------

function startHealthServer(): void {
  const port = Number(process.env.PORT) || 3000;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
  });
  server.listen(port, () => {
    console.log(`🩺 Health endpoint listening on :${port} (returns 200 OK).`);
  });
}

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
  validateEnv();

  for (const { feature } of optionalFeatureStatus()) {
    console.log(`ℹ️  ${feature} is not yet configured — that feature is unavailable for now. (Set its secrets in .env / Railway to enable it.)`);
  }

  startHealthServer();

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

  const post = (say: SayFn, threadRoot: string, text: string) =>
    say({ thread_ts: threadRoot, text: text || "(no response)" });

  // ----- Media Planner flow ------------------------------------------------

  /** Run/continue the planner over the transcript and post its reply. */
  async function runPlannerTurn(convo: Conversation, operatorText: string, threadRoot: string, say: SayFn) {
    convo.transcript.push({ who: "Operator", text: operatorText });
    const result = await runMediaPlanner(renderTranscript(convo.transcript));
    convo.transcript.push({ who: "Media Planner", text: result.message });
    if (result.status === "proposed") {
      convo.phase = "proposed";
      convo.lastPlan = result.message;
    } else {
      convo.phase = "gathering";
    }
    await post(say, threadRoot, result.message);
  }

  /** Handle the operator's approval of a proposed plan. */
  async function finalizeApproval(threadRoot: string, userId: string, plan: string, say: SayFn) {
    if (isSheetsConfigured()) {
      try {
        await saveApprovedPlan(`<@${userId}>`, plan);
        await post(say, threadRoot, "✅ Media plan approved — saved to the shared Google Sheet (tab: media-plans).");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await post(say, threadRoot, `✅ Media plan approved.\n⚠️ Saving to Google Sheets failed: ${msg}\nThe approved plan is preserved above in this thread.`);
      }
    } else {
      await post(
        say,
        threadRoot,
        `📋 *Approved media plan (final)*\n\n${plan}\n\n_Note: persistent storage (Google Sheets) isn't connected yet, so this message is the system of record. Set the Google Sheets secrets to auto-save future plans._`,
      );
      await post(say, threadRoot, "✅ Media plan approved");
    }
    conversations.delete(threadRoot);
  }

  // ----- Central dispatch --------------------------------------------------

  async function handleTurn(text: string, threadRoot: string, userId: string, say: SayFn) {
    const operatorText = text.trim();
    if (!operatorText) {
      await post(say, threadRoot, "Hi — what would you like the team to work on? (Try a media plan: describe the campaign, or start with /plan.)");
      return;
    }

    const existing = conversations.get(threadRoot);

    // --- New conversation: route ---
    if (!existing) {
      if (isMediaPlanRequest(operatorText)) {
        const convo: Conversation = { agent: "media-planner", phase: "gathering", transcript: [] };
        conversations.set(threadRoot, convo);
        await runPlannerTurn(convo, stripPlanCommand(operatorText), threadRoot, say);
      } else {
        const reply = await runAgent({ systemPrompt: MANAGER_SYSTEM_PROMPT, prompt: operatorText });
        await post(say, threadRoot, reply);
      }
      return;
    }

    // --- Continuing a Media Planner conversation ---
    if (existing.agent === "media-planner") {
      // Approval gate: only meaningful once a plan has been proposed.
      if (existing.phase === "proposed" && /^approve\b/i.test(operatorText)) {
        await finalizeApproval(threadRoot, userId, existing.lastPlan ?? "(no plan on record)", say);
        return;
      }
      // Otherwise (gathering input, a "change: ..." request, or a clarification)
      // → run the planner again with the new operator turn appended.
      await runPlannerTurn(existing, operatorText, threadRoot, say);
    }
  }

  /** Wrap dispatch so any failure posts a friendly note instead of crashing. */
  async function safeHandle(text: string, threadRoot: string, userId: string, say: SayFn) {
    try {
      await handleTurn(text, threadRoot, userId, say);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await post(say, threadRoot, `⚠️ Something went wrong: ${msg}`);
    }
  }

  // ----- Slack event wiring ------------------------------------------------

  // Plain messages in the channel — only used to CONTINUE an existing thread.
  app.message(async ({ message, say }) => {
    if (message.subtype !== undefined) return;
    if (message.channel !== channelId) return;
    if (message.bot_id || message.user === botUserId) return;
    // Mentions are handled by app_mention; skip here to avoid double replies.
    if (botUserId && (message.text ?? "").includes(`<@${botUserId}>`)) return;
    const threadRoot = message.thread_ts ?? message.ts;
    if (!conversations.has(threadRoot)) return; // don't start new convos from plain messages
    await safeHandle(message.text ?? "", threadRoot, message.user ?? "", say);
  });

  // @mentions of the bot — start a new conversation or continue one in-thread.
  app.event("app_mention", async ({ event, say }) => {
    if (event.channel !== channelId) return;
    if (event.bot_id) return;
    const threadRoot = event.thread_ts ?? event.ts;
    const text = (event.text ?? "").replace(/<@[^>]+>/g, "").trim();
    await safeHandle(text, threadRoot, event.user ?? "", say);
  });

  await app.start();
  console.log(`✅ ESM Meta Ads runtime started. Listening on #esm-meta-ads (${channelId}) as ${botUserId}.`);
}

main().catch((err) => {
  if (err instanceof MissingEnvError) reportMissingSecrets(err);
  console.error("Failed to start runtime:", err);
  process.exit(1);
});
