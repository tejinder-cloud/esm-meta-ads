import { runAgent } from "../../shared/agent.js";
import { ensureTab, readRange, appendRows } from "../../shared/google-sheets.js";
import {
  computeForecast,
  computeBudgetSplit,
  formatForecast,
  formatBudgetSplit,
  money,
  RESULT_LABELS,
  type Objective,
  type GeoTightness,
} from "./forecast.js";

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
- Once you have all inputs, set "status" to "proposed" and return the STRUCTURED inputs plus a qualitative campaign structure and assumptions (see OUTPUT FORMAT).
- When revising after a change request, apply ONLY the changes the operator explicitly asked for. Keep everything else exactly as it was. Never introduce changes the operator did not request.

CRITICAL — the system, not you, computes all numbers:
- Do NOT write any figures for budget split, daily spend, impressions, reach, results/leads, cost-per-result, or ROAS. The system calculates ALL of those deterministically from category benchmarks, so they stay consistent and move logically.
- "structureMarkdown" must describe the campaign and ad-set structure qualitatively (objective, the test→scale phases conceptually, audiences, creative angles) with NO ₹ amounts and NO forecast numbers.
- Do NOT add any "approve"/"change" instruction — the system adds that separately.

HARD RULES: You only propose. You never create campaigns, never spend, never launch. You have no tools and take no actions.

OUTPUT FORMAT — respond with ONLY a single JSON object, no markdown, no code fences.
For a question:
  {"status":"need_input","message":"<plain-English ask for ONLY the missing inputs>","missing":["..."]}
For a proposal:
  {
    "status":"proposed",
    "inputs":{
      "product":"<short product/service description>",
      "objective":"leads" | "purchases" | "traffic",
      "totalBudgetInr": <number; if a range was given, use its midpoint>,
      "timeframeDays": <number of days>,
      "targetSummary":"<echo the operator's target, e.g. 'Target CPL ₹400' or 'Target ROAS 3x'>",
      "landingPage":"<url>",
      "geoTightness":"broad" | "medium" | "tight"
    },
    "structureMarkdown":"<qualitative campaign + ad-set structure; NO ₹ amounts, NO forecast numbers>",
    "assumptionsMarkdown":"<qualitative assumptions: audiences, creative approach, tracking, what's excluded; do NOT restate budget or forecast numbers>"
  }
geoTightness: "broad" = all-India; "medium" = a few states/cities; "tight" = one city/small area. Default "broad" if the operator didn't narrow the geography.`;

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

/** Extract the first JSON object from a model reply (tolerates code fences). */
function extractJson(raw: string): Record<string, unknown> | null {
  let body = raw.trim();
  const fenced = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) body = fenced[1].trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function coerceObjective(v: unknown): Objective | null {
  return v === "leads" || v === "purchases" || v === "traffic" ? v : null;
}
function coerceGeo(v: unknown): GeoTightness {
  return v === "medium" || v === "tight" ? v : "broad";
}
function toNumber(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}
function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

/** Slack mrkdwn uses single-asterisk bold; convert any markdown **bold**. */
function toSlackMarkdown(s: string): string {
  return s.replace(/\*\*/g, "*");
}

/** Assemble the full, deterministic proposal message (no approve/change prompt). */
function assembleProposal(args: {
  product: string;
  objective: Objective;
  totalBudgetInr: number;
  timeframeDays: number;
  targetSummary: string;
  landingPage: string;
  geoTightness: GeoTightness;
  structureMarkdown: string;
  assumptionsMarkdown: string;
}): string {
  const geoLabel =
    args.geoTightness === "broad"
      ? "Broad (all-India)"
      : args.geoTightness === "medium"
        ? "Medium (a few states/cities)"
        : "Tight (one city / small area)";

  const split = computeBudgetSplit(args.totalBudgetInr, args.timeframeDays);
  const forecast = computeForecast({
    totalBudgetInr: args.totalBudgetInr,
    timeframeDays: args.timeframeDays,
    objective: args.objective,
    geoTightness: args.geoTightness,
  });

  const parts: (string | null)[] = [
    `*Media Plan — ${args.product} (${RESULT_LABELS[args.objective].result})*`,
    "All figures in ₹. Country: India.",
    "",
    "*Inputs*",
    `• Objective: ${args.objective}`,
    `• Total budget: ${money(args.totalBudgetInr)} over ${args.timeframeDays} days`,
    args.targetSummary ? `• ${args.targetSummary}` : null,
    args.landingPage ? `• Landing page: ${args.landingPage}` : null,
    `• Geo: ${geoLabel}`,
    "",
    args.structureMarkdown ? "*Campaign structure*" : null,
    args.structureMarkdown ? toSlackMarkdown(args.structureMarkdown) : null,
    args.structureMarkdown ? "" : null,
    formatBudgetSplit(split, args.totalBudgetInr),
    "",
    formatForecast(forecast, args.objective),
    "",
    args.assumptionsMarkdown ? "*Assumptions*" : null,
    args.assumptionsMarkdown ? toSlackMarkdown(args.assumptionsMarkdown) : null,
    args.assumptionsMarkdown ? "" : null,
    "_Forecasts are directional and benchmark-based (India education / study-abroad); they tighten as the account gathers real data._",
  ];
  return parts.filter((p) => p !== null).join("\n").trim();
}

/**
 * Run one Media Planner turn over the full conversation transcript.
 * The LLM returns structured inputs + qualitative copy; the code computes every
 * number (budget split + forecast) deterministically and assembles the message.
 * Returns whether it still needs input or has proposed a plan.
 */
export async function runMediaPlanner(transcript: string): Promise<PlannerResult> {
  const raw = await runAgent({
    systemPrompt: MEDIA_PLANNER_SYSTEM_PROMPT,
    prompt: transcript,
  });

  const obj = extractJson(raw);
  // Fallback: if the model didn't return parseable JSON, post whatever it said.
  if (!obj) return { status: "proposed", message: raw.trim(), missing: [] };

  if (obj.status === "need_input") {
    const message = asString(obj.message, "Could you share a bit more so I can plan this?");
    const missing = Array.isArray(obj.missing) ? obj.missing.map((m) => String(m)) : [];
    return { status: "need_input", message, missing };
  }

  // Proposed → validate the inputs we need to compute a forecast.
  const inputs = (obj.inputs ?? {}) as Record<string, unknown>;
  const objective = coerceObjective(inputs.objective);
  const totalBudgetInr = toNumber(inputs.totalBudgetInr);
  const timeframeDays = toNumber(inputs.timeframeDays);

  if (!objective || !(totalBudgetInr > 0) || !(timeframeDays > 0)) {
    const missing: string[] = [];
    if (!objective) missing.push("objective (leads, purchases, or traffic)");
    if (!(totalBudgetInr > 0)) missing.push("total budget in ₹");
    if (!(timeframeDays > 0)) missing.push("timeframe (number of days)");
    return {
      status: "need_input",
      message: `I just need a bit more to run the numbers: ${missing.join(", ")}.`,
      missing,
    };
  }

  const message = assembleProposal({
    product: asString(inputs.product, "your campaign"),
    objective,
    totalBudgetInr,
    timeframeDays,
    targetSummary: asString(inputs.targetSummary),
    landingPage: asString(inputs.landingPage),
    geoTightness: coerceGeo(inputs.geoTightness),
    structureMarkdown: asString(obj.structureMarkdown),
    assumptionsMarkdown: asString(obj.assumptionsMarkdown),
  });

  return { status: "proposed", message, missing: [] };
}

// ---------------------------------------------------------------------------
// Approval-gate decision: approve | change | ambiguous.
//
// The budget gate must be unambiguous. Any change instruction — even alongside
// the word "approve" — counts as a REVISE, never an approval. Only a clean,
// change-free approval locks the plan. When genuinely unclear, we ask.
// ---------------------------------------------------------------------------

export type OperatorDecision = "approve" | "change" | "ambiguous";

const APPROVAL_CLASSIFIER_PROMPT = `You classify the operator's reply to a proposed media plan into exactly one decision.

Decisions:
- "approve": a clean, unconditional approval to lock the plan in, with NO requested changes of any kind.
- "change": the reply requests ANY modification (budget, phases, daily amounts, targeting, dates, creative, structure, wording — anything), EVEN IF it also contains the word "approve" or otherwise signals approval. If both an approval and any change are present, the decision is "change".
- "ambiguous": you cannot tell with confidence whether it is a clean approval or a change request (this includes questions and vague replies).

Rules:
- Any change instruction makes it "change", never "approve" — even alongside approval words.
- Only a pure approval with zero requested changes is "approve".
- When unsure, choose "ambiguous". Never guess "approve".

Output ONLY a JSON object and nothing else: {"decision":"approve"|"change"|"ambiguous"}`;

/** Deterministic fast paths; returns null when an LLM judgment is needed. */
export function quickDecision(text: string): OperatorDecision | null {
  const t = text.trim();
  if (/^change\s*:/i.test(t)) return "change";
  const norm = t.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
  const cleanApprovals = new Set([
    "approve", "approved", "approve it", "approve this", "approve the plan",
    "i approve", "approve please", "please approve", "yes approve", "approve yes",
  ]);
  if (cleanApprovals.has(norm)) return "approve";
  return null;
}

function parseDecision(raw: string): OperatorDecision {
  const m = raw.match(/"?decision"?\s*:\s*"(approve|change|ambiguous)"/i);
  if (m) return m[1].toLowerCase() as OperatorDecision;
  // Unparseable → ambiguous, so we ask rather than risk a wrong lock.
  return "ambiguous";
}

/**
 * Decide whether the operator's reply to a proposed plan is a clean approval, a
 * change request, or ambiguous. Biases hard against false approvals: anything
 * that isn't an unmistakable, change-free approval becomes "change" or
 * "ambiguous". Never returns "approve" for a message that also requests changes.
 */
export async function decideOperatorIntent(operatorMessage: string): Promise<OperatorDecision> {
  const quick = quickDecision(operatorMessage);
  if (quick) return quick;
  const raw = await runAgent({
    systemPrompt: APPROVAL_CLASSIFIER_PROMPT,
    prompt: `Operator reply to the proposed plan:\n${operatorMessage}`,
  });
  return parseDecision(raw);
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
