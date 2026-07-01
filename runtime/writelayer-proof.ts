import {
  listCampaigns,
  pauseCampaign,
  resumeCampaign,
  type Campaign,
  type WriteAction,
} from "../shared/meta.js";
import { logGatedAction } from "../shared/gated-actions.js";

/**
 * Phase B — controlled LIVE-write proof (pause → resume) for the pilot campaign.
 *
 * This is a one-off, operator-gated proof that the write layer can make a real,
 * reversible change to Meta. Hard limits enforced here:
 *   - ONLY the New Zealand pilot campaign (ACTIVE, ₹1,000/day) is ever resolved.
 *   - ONLY pause/resume — never a budget change, never another campaign.
 *   - A single pause then a single resume, then the conversation ends. No loop.
 *
 * A write runs with execute=true ONLY from here, and ONLY after the operator
 * replies "approve" through the Slack approval gate (the flow lives in
 * runtime/index.ts). Every executed write is logged to the "gated-actions" tab.
 */

/** Pilot selection criteria — name contains this (case-insensitive)… */
export const PILOT_NAME_MATCH = "new zealand";
/** …and daily budget is exactly this many rupees, and status is ACTIVE. */
export const PILOT_DAILY_BUDGET = 1000;

export interface PilotResolution {
  /** The single matching campaign, or null if zero / more than one matched. */
  match: Campaign | null;
  /** Every ACTIVE name+budget match (for the STOP-and-list case). */
  candidates: Campaign[];
}

/**
 * Resolve the pilot from the LIVE read layer. Returns `match` only when EXACTLY
 * one ACTIVE "New Zealand" campaign at ₹1,000/day exists — otherwise `match` is
 * null and the caller must stop and list `candidates` rather than guess.
 */
export async function resolvePilot(): Promise<PilotResolution> {
  const camps = await listCampaigns();
  const candidates = camps.filter(
    (c) =>
      c.status === "ACTIVE" &&
      c.name.toLowerCase().includes(PILOT_NAME_MATCH) &&
      c.dailyBudget === PILOT_DAILY_BUDGET,
  );
  return { match: candidates.length === 1 ? candidates[0] : null, candidates };
}

/** The context carried through the proof conversation (persisted for restart). */
export interface ProofContext {
  campaignId: string;
  campaignName: string;
}

// --- Slack message builders ------------------------------------------------

export function approvalPromptMessage(ctx: ProofContext): string {
  return (
    `*Phase B live-write proof* on '${ctx.campaignName}' (${ctx.campaignId}):\n` +
    `I will *PAUSE* it, you confirm in Ads Manager, then reply *resume* and I'll set it back to *ACTIVE*.\n` +
    `Reply *approve* to begin, or *cancel*.`
  );
}

export function pausedMessage(): string {
  return "✅ *PAUSED* — please confirm in Ads Manager, then reply *resume*.";
}

export function resumedMessage(): string {
  return "✅ *RESUMED* — back to ACTIVE. Live-write proof complete.";
}

// --- Gated execution (execute=true) + audit log ----------------------------

/**
 * Pause the pilot LIVE, then log it. `before` is taken from the state read inside
 * the write. Throws if the Meta write fails (caller handles + keeps a known state).
 */
export async function executePause(ctx: ProofContext): Promise<WriteAction> {
  const action = await pauseCampaign(ctx.campaignId, true); // execute=true — gated
  await safeLog({
    action: "pauseCampaign",
    campaignId: ctx.campaignId,
    campaignName: ctx.campaignName,
    before: action.before.status,
    after: "PAUSED",
    result: "ok",
  });
  return action;
}

/** Resume the pilot LIVE, then log it. Throws if the Meta write fails. */
export async function executeResume(ctx: ProofContext): Promise<WriteAction> {
  const action = await resumeCampaign(ctx.campaignId, true); // execute=true — gated
  await safeLog({
    action: "resumeCampaign",
    campaignId: ctx.campaignId,
    campaignName: ctx.campaignName,
    before: action.before.status,
    after: "ACTIVE",
    result: "ok",
  });
  return action;
}

/** Log to the Sheet best-effort — a logging failure must never undo/block a write. */
async function safeLog(entry: Parameters<typeof logGatedAction>[0]): Promise<void> {
  try {
    await logGatedAction(entry);
  } catch (err) {
    console.warn(
      `⚠️  gated-actions log failed (write already done): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
