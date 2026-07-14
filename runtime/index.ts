import http from "node:http";
import bolt from "@slack/bolt";
import type { SayFn } from "@slack/bolt";
import { env, validateEnv, optionalFeatureStatus, describeEnv, isSheetsConfigured, isMetaConfigured, MissingEnvError } from "../shared/env.js";
import { runAgent } from "../shared/agent.js";
import { runDailyReport } from "../agents/analyst/index.js";
import { runOptimizerPass, PILOT_ID } from "../agents/optimizer/index.js";
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
import {
  resolvePilot,
  approvalPromptMessage,
  pausedMessage,
  resumedMessage,
  executePause,
  executeResume,
  PILOT_DAILY_BUDGET,
  type ProofContext,
} from "./writelayer-proof.js";

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

type AgentKind = "media-planner" | "writelayer-proof";
type Phase = "gathering" | "proposed" | "awaiting-approve" | "awaiting-resume";

interface Turn {
  who: "Operator" | "Media Planner";
  text: string;
}

interface Conversation {
  agent: AgentKind;
  phase: Phase;
  transcript: Turn[];
  lastPlan?: string;
  /** Set only for the "writelayer-proof" conversation (the pilot being acted on). */
  proof?: ProofContext;
}

const conversations = new Map<string, Conversation>();

/** Call-to-action appended to a freshly proposed plan (not part of the plan body). */
const PROPOSE_FOOTER = "Reply *approve* to lock this plan in, or *change: …* to tell me what to adjust.";

function renderTranscript(turns: Turn[]): string {
  return turns.map((t) => `${t.who}: ${t.text}`).join("\n\n");
}

/**
 * Trigger for the one-off Phase B live-write proof. Deliberately explicit so it
 * can't fire by accident: an exact "/proof" command or the phrase "live-write
 * proof". Everything else falls through to the normal (media-planner/manager) routing.
 */
function isProofRequest(text: string): boolean {
  const t = text.trim().toLowerCase();
  return t === "/proof" || t.startsWith("/proof ") || t.includes("live-write proof") || t.includes("live write proof");
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

// ---------------------------------------------------------------------------
// Simple daily scheduler (no extra deps). Fires a job once per day at a fixed
// UTC time, then reschedules itself for the next day. A self-correcting
// setTimeout (recomputed each cycle) avoids drift from setInterval.
// ---------------------------------------------------------------------------

function msUntilNextUtc(hour: number, minute: number, now: Date = new Date()): number {
  const next = new Date(now);
  next.setUTCHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

function scheduleDailyUtc(hour: number, minute: number, job: () => Promise<void>): void {
  const tick = async () => {
    try {
      await job();
    } catch (err) {
      // Belt-and-suspenders: the job is already wrapped, but never let a
      // scheduler tick crash the process.
      console.error("Scheduled job error:", err instanceof Error ? err.message : err);
    }
    setTimeout(tick, msUntilNextUtc(hour, minute));
  };
  setTimeout(tick, msUntilNextUtc(hour, minute));
}

/**
 * Run `job` on a fixed interval (same self-rescheduling setTimeout pattern as
 * scheduleDailyUtc, no drift concerns needed at this cadence). First run fires
 * one interval after startup. The job is expected to be self-wrapped; this still
 * guards each tick so a throw can never crash the process.
 */
function scheduleEveryMs(intervalMs: number, job: () => Promise<void>): void {
  const tick = async () => {
    try {
      await job();
    } catch (err) {
      console.error("Scheduled job error:", err instanceof Error ? err.message : err);
    }
    setTimeout(tick, intervalMs);
  };
  setTimeout(tick, intervalMs);
}

/**
 * Unmistakable boot banner announcing the LIVE Optimizer arm state, read fresh
 * from OPTIMIZER_ARMED at startup. Printed every boot so the armed/shadow mode is
 * verifiable at a glance in Railway logs. This only REPORTS state — it changes no
 * breaker logic or thresholds.
 */
function logOptimizerBanner(armed: boolean): void {
  const line =
    "════════════════════════════════════════════════════════════════════";
  const body = armed
    ? `🔴 OPTIMIZER ARMED — will AUTO-PAUSE NZ pilot (${PILOT_ID}) on: zero-lead bleed ` +
      `(≥₹500 & 0 leads) or CPL runaway (≥₹750 & CPL>₹400). CPQL >₹8,600 = alert only.`
    : `🟡 OPTIMIZER SHADOW — detects & alerts only, pauses nothing.`;
  console.log(line);
  console.log(body);
  console.log(line);
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

  // Boot banner: announce the live Optimizer arm state (read from OPTIMIZER_ARMED)
  // before anything else, so armed/shadow is confirmable in Railway logs every boot.
  logOptimizerBanner(env.optimizerArmed());

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

  // ----- Phase B live-write proof (pause → resume, gated) ------------------

  /** Mirror the proof conversation to the durable store (survives a restart). */
  async function persistProof(threadRoot: string, convo: Conversation) {
    try {
      await savePendingApproval({
        threadRoot,
        agent: convo.agent, // "writelayer-proof"
        phase: convo.phase,
        // Carry the pilot context through a restart (parsed back on rehydrate).
        lastPlan: JSON.stringify(convo.proof ?? {}),
        transcript: [],
      });
    } catch (err) {
      warnStore("save", err);
    }
  }

  /** Conversation done → drop in-memory + durable state. */
  async function endProof(threadRoot: string) {
    conversations.delete(threadRoot);
    try {
      await clearPendingApproval(threadRoot);
    } catch (err) {
      warnStore("clear", err);
    }
  }

  /** Resolve the pilot and open the approval gate. Stops (no state) if not exactly one match. */
  async function startProof(threadRoot: string, say: SayFn) {
    const { match, candidates } = await resolvePilot();
    if (candidates.length === 0) {
      await post(say, threadRoot, `No *ACTIVE* "New Zealand" campaign at ₹${PILOT_DAILY_BUDGET}/day was found — nothing to do.`);
      return;
    }
    if (candidates.length > 1) {
      const list = candidates.map((c) => `• ${c.id} — ${c.name} (${c.status}, ₹${c.dailyBudget}/day)`).join("\n");
      await post(say, threadRoot, `⚠️ ${candidates.length} campaigns matched — stopping rather than guessing. Tell me which one:\n${list}`);
      return;
    }
    const c = match!;
    const proof: ProofContext = { campaignId: c.id, campaignName: c.name };
    const convo: Conversation = { agent: "writelayer-proof", phase: "awaiting-approve", transcript: [], proof };
    conversations.set(threadRoot, convo);
    await post(say, threadRoot, approvalPromptMessage(proof));
    await persistProof(threadRoot, convo);
  }

  /**
   * Drive the gated proof. Single pause (on "approve") then single resume (on
   * "resume"), then stop — no loop. "cancel" ends in a known ACTIVE state. Every
   * write is wrapped: on failure we report and leave the campaign in a known state.
   */
  async function handleProofTurn(convo: Conversation, operatorText: string, threadRoot: string, say: SayFn) {
    const intent = operatorText.trim().toLowerCase();
    const proof = convo.proof!;

    if (intent === "cancel") {
      if (convo.phase === "awaiting-resume") {
        // Already paused — resume so the campaign is left ACTIVE (the guardrail).
        try {
          const action = await executeResume(proof);
          console.log("Proof resume (on cancel) response:", JSON.stringify(action.response));
          await post(say, threadRoot, `Cancelled — I resumed *${proof.campaignName}* so it's left *ACTIVE*.`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await post(say, threadRoot, `⚠️ Cancelled, but resume failed: ${msg}. *${proof.campaignName}* (${proof.campaignId}) may still be PAUSED — please set it back to ACTIVE in Ads Manager.`);
        }
      } else {
        await post(say, threadRoot, `Cancelled — no writes performed, *${proof.campaignName}* left *ACTIVE*.`);
      }
      await endProof(threadRoot);
      return;
    }

    if (convo.phase === "awaiting-approve") {
      if (intent !== "approve") {
        await post(say, threadRoot, "Reply *approve* to begin the live-write proof (I'll *PAUSE* it), or *cancel*.");
        return;
      }
      try {
        const action = await executePause(proof); // execute=true — first live write
        console.log("Proof pause response:", JSON.stringify(action.response));
        convo.phase = "awaiting-resume";
        await persistProof(threadRoot, convo);
        await post(say, threadRoot, `${pausedMessage()}\n\`API response: ${JSON.stringify(action.response)}\``);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Pause failed → nothing changed; campaign is still ACTIVE (a known state).
        await post(say, threadRoot, `⚠️ Pause failed: ${msg}. No change made — *${proof.campaignName}* is still *ACTIVE*. Proof aborted.`);
        await endProof(threadRoot);
      }
      return;
    }

    if (convo.phase === "awaiting-resume") {
      if (intent !== "resume") {
        await post(say, threadRoot, "Reply *resume* to set it back to *ACTIVE*, or *cancel* (I'll still resume so it ends ACTIVE).");
        return;
      }
      try {
        const action = await executeResume(proof);
        console.log("Proof resume response:", JSON.stringify(action.response));
        await post(say, threadRoot, `${resumedMessage()}\n\`API response: ${JSON.stringify(action.response)}\``);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Resume failed → campaign left PAUSED. Try once more, then hand off to the operator.
        await post(say, threadRoot, `⚠️ Resume failed: ${msg}. Retrying once…`);
        try {
          const retry = await executeResume(proof);
          console.log("Proof resume retry response:", JSON.stringify(retry.response));
          await post(say, threadRoot, `${resumedMessage()} (on retry)`);
        } catch (err2) {
          const msg2 = err2 instanceof Error ? err2.message : String(err2);
          await post(say, threadRoot, `⚠️ Resume still failing: ${msg2}. *${proof.campaignName}* (${proof.campaignId}) is *PAUSED* — please set it back to ACTIVE in Ads Manager.`);
        }
      }
      await endProof(threadRoot);
      return;
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
      // Checked first so the explicit proof trigger can't be swallowed by routing.
      if (isProofRequest(operatorText)) {
        await startProof(threadRoot, say);
        return;
      }
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

    // --- Continuing the Phase B live-write proof ---
    if (existing.agent === "writelayer-proof") {
      await handleProofTurn(existing, operatorText, threadRoot, say);
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
      // Restore an in-flight live-write proof (pilot context lives in lastPlan).
      if (rec.agent === "writelayer-proof") {
        let proof: ProofContext | undefined;
        try {
          const parsed = JSON.parse(rec.lastPlan || "{}");
          if (parsed && parsed.campaignId) {
            proof = { campaignId: String(parsed.campaignId), campaignName: String(parsed.campaignName ?? "") };
          }
        } catch {
          proof = undefined;
        }
        if (!proof) continue; // corrupt row → skip rather than act on a guess
        conversations.set(rec.threadRoot, {
          agent: "writelayer-proof",
          phase: rec.phase === "awaiting-resume" ? "awaiting-resume" : "awaiting-approve",
          transcript: [],
          proof,
        });
        continue;
      }
      conversations.set(rec.threadRoot, {
        // Media Planner is the other approval-gated conversation.
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

  // Analyst (Agent 8) — read-only daily report at 02:30 UTC = 08:00 IST.
  // India is UTC+5:30, so 08:00 IST is 02:30 UTC. runDailyReport is idempotent
  // (one row per date in "daily-report") and fully self-wrapped, so a restart
  // near 8 AM can't double-post and a failure can't crash the runtime.
  if (isMetaConfigured()) {
    scheduleDailyUtc(2, 30, async () => {
      await runDailyReport({
        postMessage: async (text) => {
          await app.client.chat.postMessage({ channel: channelId, text });
        },
      });
    });
    console.log("🗓️  Analyst scheduled: daily report at 02:30 UTC (08:00 IST) → #esm-meta-ads + daily-report tab.");
  } else {
    console.log("ℹ️  Analyst daily report disabled — Meta is not configured (set META_* to enable).");
  }

  // Optimizer (Agent 9, B3) — NZ pilot monitor every ~20 min (UTC cadence).
  // SHADOW by default (OPTIMIZER_ARMED=false): detects breakers and alerts, but
  // pauses nothing. runOptimizerPass is fully self-wrapped (a failed pass logs and
  // continues, never writes on error), so the scheduler can call it safely.
  if (isMetaConfigured()) {
    const OPTIMIZER_INTERVAL_MS = 20 * 60 * 1000;
    const armed = env.optimizerArmed(); // false everywhere in B3; arming is a later step.
    scheduleEveryMs(OPTIMIZER_INTERVAL_MS, async () => {
      await runOptimizerPass({
        postMessage: async (text) => {
          await app.client.chat.postMessage({ channel: channelId, text });
        },
        armed,
      });
    });
    console.log(
      `🛰️  Optimizer scheduled: NZ pilot monitor every 20 min (UTC). Mode: ${armed ? "ARMED (auto-pause)" : "SHADOW (alert only)"}.`,
    );
  } else {
    console.log("ℹ️  Optimizer disabled — Meta is not configured (set META_* to enable).");
  }
}

main().catch((err) => {
  if (err instanceof MissingEnvError) reportMissingSecrets(err);
  console.error("Failed to start runtime:", err);
  process.exit(1);
});
