import { runAgent } from "../../shared/agent.js";
import { ensureTab, readRange, appendRows } from "../../shared/google-sheets.js";

/**
 * Agent 1 — Media Planner.
 *
 * The operator describes a campaign in plain English; the Media Planner gathers
 * the inputs it needs (asking only for what's missing), then proposes a media
 * plan with a budget split (test + scale phases, daily ₹ amounts) and a
 * low–mid–high forecast — and waits for the operator's approval.
 *
 * HARD RULES: it only proposes. It never creates campaigns, never spends, never
 * launches. Approval is handled by the runtime (manager), not here.
 */

export const MEDIA_PLANNER_SYSTEM_PROMPT = `You are the Media Planner for the ESM Overseas Meta Ads team.
The operator talks to you in Slack. Country is India; ALL money is in INR (₹).

REQUIRED INPUTS (you need all of these before proposing a plan):
1. Product/service description
2. Objective — one of: leads, purchases, or traffic
3. Total budget or a budget range (₹)
4. Target cost-per-result OR target ROAS
5. Timeframe
6. Landing page URL

BEHAVIOR:
- If any required input is missing or unclear from the conversation so far, set "status" to "need_input" and ask ONLY for the missing ones, in plain, friendly English. Do NOT guess or invent values, and do NOT produce a plan yet.
- Once you have all inputs, set "status" to "proposed" and produce a complete media plan containing:
  • A campaign / ad-set structure appropriate to the objective.
  • A budget split across a small TEST phase and a SCALE phase, each with daily ₹ amounts (and totals).
  • A forecast of reach, results, cost-per-result, and ROAS — each as a low–mid–high range.
  • The assumptions you made, stated plainly.
  • An honest confidence note: early forecasts lean on India/category benchmarks, not this account's own history, so treat them as directional.
  • End the message by asking the operator to reply "approve" to lock it in, or "change: ..." to revise.
- If the operator asks for a change, revise the plan and propose again (status "proposed").

HARD RULES: You only propose. You never create campaigns, never spend, never launch. You have no tools and take no actions.

OUTPUT FORMAT — IMPORTANT:
Respond with ONLY a single JSON object and nothing else (no markdown, no code fences). Keys:
  "status": "need_input" or "proposed"
  "message": string — the exact text to post to Slack. Write it cleanly and readably; Slack *bold* uses single asterisks. Use newlines for structure.
  "missing": array of strings — names of the missing inputs when status is "need_input"; otherwise an empty array.`;

export type PlannerStatus = "need_input" | "proposed";

export interface PlannerResult {
  status: PlannerStatus;
  message: string;
  missing: string[];
}

/** Keyword/`/plan` routing — does this message look like a media-plan request? */
export function isMediaPlanRequest(text: string): boolean {
  const t = text.trim();
  if (/^\/plan\b/i.test(t)) return true;
  return /(media[ -]?plan|\bbudget\b|\bforecast\b|allocat|cost[ -]per[ -]result|\broas\b|\bplan\b)/i.test(t);
}

/** Strip a leading "/plan" command token, if present. */
export function stripPlanCommand(text: string): string {
  return text.replace(/^\/plan\b\s*/i, "").trim();
}

/** Tolerantly parse the agent's JSON reply into a PlannerResult. */
export function parsePlannerResult(raw: string): PlannerResult {
  let body = raw.trim();
  const fenced = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) body = fenced[1].trim();

  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
      const status: PlannerStatus = obj.status === "need_input" ? "need_input" : "proposed";
      const message =
        typeof obj.message === "string" && obj.message.trim() ? obj.message : raw.trim();
      const missing = Array.isArray(obj.missing) ? obj.missing.map((m) => String(m)) : [];
      return { status, message, missing };
    } catch {
      /* fall through to fallback */
    }
  }
  // Fallback: if the model didn't return clean JSON, treat the whole reply as a proposal.
  return { status: "proposed", message: raw.trim(), missing: [] };
}

/**
 * Run one Media Planner turn over the full conversation transcript.
 * Returns whether it still needs input or has proposed a plan, plus the
 * Slack-ready message to post.
 */
export async function runMediaPlanner(transcript: string): Promise<PlannerResult> {
  const raw = await runAgent({
    systemPrompt: MEDIA_PLANNER_SYSTEM_PROMPT,
    prompt: transcript,
  });
  return parsePlannerResult(raw);
}

const SHEET_TAB = "media-plans";
const SHEET_HEADERS = ["Approved At (UTC)", "Operator", "Plan"];

/**
 * Persist an approved plan to the shared Google Sheet (tab "media-plans").
 * Only call this when Sheets is configured (see env.isSheetsConfigured()).
 */
export async function saveApprovedPlan(operator: string, planText: string): Promise<void> {
  await ensureTab(SHEET_TAB);
  const firstRow = await readRange(`${SHEET_TAB}!A1:C1`);
  if (firstRow.length === 0) {
    await appendRows(`${SHEET_TAB}!A1`, [SHEET_HEADERS]);
  }
  await appendRows(`${SHEET_TAB}!A1`, [[new Date().toISOString(), operator, planText]]);
}
