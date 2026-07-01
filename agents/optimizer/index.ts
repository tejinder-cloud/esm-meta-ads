import { getCampaign, getCampaignInsights, pauseCampaign } from "../../shared/meta.js";
import { ensureTab, readRange, readAsObjects, appendRows } from "../../shared/google-sheets.js";
import { logGatedAction } from "../../shared/gated-actions.js";
import { isSheetsConfigured } from "../../shared/env.js";

/**
 * Agent 9 — Optimizer (Phase B / B3, v1: NZ pilot only, SHADOW by default).
 *
 * A monitor that runs on a ~20-minute cycle and evaluates a few hard "breakers"
 * on the single pilot campaign. Its ONLY power in v1 is to PAUSE — never budget,
 * scaling, or launch ("gas"). And even pausing is gated behind arming:
 *
 *   - SHADOW (default, OPTIMIZER_ARMED=false): if an auto-pause breaker WOULD
 *     trip, it posts a "WOULD auto-pause" alert and logs it — but pauses NOTHING.
 *     It proves its judgment before it's ever allowed to act.
 *   - ARMED (OPTIMIZER_ARMED=true — a deliberate LATER step, kept OFF now): a
 *     tripped breaker autonomously calls pauseCampaign(execute=true) once, then
 *     stops acting on the campaign (no auto-resume, no loop).
 *
 * Breakers (v1), all on the pilot only, using the verified canonical lead metric
 * (onsite_conversion.lead_grouped) via the existing read layer. "TODAY" is Meta's
 * date_preset "today" (account is in India). All money is INR (₹).
 */

/** The ONLY campaign this agent may ever touch. */
export const PILOT_ID = "120245508604630532";
export const PILOT_FALLBACK_NAME = "New Zealand study visa AD Campaign - 15 June";

// --- Breaker thresholds (₹) ------------------------------------------------
// Auto-pause breakers (SHADOW would-alert; ARMED would-pause):
const ZERO_LEAD_SPEND = 500; // TODAY spend ≥ this AND 0 leads → auto-pause
const CPL_RUNAWAY_SPEND = 750; // TODAY spend ≥ this …
const CPL_MAX = 400; // … AND TODAY CPL > this → auto-pause
// Alert-only breaker (NEVER pauses):
const CPQL_MAX = 8600; // trailing-30d CPQL > this → directional alert only

const LOG_TAB = "optimizer-log";
const LOG_HEADERS = ["ts", "spend", "leads", "cpl", "breaker_state", "action"];

/** The two auto-pause breakers (the only ones that could ever pause). */
export type BreakerKey = "zero-lead-bleed" | "cpl-runaway";

// --- Assessment (read-only) ------------------------------------------------

export interface Assessment {
  name: string;
  status: string; // ACTIVE / PAUSED / …
  spendToday: number;
  leadsToday: number;
  cplToday: number | null; // null when 0 leads today
  spend30: number;
  qualified30: number;
  cpql30: number | null; // trailing-30d CPQL; directional
  zeroLeadBleed: boolean; // would-trip states
  cplRunaway: boolean;
  cpqlAlert: boolean;
}

/** Read the pilot's TODAY + trailing-30d numbers and evaluate the breakers. Read-only. */
export async function assess(): Promise<Assessment> {
  const [pilot, todayRows, d30Rows] = await Promise.all([
    getCampaign(PILOT_ID),
    getCampaignInsights("today"),
    getCampaignInsights("last_30d"),
  ]);

  const today = todayRows.find((c) => c.campaignId === PILOT_ID);
  const d30 = d30Rows.find((c) => c.campaignId === PILOT_ID);

  const spendToday = today?.spend ?? 0;
  const leadsToday = today?.leads ?? 0;
  const cplToday = today?.cpl ?? null;
  const spend30 = d30?.spend ?? 0;
  const qualified30 = d30?.qualified ?? 0;
  const cpql30 = d30?.cpql ?? null;

  return {
    name: pilot.name || PILOT_FALLBACK_NAME,
    status: pilot.status,
    spendToday,
    leadsToday,
    cplToday,
    spend30,
    qualified30,
    cpql30,
    zeroLeadBleed: spendToday >= ZERO_LEAD_SPEND && leadsToday === 0,
    // cplToday is null at 0 leads → CPL runaway can't fire there (that's the
    // zero-lead breaker's job); it needs real leads AND a CPL over the ceiling.
    cplRunaway: spendToday >= CPL_RUNAWAY_SPEND && cplToday !== null && cplToday > CPL_MAX,
    cpqlAlert: cpql30 !== null && cpql30 > CPQL_MAX,
  };
}

// --- Formatting ------------------------------------------------------------

function inr(n: number | null): string {
  return n == null ? "—" : "₹" + Math.round(n).toLocaleString("en-IN");
}

function breakerDesc(key: BreakerKey, a: Assessment): string {
  if (key === "zero-lead-bleed") {
    return `zero-lead bleed — spend ${inr(a.spendToday)} ≥ ₹${ZERO_LEAD_SPEND} with ${a.leadsToday} leads`;
  }
  return `CPL runaway — spend ${inr(a.spendToday)} ≥ ₹${CPL_RUNAWAY_SPEND}, CPL ${inr(a.cplToday)} > ₹${CPL_MAX}`;
}

/** Shared "(spend X, leads N, CPL Y)" tail used in the alerts. */
function stats(a: Assessment): string {
  return `spend ${inr(a.spendToday)}, leads ${a.leadsToday}, CPL ${inr(a.cplToday)}`;
}

function shadowMsg(key: BreakerKey, a: Assessment): string {
  return `⚠️ SHADOW — WOULD auto-pause NZ pilot: ${breakerDesc(key, a)} (${stats(a)}). Not paused (shadow mode).`;
}

function autoPausedMsg(key: BreakerKey, a: Assessment): string {
  return `🛑 AUTO-PAUSED NZ pilot: ${breakerDesc(key, a)} (${stats(a)}).`;
}

function cpqlMsg(a: Assessment): string {
  return (
    `⚠️ ALERT — NZ pilot trailing-30d CPQL ${inr(a.cpql30)} > ₹${CPQL_MAX.toLocaleString("en-IN")} ` +
    `(directional — Purchase event has an open data warning). Alert-only, not paused.`
  );
}

/** Human-readable one-pass report for the manual `optimizer:check` hook. */
export function formatCheck(a: Assessment): string {
  return [
    `NZ pilot — ${a.name} (${PILOT_ID})`,
    `  status:      ${a.status}`,
    ``,
    `TODAY (India tz):`,
    `  spend:       ${inr(a.spendToday)}`,
    `  leads:       ${a.leadsToday}`,
    `  CPL:         ${inr(a.cplToday)}`,
    ``,
    `Trailing 30 days:`,
    `  spend:       ${inr(a.spend30)}`,
    `  qualified:   ${a.qualified30}`,
    `  CPQL:        ${inr(a.cpql30)}  (directional — Purchase event has an open data warning)`,
    ``,
    `Breakers:`,
    `  zero-lead bleed  (spend ≥ ₹${ZERO_LEAD_SPEND} & 0 leads):     ${a.zeroLeadBleed ? "WOULD TRIP ⚠️" : "ok"}`,
    `  CPL runaway      (spend ≥ ₹${CPL_RUNAWAY_SPEND} & CPL > ₹${CPL_MAX}):  ${a.cplRunaway ? "WOULD TRIP ⚠️" : "ok"}`,
    `  CPQL alert-only  (30d CPQL > ₹${CPQL_MAX}):        ${a.cpqlAlert ? "ALERT ⚠️" : "ok"}`,
  ].join("\n");
}

// --- Date + de-dup ---------------------------------------------------------

/** Today's date (YYYY-MM-DD) in IST — the "per day" boundary for alert de-dup. */
function istTodayISO(now: Date = new Date()): string {
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

/** IST calendar date of an ISO timestamp (for reading de-dup state back). */
function istDateOf(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Date(t + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// In-process de-dup backstop (works even if Sheets is off); the optimizer-log tab
// is the durable source of truth across restarts.
const alertedInProcess = new Set<string>();

/** True if this breaker has already alerted today (durable log or in-process). */
async function alreadyAlertedToday(breakerState: string, sheets: boolean): Promise<boolean> {
  const key = `${istTodayISO()}:${breakerState}`;
  if (alertedInProcess.has(key)) return true;
  if (sheets) {
    const rows = await readAsObjects(LOG_TAB);
    const today = istTodayISO();
    if (rows.some((r) => istDateOf(r.ts ?? "") === today && (r.breaker_state ?? "") === breakerState)) {
      return true;
    }
  }
  return false;
}

function markAlerted(breakerState: string): void {
  alertedInProcess.add(`${istTodayISO()}:${breakerState}`);
}

// --- optimizer-log tab -----------------------------------------------------

async function ensureLogTab(): Promise<void> {
  await ensureTab(LOG_TAB);
  const firstRow = await readRange(`${LOG_TAB}!A1:F1`);
  if (firstRow.length === 0) {
    await appendRows(`${LOG_TAB}!A1`, [LOG_HEADERS]);
  }
}

/** Append one optimizer-log row (RAW so ts round-trips verbatim). */
async function appendLog(a: Assessment, breakerState: string, action: string): Promise<void> {
  const row = [
    new Date().toISOString(),
    a.spendToday.toFixed(2),
    String(a.leadsToday),
    a.cplToday == null ? "" : a.cplToday.toFixed(2),
    breakerState,
    action,
  ];
  await appendRows(LOG_TAB, [row], "RAW");
}

// --- Orchestrator (one scheduled pass) -------------------------------------

export interface OptimizerPassOptions {
  /** Posts an alert to #esm-meta-ads. Supplied by the runtime/script. */
  postMessage: (text: string) => Promise<void>;
  /**
   * OPTIMIZER_ARMED. false = SHADOW (alert only). true = autonomous auto-pause.
   * Kept false everywhere in B3; arming is a deliberate later step.
   */
  armed: boolean;
}

/**
 * Run ONE monitor pass on the NZ pilot. Fully wrapped: any failure logs and
 * returns — it never crashes the runtime and never writes on error. Only ever
 * acts on the ACTIVE pilot (never pauses an already-paused campaign), only ever
 * pauses (no budget/scaling/launch), and pauses only when ARMED.
 */
export async function runOptimizerPass(opts: OptimizerPassOptions): Promise<void> {
  const { postMessage, armed } = opts;
  try {
    const a = await assess();

    // Only monitor the ACTIVE pilot. If it's already PAUSED (manually or by a
    // prior armed auto-pause) there's nothing to protect — and this is exactly
    // how the armed path "stops acting" after its one pause: no re-pause, no loop.
    if (a.status !== "ACTIVE") {
      console.log(`🛰️  Optimizer: NZ pilot is ${a.status} — skipping (monitors only while ACTIVE).`);
      return;
    }

    const sheets = isSheetsConfigured();
    if (sheets) await ensureLogTab();

    // --- Auto-pause breakers -------------------------------------------------
    const tripped: BreakerKey[] = [];
    if (a.zeroLeadBleed) tripped.push("zero-lead-bleed");
    if (a.cplRunaway) tripped.push("cpl-runaway");

    if (tripped.length > 0) {
      if (armed) {
        // ARMED (OFF in B3): one autonomous pause, log to BOTH tabs, then stop.
        const key = tripped[0]; // one pause is enough; act on the first breaker
        const action = await pauseCampaign(PILOT_ID, true); // execute=true — gated by arming
        console.log("Optimizer auto-pause response:", JSON.stringify(action.response));
        try {
          await logGatedAction({
            action: "pauseCampaign",
            campaignId: PILOT_ID,
            campaignName: a.name,
            before: action.before.status,
            after: "PAUSED",
            result: `optimizer:${key}`,
          });
        } catch (err) {
          console.warn(`⚠️  gated-actions log failed (pause already done): ${err instanceof Error ? err.message : err}`);
        }
        if (sheets) await appendLog(a, key, "auto-paused");
        await postMessage(autoPausedMsg(key, a));
        // Stop acting on this campaign. It's now PAUSED, so later passes skip above.
        return;
      }

      // SHADOW: alert (once per breaker per day) and log — but pause NOTHING.
      for (const key of tripped) {
        if (await alreadyAlertedToday(key, sheets)) continue; // de-dup
        await postMessage(shadowMsg(key, a));
        if (sheets) await appendLog(a, key, "shadow-would-pause");
        markAlerted(key);
      }
    }

    // --- CPQL: alert-only, never pauses -------------------------------------
    if (a.cpqlAlert) {
      const state = "cpql-directional";
      if (!(await alreadyAlertedToday(state, sheets))) {
        await postMessage(cpqlMsg(a));
        if (sheets) await appendLog(a, state, "alert");
        markAlerted(state);
      }
    }
  } catch (err) {
    // A failed pass logs and continues — never crash the runtime, never write on error.
    console.error("⚠️ Optimizer pass failed:", err instanceof Error ? err.message : err);
  }
}
