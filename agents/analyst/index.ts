import { runAgent, AGENT_ERROR_REPLY } from "../../shared/agent.js";
import {
  getAccountInsights,
  getCampaignInsights,
  type AccountInsights,
  type CampaignInsight,
} from "../../shared/meta.js";
import { ensureTab, readRange, readAsObjects, appendRows } from "../../shared/google-sheets.js";
import { isSheetsConfigured } from "../../shared/env.js";

/**
 * Agent 8 — Analyst (Phase A: read-only daily reporter).
 *
 * Once a day it pulls yesterday's Meta performance (account + per-campaign) plus
 * a 7-day window for context, posts a skimmable digest to Slack, and appends one
 * row to the "daily-report" Sheet tab. It is STRICTLY READ-ONLY toward Meta: it
 * only calls the read helpers in shared/meta.ts (getAccountInsights /
 * getCampaignInsights) and has no tools wired to it — it can never create, edit,
 * pause, or spend. Lead counting is delegated to shared/meta.ts, which uses the
 * single canonical de-duplicated action type (onsite_conversion.lead_grouped);
 * this agent never sums action types itself.
 *
 * All money is in INR (₹). The account timezone is India (Asia/Kolkata), so
 * "yesterday" here lines up with Meta's date_preset "yesterday".
 */

const SHEET_TAB = "daily-report";
const SHEET_HEADERS = [
  "date",
  "spend",
  "leads",
  "cpl",
  "impressions",
  "clicks",
  "ctr",
  "cpl_7d_avg",
];

/** Show at most this many campaigns in the movers table (keeps Slack readable). */
const MOVERS_CAP = 10;

/** One short sentence of plain-English colour, generated from the numbers. */
const ANALYST_SUMMARY_PROMPT = `You are the Analyst for the ESM Overseas Meta Ads team.
Given yesterday's paid-Meta numbers, write ONE short, plain-English sentence (max ~25 words)
summarizing where spend went and how efficiency looked. No preamble, no markdown, no bullet
points, no numbers tables — just the single sentence. This is read-only commentary: never
recommend spend, budget, or any change.`;

// --- Date helpers ----------------------------------------------------------

/**
 * Yesterday's calendar date (YYYY-MM-DD) in India Standard Time (UTC+5:30).
 *
 * The ad account is in India, so this matches Meta's date_preset "yesterday".
 * Computed in IST explicitly so it's correct regardless of the server timezone
 * (Railway runs in UTC). This string is BOTH the Sheet "date" value and the
 * idempotency key, so it must be stable — see appendDailyReportRow (written RAW).
 */
export function istYesterdayISO(now: Date = new Date()): string {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  ist.setUTCDate(ist.getUTCDate() - 1);
  return ist.toISOString().slice(0, 10);
}

// --- Formatting ------------------------------------------------------------

/** ₹ with Indian digit grouping, rounded to whole rupees (for the digest). */
function inr(n: number): string {
  return "₹" + Math.round(n).toLocaleString("en-IN");
}
function cplStr(cpl: number | null): string {
  return cpl == null ? "—" : inr(cpl);
}
function intStr(n: number): string {
  return Math.round(n).toLocaleString("en-IN");
}

/** Yesterday's CPL vs the 7-day average — context only, no alerting. */
function contextLine(acctY: AccountInsights, acct7: AccountInsights): string {
  if (acctY.cpl == null || acct7.cpl == null || acct7.cpl === 0) {
    return `• CPL context: ${cplStr(acctY.cpl)} yesterday vs 7-day avg ${cplStr(acct7.cpl)} (not enough lead data to compare)`;
  }
  const deltaPct = ((acctY.cpl - acct7.cpl) / acct7.cpl) * 100;
  const dir = deltaPct >= 0 ? "up" : "down";
  return `• CPL ${inr(acctY.cpl)} — ${dir} ${Math.abs(Math.round(deltaPct))}% vs 7-day avg ${inr(acct7.cpl)}`;
}

/** Movers = campaigns with spend > 0 yesterday, by spend desc, capped. */
function moversBlock(movers: CampaignInsight[]): string {
  if (movers.length === 0) return "*Movers (by spend)*\n_No campaigns spent yesterday._";
  const shown = movers.slice(0, MOVERS_CAP);
  const lines = shown.map(
    (c, i) => `${i + 1}. ${c.campaignName} — ${inr(c.spend)} · ${c.leads} leads · CPL ${cplStr(c.cpl)}`,
  );
  const extra = movers.length - shown.length;
  const footer = extra > 0 ? `\n_+${extra} more campaign${extra === 1 ? "" : "s"} with spend (not shown)._` : "";
  return `*Movers (by spend)*\n${lines.join("\n")}${footer}`;
}

/** Assemble the full Slack digest (mrkdwn). `summary` is omitted when null. */
function buildDigest(
  dateKey: string,
  acctY: AccountInsights,
  acct7: AccountInsights,
  movers: CampaignInsight[],
  summary: string | null,
): string {
  const headline =
    acctY.leads > 0
      ? `*${acctY.leads} leads at ${inr(acctY.cpl as number)} CPL* yesterday`
      : `*0 leads yesterday* (no CPL)`;

  const parts: (string | null)[] = [
    `*📊 Daily report — ${dateKey}*  _(yesterday · all figures ₹ · India)_`,
    headline,
    summary ? `_${summary}_` : null,
    "",
    "*Account (yesterday)*",
    `• Spend: ${inr(acctY.spend)}`,
    `• Leads: ${acctY.leads}`,
    `• CPL: ${cplStr(acctY.cpl)}`,
    `• Impressions: ${intStr(acctY.impressions)}`,
    `• Clicks: ${intStr(acctY.clicks)} (CTR ${acctY.ctr.toFixed(2)}%)`,
    contextLine(acctY, acct7),
    "",
    moversBlock(movers),
  ];
  return parts.filter((p) => p !== null).join("\n").trim();
}

// --- AI summary line (best-effort; never blocks the digest) ----------------

async function summaryLine(
  acctY: AccountInsights,
  acct7: AccountInsights,
  movers: CampaignInsight[],
): Promise<string | null> {
  const top = movers
    .slice(0, 5)
    .map(
      (c) =>
        `${c.campaignName}: ₹${Math.round(c.spend)} spend, ${c.leads} leads, CPL ${c.cpl == null ? "n/a" : "₹" + Math.round(c.cpl)}`,
    )
    .join("; ");
  const prompt =
    `Yesterday (whole account): spend ₹${Math.round(acctY.spend)}, ${acctY.leads} leads, ` +
    `CPL ${acctY.cpl == null ? "n/a" : "₹" + Math.round(acctY.cpl)}. ` +
    `7-day average CPL ${acct7.cpl == null ? "n/a" : "₹" + Math.round(acct7.cpl)}. ` +
    `Top campaigns by spend: ${top || "none with spend"}.`;

  const raw = await runAgent({ systemPrompt: ANALYST_SUMMARY_PROMPT, prompt });
  // SDK error → just omit the line. Never block the digest on the prose model.
  if (raw === AGENT_ERROR_REPLY) return null;
  const line = raw.trim().split("\n")[0].trim();
  return line || null;
}

// --- Sheet: daily-report tab -----------------------------------------------

/** Ensure the tab exists and has a header row. Idempotent. */
async function ensureDailyReportTab(): Promise<void> {
  await ensureTab(SHEET_TAB);
  const firstRow = await readRange(`${SHEET_TAB}!A1:H1`);
  if (firstRow.length === 0) {
    await appendRows(`${SHEET_TAB}!A1`, [SHEET_HEADERS]);
  }
}

/** True if a row for `dateKey` already exists (the idempotency guard). */
async function hasReportForDate(dateKey: string): Promise<boolean> {
  const rows = await readAsObjects(SHEET_TAB);
  return rows.some((r) => (r.date ?? "").trim() === dateKey);
}

/**
 * Append one daily row. Written with valueInputOption "RAW" so the `date` cell
 * round-trips byte-identically — it is the idempotency key, and "USER_ENTERED"
 * would let Sheets reformat the date (e.g. 2026-06-29 → 6/29/2026), which would
 * break the same-day duplicate check. Numbers are stored as fixed-precision
 * strings for the same reason (stable, no locale/coercion surprises).
 */
async function appendDailyReportRow(
  dateKey: string,
  acctY: AccountInsights,
  acct7: AccountInsights,
): Promise<void> {
  const row = [
    dateKey,
    acctY.spend.toFixed(2),
    String(acctY.leads),
    acctY.cpl == null ? "" : acctY.cpl.toFixed(2),
    String(Math.round(acctY.impressions)),
    String(Math.round(acctY.clicks)),
    acctY.ctr.toFixed(2),
    acct7.cpl == null ? "" : acct7.cpl.toFixed(2),
  ];
  await appendRows(SHEET_TAB, [row], "RAW");
}

// --- Orchestrator ----------------------------------------------------------

export interface RunDailyReportOptions {
  /** Posts the digest to Slack. Supplied by the caller (runtime or script). */
  postMessage: (text: string) => Promise<void>;
  /**
   * Bypass the "already reported today" skip so a manual run always posts.
   * The Sheet append still won't duplicate an existing same-date row.
   */
  force?: boolean;
}

export interface RunDailyReportResult {
  posted: boolean;
  dateKey: string;
  reason?: "already-reported" | "error";
  message?: string;
  error?: string;
}

/**
 * Build and deliver the daily report. Idempotent (skips if today's row exists,
 * unless `force`) and fully wrapped: any failure logs and posts a brief note
 * but never throws, so a scheduler can call it without risk to the runtime.
 */
export async function runDailyReport(opts: RunDailyReportOptions): Promise<RunDailyReportResult> {
  const { postMessage, force = false } = opts;
  const dateKey = istYesterdayISO();

  try {
    // Idempotency: one row per date. Check BEFORE posting so a restart near the
    // scheduled time can't double-post. (Only enforceable when Sheets is on.)
    let alreadyReported = false;
    if (isSheetsConfigured()) {
      await ensureDailyReportTab();
      alreadyReported = await hasReportForDate(dateKey);
    }
    if (alreadyReported && !force) {
      console.log(`📊 Analyst: daily-report already has a row for ${dateKey}; skipping (idempotent).`);
      return { posted: false, dateKey, reason: "already-reported" };
    }

    // Read-only pulls. "yesterday" for the report, "last_7d" for CPL context.
    const [acctY, acct7, camps] = await Promise.all([
      getAccountInsights("yesterday"),
      getAccountInsights("last_7d"),
      getCampaignInsights("yesterday"),
    ]);

    const movers = camps.filter((c) => c.spend > 0).sort((a, b) => b.spend - a.spend);
    const summary = await summaryLine(acctY, acct7, movers);
    const message = buildDigest(dateKey, acctY, acct7, movers, summary);

    await postMessage(message);

    // Mark today as done (skip if a row somehow already exists, e.g. forced run).
    if (isSheetsConfigured() && !alreadyReported) {
      await appendDailyReportRow(dateKey, acctY, acct7);
    }

    return { posted: true, dateKey, message };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`⚠️ Analyst daily report failed for ${dateKey}: ${error}`);
    // Best-effort heads-up; swallow any failure posting it.
    try {
      await postMessage("⚠️ I couldn't generate today's report — I'll try again tomorrow.");
    } catch {
      /* never let the failure note itself crash the job */
    }
    return { posted: false, dateKey, reason: "error", error };
  }
}
