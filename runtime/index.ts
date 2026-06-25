import http from "node:http";
import bolt from "@slack/bolt";
import type { SayFn } from "@slack/bolt";
import { env, validateEnv, optionalFeatureStatus, describeEnv, isSheetsConfigured, MissingEnvError } from "../shared/env.js";
import { runAgent } from "../shared/agent.js";
import {
  isMediaPlanRequest,
  stripPlanCommand,
  runMediaPlanner,
  decideOperatorIntent,
  saveApprovedPlan,
} from "../agents/media-planner/index.js";
import {
  ensureApprovalsTab,
  savePendingApproval,
  listPendingApprovals,
  clearPendingApproval,
} from "../shared/approvals.js";

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

/** Call-to-action appended to a freshly proposed plan (not part of the plan body). */
const PROPOSE_FOOTER = "Reply *approve* to lock this plan in, or *change: …* to tell me what to adjust.";

function renderTranscript(turns: Turn[]): string {
  return turns.map((t) => `${t.who}: ${t.text}`).join("\n\n");
}

/**
 * Log (never throw) when a durable approval-store call fails. Durability is
 * best-effort: a Sheets hiccup must never crash the runtime or block the
 * operator reply — the in-memory Map keeps the conversation working regardless.
 */
function warnStore(action: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(`⚠️  Approval store ${action} failed (continuing in-memory): ${msg}`);
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
      // Append the approve/change call-to-action only on a live proposal.
      await post(say, threadRoot, `${result.message}\n\n${PROPOSE_FOOTER}`);
      // Mirror the now-pending approval to the Sheet so it survives a restart.
      // Done after the reply is posted; failure is logged, never blocks.
      try {
        await savePendingApproval({
          threadRoot,
          agent: convo.agent,
          phase: convo.phase,
          lastPlan: convo.lastPlan,
          transcript: convo.transcript,
        });
      } catch (err) {
        warnStore("save", err);
      }
    } else {
      convo.phase = "gathering";
      await post(say, threadRoot, result.message);
    }
  }

  /**
   * Handle a clean approval: post the locked plan as the final record (no
   * approve/change prompt — it reads as final), then a one-line manager record.
   */
  async function finalizeApproval(threadRoot: string, userId: string, plan: string, say: SayFn) {
    let lockedFooter: string;
    if (isSheetsConfigured()) {
      try {
        await saveApprovedPlan(`<@${userId}>`, plan);
        lockedFooter = "\n\n🔒 *This plan is locked and approved.* Saved to the shared Google Sheet (tab: media-plans).";
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        lockedFooter = `\n\n🔒 *This plan is locked and approved.* ⚠️ Saving to Google Sheets failed (${msg}), so this message is the record for now.`;
      }
    } else {
      lockedFooter =
        "\n\n🔒 *This plan is locked and approved.* Persistent storage (Google Sheets) isn't connected yet, so this message is the official record of the approved plan.";
    }
    await post(say, threadRoot, `📋 *Approved media plan (final)*\n\n${plan}${lockedFooter}`);
    await post(say, threadRoot, "✅ Media plan approved");
    conversations.delete(threadRoot);
    // Conversation complete → drop its durable pending-approval row.
    try {
      await clearPendingApproval(threadRoot);
    } catch (err) {
      warnStore("clear", err);
    }
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
      // Approval gate only applies once a plan has been proposed.
      if (existing.phase === "proposed") {
        const decision = await decideOperatorIntent(operatorText);
        if (decision === "approve") {
          // Clean approval, no change instructions → lock it in.
          await finalizeApproval(threadRoot, userId, existing.lastPlan ?? "(no plan on record)", say);
          return;
        }
        if (decision === "ambiguous") {
          // Don't guess and don't change anything — confirm intent.
          await post(
            say,
            threadRoot,
            "Just to confirm before I lock anything in: do you want to *approve this plan as-is*, or *make a change*?\nReply `approve` to lock it, or `change: …` with what you'd like adjusted.",
          );
          return;
        }
        // decision === "change": fall through to revise. Any change instruction —
        // even if the message also said "approve" — revises and re-presents for
        // approval. We never lock in the same turn that introduced changes.
      }
      // Gathering input, or a change/clarification on a proposed plan →
      // run the planner again with the new operator turn appended.
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

  // Rehydrate in-flight approvals from the Sheet so a restart mid-approval
  // doesn't drop a proposed plan still awaiting "approve". Best-effort: a Sheets
  // failure here logs and continues — the service runs fine without restored state.
  try {
    await ensureApprovalsTab();
    const pending = await listPendingApprovals();
    for (const rec of pending) {
      conversations.set(rec.threadRoot, {
        // Only the Media Planner uses the approval gate today.
        agent: "media-planner",
        phase: rec.phase === "proposed" ? "proposed" : "gathering",
        transcript: rec.transcript.map((t) => ({
          who: t.who === "Media Planner" ? "Media Planner" : "Operator",
          text: t.text,
        })),
        lastPlan: rec.lastPlan || undefined,
      });
    }
    if (pending.length > 0) {
      console.log(`♻️  Restored ${pending.length} pending approval(s) from the Sheet.`);
    }
  } catch (err) {
    warnStore("restore", err);
  }
}

main().catch((err) => {
  if (err instanceof MissingEnvError) reportMissingSecrets(err);
  console.error("Failed to start runtime:", err);
  process.exit(1);
});
