import {
  getAccountInsights,
  getCampaignInsights,
  type CampaignInsight,
} from "../../shared/meta.js";
import { ensureTab, readRange, readAsObjects, appendRows } from "../../shared/google-sheets.js";
import { isSheetsConfigured } from "../../shared/env.js";

/**
 * Agent 7 — Tracking & Data (Phase A: read-only quality-signal reporter).
 *
 * A "quality lead" is a GHL contact manually tagged `qualified` within 7 days of
 * entry. That tag fires a Meta CAPI event as a PURCHASE on the dataset
 * "ESM Conversion API - Pixel", so the quality signal already lives inside Meta
 * as the Purchase conversion. This agent reads that signal — it is STRICTLY
 * READ-ONLY toward Meta (only the read helpers in shared/meta.ts) and never
 * writes to GHL or touches spend.
 *
 * It computes CPQL (cost per qualified lead) on a TRAILING 30-DAY window to
 * respect the up-to-7-day qualification maturation lag:
 *     CPQL = spend(last_30d) / qualified(last_30d)   [account level, reliable]
 * Per-campaign CPQL is also computed but labelled DIRECTIONAL — campaign-level
 * attribution depends on CAPI match quality, which is currently imperfect.
 *
 * Outputs (idempotent, like the Analyst):
 *   - one daily row appended to the "quality-report" Sheet tab, and
 *   - one line supplied to the Analyst's 08:00 IST digest.
 * All money is in INR (₹).
 */

const SHEET_TAB = "quality-report";
const SHEET_HEADERS = [
  "date",
  "spend_30d",
  "leads_30d",
  "qualified_30d",
  "cpl_30d",
  "cpql_30d",
  "qualified_rate",
];

/** Show at most this many campaigns in the quality:check per-campaign table. */
const CAMPAIGN_CAP = 20;

// --- Formatting ------------------------------------------------------------

/** ₹ with Indian digit grouping, rounded to whole rupees. */
function inr(n: number): string {
  return "₹" + Math.round(n).toLocaleString("en-IN");
}

// --- Quality computation (read-only) ---------------------------------------

export interface QualityData {
  /** Trailing-30-day account figures. */
  spend30: number;
  leads30: number;
  qualified30: number;
  cpl30: number | null;
  cpql30: number | null;
  /** qualified / leads, as a fraction (0..1); null when there are no leads. */
  qualifiedRate: number | null;
  /**
   * True when the qualified/Purchase signal was detected (qualified30 > 0).
   * False → the action type wasn't found or attributed nothing; callers show a
   * "quality signal not detected — check CAPI" note instead of a fake ₹0 CPQL.
   */
  detected: boolean;
  /** Per-campaign 30-day rows with spend, sorted by spend desc (directional CPQL). */
  campaigns: CampaignInsight[];
}

/** Pull the trailing-30-day account + per-campaign quality picture. Read-only. */
export async function computeQuality(): Promise<QualityData> {
  const [acct, camps] = await Promise.all([
    getAccountInsights("last_30d"),
    getCampaignInsights("last_30d"),
  ]);

  const campaigns = camps
    .filter((c) => c.spend > 0)
    .sort((a, b) => b.spend - a.spend);

  return {
    spend30: acct.spend,
    leads30: acct.leads,
    qualified30: acct.qualified,
    cpl30: acct.cpl,
    cpql30: acct.cpql,
    qualifiedRate: acct.leads > 0 ? acct.qualified / acct.leads : null,
    detected: acct.qualified > 0,
    campaigns,
  };
}

/**
 * The single line the Analyst appends to its 08:00 IST digest. When the quality
 * signal isn't detected we say so plainly rather than reporting a fake ₹0 CPQL.
 */
export function qualityDigestLine(q: QualityData): string {
  if (!q.detected) {
    return "• Quality (30-day): quality signal not detected — check CAPI";
  }
  const ratePct = q.qualifiedRate == null ? "—" : Math.round(q.qualifiedRate * 100) + "%";
  const cpql = q.cpql30 == null ? "—" : inr(q.cpql30);
  return `• Quality (30-day): ${q.qualified30} qualified · CPQL ${cpql} · ${ratePct} of leads qualified`;
}

// --- Sheet: quality-report tab ---------------------------------------------

/** Ensure the tab exists and has a header row. Idempotent. */
async function ensureQualityTab(): Promise<void> {
  await ensureTab(SHEET_TAB);
  const firstRow = await readRange(`${SHEET_TAB}!A1:G1`);
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
 * Append one daily quality row. Written "RAW" so the `date` cell round-trips
 * byte-identically (it is the idempotency key) and numbers store as stable
 * fixed-precision strings — mirrors the Analyst's daily-report discipline.
 * Empty string (not ₹0) is stored for CPQL when the signal isn't detected.
 */
async function appendQualityRow(dateKey: string, q: QualityData): Promise<void> {
  const row = [
    dateKey,
    q.spend30.toFixed(2),
    String(q.leads30),
    String(q.qualified30),
    q.cpl30 == null ? "" : q.cpl30.toFixed(2),
    q.cpql30 == null ? "" : q.cpql30.toFixed(2),
    q.qualifiedRate == null ? "" : (q.qualifiedRate * 100).toFixed(1),
  ];
  await appendRows(SHEET_TAB, [row], "RAW");
}

// --- Orchestrator ----------------------------------------------------------

export interface RunQualityReportResult {
  /** The one-line quality summary for the Analyst digest (always set). */
  line: string;
  /** Trailing-30-day figures (null only if the Meta read failed). */
  data: QualityData | null;
  /** True when a new quality-report row was appended this run. */
  appended: boolean;
  error?: string;
}

/**
 * Compute the trailing-30-day quality picture and append the daily quality-report
 * row (idempotent per date). Returns the digest line for the Analyst to include.
 *
 * Fully self-wrapped: any failure logs, returns a safe fallback line, and NEVER
 * throws — so it can never crash the runtime or break the Analyst's digest. The
 * Sheet write is skipped when Sheets isn't configured.
 *
 * @param dateKey The report date (YYYY-MM-DD, IST) — shared with the Analyst's
 *                daily-report row so both tabs line up for the same day.
 */
export async function runQualityReport(dateKey: string): Promise<RunQualityReportResult> {
  try {
    const data = await computeQuality();
    const line = qualityDigestLine(data);

    let appended = false;
    if (isSheetsConfigured()) {
      await ensureQualityTab();
      if (!(await hasReportForDate(dateKey))) {
        await appendQualityRow(dateKey, data);
        appended = true;
      }
    }
    return { line, data, appended };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`⚠️ Tracking & Data quality report failed for ${dateKey}: ${error}`);
    // Safe fallback line so the Analyst digest still renders (no fake ₹0 CPQL).
    return {
      line: "• Quality (30-day): quality signal not detected — check CAPI",
      data: null,
      appended: false,
      error,
    };
  }
}

// --- Manual verification helper (quality:check) ----------------------------

/** Build the per-campaign directional CPQL table for the `quality:check` hook. */
export function campaignTable(q: QualityData): string {
  if (q.campaigns.length === 0) return "  (no campaigns with spend in the last 30 days)";
  const shown = q.campaigns.slice(0, CAMPAIGN_CAP);
  const lines = shown.map((c) => {
    const cpql = c.cpql == null ? "—" : inr(c.cpql);
    return `  ${c.campaignName}\n     spend ${inr(c.spend)} · ${c.leads} leads · ${c.qualified} qualified · CPQL ${cpql} (directional)`;
  });
  const extra = q.campaigns.length - shown.length;
  const footer = extra > 0 ? `\n  …and ${extra} more campaign(s) with spend.` : "";
  return lines.join("\n") + footer;
}
