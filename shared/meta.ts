import { env } from "./env.js";

/**
 * Read-only access to the Meta (Facebook / Instagram) Marketing API.
 *
 * This file ONLY READS data from the ESM Overseas ad account — it never creates,
 * edits, pauses, or spends. Agents use these functions to see live performance;
 * the spending ("write") layer is added later (Phase B) behind approval gates.
 *
 * Auth: a Meta Marketing API access token + the ad account id (act_...), both
 * from environment variables (see .env.example). Money is in INR (₹).
 */

// Bump if Meta deprecates the version: developers.facebook.com/docs/graph-api/changelog
const META_API_VERSION = "v21.0";
const GRAPH = `https://graph.facebook.com/${META_API_VERSION}`;

/** Reporting windows we use. */
export type DatePreset =
  | "today"
  | "yesterday"
  | "last_7d"
  | "last_14d"
  | "last_30d"
  | "this_month"
  | "last_month";

/**
 * The single canonical action type for a de-duplicated lead.
 *
 * Meta reports the SAME leads under several overlapping action_type names
 * (`lead`, `offsite_*_add_meta_leads`, etc.), each carrying the identical value,
 * so summing them double-counts. `onsite_conversion.lead_grouped` is Meta's
 * grouped on-Facebook Instant-Form lead metric — the de-duplicated total shown
 * in the Ads Manager "Leads" column. Ads Manager showed 149 leads for last_7d
 * (verified 2026-06-25), which this single type matches exactly.
 */
const CANONICAL_LEAD_ACTION_TYPE = "onsite_conversion.lead_grouped";

/**
 * The single canonical action type for a "qualified lead".
 *
 * A GHL contact manually tagged `qualified` (within 7 days of entry) fires a Meta
 * CAPI event as a PURCHASE on the dataset "ESM Conversion API - Pixel". In the
 * Insights API that surfaces as the pixel purchase conversion
 * `offsite_conversion.fb_pixel_purchase`. Meta reports the SAME purchases under
 * several overlapping action types (`purchase`, `omni_purchase`,
 * `onsite_web_purchase`, …), each carrying the identical value, so summing them
 * double-counts — we count this ONE pixel-source type, exactly the disciplined
 * way leads use `onsite_conversion.lead_grouped` (verified 2026-07-01: all
 * purchase types read 14 for 2026-06-02..29 — a single underlying source).
 */
const CANONICAL_QUALIFIED_ACTION_TYPE = "offsite_conversion.fb_pixel_purchase";

/**
 * Attribution windows for the qualified/purchase read.
 *
 * The `qualified` tag is applied by a human up to 7 days after the lead enters,
 * so the Purchase event lands OUTSIDE the account's default click window and is
 * INVISIBLE under default attribution (verified: purchases return 0 under default,
 * but 14 under 28d_click for 2026-06-02..29). We therefore read the widest click
 * window (`28d_click`, which is cumulative — it already includes 1d/7d) plus the
 * view window (`28d_view`). Click and view are mutually exclusive channels — a
 * conversion is attributed to one or the other, never both — so combining these
 * two is NOT the overlapping-action-type double-count that the lead metric avoids.
 * Requesting these windows does not change the top-level `value` used for leads
 * (verified: `lead_grouped` value stays 797 for last_30d with or without them).
 */
const QUALIFIED_ATTRIBUTION_WINDOWS = ["28d_click", "28d_view"] as const;

interface MetaAction {
  action_type: string;
  value: string;
  // Per-attribution-window counts (e.g. "28d_click") appear when
  // action_attribution_windows is requested; absent windows mean zero.
  [window: string]: string | undefined;
}

/** Low-level GET against the Graph API with friendly error handling. */
async function metaGet(path: string, params: Record<string, string>): Promise<any> {
  const url = new URL(`${GRAPH}/${path}`);
  url.search = new URLSearchParams({
    ...params,
    access_token: env.metaAccessToken(),
  }).toString();

  const res = await fetch(url);
  const data = (await res.json()) as any;

  if (!res.ok || data?.error) {
    const message = data?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(`Meta API error: ${message}`);
  }
  return data;
}

/** Count leads from the single canonical (de-duplicated) action type only. */
function sumLeads(actions: MetaAction[] | undefined): number {
  if (!actions) return 0;
  const row = actions.find((a) => a.action_type === CANONICAL_LEAD_ACTION_TYPE);
  return row ? Number(row.value) || 0 : 0;
}

/**
 * Count qualified leads (purchases) from the single canonical purchase action
 * type, combining its 28d click + 28d view attribution buckets. Returns 0 when
 * the action type is absent (signal not detected) — callers treat 0 as "no
 * quality signal" rather than a real ₹0 CPQL. Never sums across purchase types.
 */
function sumQualified(actions: MetaAction[] | undefined): number {
  if (!actions) return 0;
  const row = actions.find((a) => a.action_type === CANONICAL_QUALIFIED_ACTION_TYPE);
  if (!row) return 0;
  return QUALIFIED_ATTRIBUTION_WINDOWS.reduce((sum, w) => sum + (Number(row[w]) || 0), 0);
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// --- Account-level insights ------------------------------------------------

export interface AccountInsights {
  datePreset: DatePreset;
  spend: number; // ₹
  impressions: number;
  clicks: number;
  ctr: number; // %
  cpc: number; // ₹ per click
  leads: number;
  cpl: number | null; // ₹ per lead; null when there are no leads yet
  qualified: number; // qualified leads (canonical purchase conversions) for the window
  cpql: number | null; // ₹ per qualified lead; null when qualified is 0 (signal not detected)
}

/** Whole-account performance for a date window. Insights `spend` is in rupees. */
export async function getAccountInsights(
  datePreset: DatePreset = "last_7d",
): Promise<AccountInsights> {
  const accountId = env.metaAdAccountId(); // e.g. act_1234567890
  const data = await metaGet(`${accountId}/insights`, {
    level: "account",
    date_preset: datePreset,
    fields: "spend,impressions,clicks,ctr,cpc,actions",
    // Surfaces the qualified/purchase 28d windows without changing the default
    // `value` that leads read (see QUALIFIED_ATTRIBUTION_WINDOWS).
    action_attribution_windows: JSON.stringify([...QUALIFIED_ATTRIBUTION_WINDOWS]),
  });

  const row = (data.data?.[0] ?? {}) as Record<string, unknown> & { actions?: MetaAction[] };
  const spend = num(row.spend);
  const leads = sumLeads(row.actions);
  const qualified = sumQualified(row.actions);

  return {
    datePreset,
    spend,
    impressions: num(row.impressions),
    clicks: num(row.clicks),
    ctr: num(row.ctr),
    cpc: num(row.cpc),
    leads,
    cpl: leads > 0 ? spend / leads : null,
    qualified,
    cpql: qualified > 0 ? spend / qualified : null,
  };
}

// --- Per-campaign insights -------------------------------------------------

export interface CampaignInsight {
  campaignId: string;
  campaignName: string;
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number;
  leads: number;
  cpl: number | null;
  qualified: number; // qualified leads (canonical purchase conversions) for the window
  // ₹ per qualified lead; null when qualified is 0. DIRECTIONAL at campaign level:
  // depends on CAPI match quality (currently imperfect), so it can under-attribute.
  cpql: number | null;
}

/** Performance broken down per campaign for a date window. */
export async function getCampaignInsights(
  datePreset: DatePreset = "last_7d",
): Promise<CampaignInsight[]> {
  const accountId = env.metaAdAccountId();
  const data = await metaGet(`${accountId}/insights`, {
    level: "campaign",
    date_preset: datePreset,
    fields: "campaign_id,campaign_name,spend,impressions,clicks,ctr,actions",
    action_attribution_windows: JSON.stringify([...QUALIFIED_ATTRIBUTION_WINDOWS]),
    limit: "200",
  });

  const rows = (data.data ?? []) as (Record<string, unknown> & { actions?: MetaAction[] })[];
  return rows.map((row) => {
    const spend = num(row.spend);
    const leads = sumLeads(row.actions);
    const qualified = sumQualified(row.actions);
    return {
      campaignId: String(row.campaign_id ?? ""),
      campaignName: String(row.campaign_name ?? ""),
      spend,
      impressions: num(row.impressions),
      clicks: num(row.clicks),
      ctr: num(row.ctr),
      leads,
      cpl: leads > 0 ? spend / leads : null,
      qualified,
      cpql: qualified > 0 ? spend / qualified : null,
    };
  });
}

// --- Campaign list (status + daily budget) ---------------------------------

export interface Campaign {
  id: string;
  name: string;
  status: string; // ACTIVE, PAUSED, ARCHIVED, ...
  dailyBudget: number | null; // ₹ (null if budget is set at ad-set level)
}

/** List campaigns with status and daily budget. Meta returns budgets in paise (₹×100). */
export async function listCampaigns(): Promise<Campaign[]> {
  const accountId = env.metaAdAccountId();
  const data = await metaGet(`${accountId}/campaigns`, {
    fields: "id,name,status,daily_budget",
    limit: "200",
  });

  const rows = (data.data ?? []) as Record<string, unknown>[];
  return rows.map((row) => {
    const raw = row.daily_budget;
    return {
      id: String(row.id ?? ""),
      name: String(row.name ?? ""),
      status: String(row.status ?? ""),
      dailyBudget: raw !== undefined && raw !== null ? num(raw) / 100 : null,
    };
  });
}

/**
 * Read ONE campaign's current status + daily budget (₹). Read-only (GET). Used
 * by the write layer below to make the dry-run printout realistic — it shows the
 * current value alongside the change each action WOULD make.
 */
export async function getCampaign(campaignId: string): Promise<Campaign> {
  const data = await metaGet(campaignId, { fields: "id,name,status,daily_budget" });
  const raw = data.daily_budget;
  return {
    id: String(data.id ?? campaignId),
    name: String(data.name ?? ""),
    status: String(data.status ?? ""),
    dailyBudget: raw !== undefined && raw !== null ? num(raw) / 100 : null,
  };
}

// ===========================================================================
// WRITE layer (Phase B, step B1) — DRY-RUN BY DEFAULT.
//
// Every write function takes `execute: boolean` defaulting to FALSE. In dry-run
// (the default) it performs NO write: it fetches the campaign's current state
// (a READ, for a realistic printout), builds the exact request it WOULD POST,
// console.logs + returns it, and sends nothing that changes the account.
//
// The real POST path exists for execute=true, but per the Phase B guardrails
// live execution is APPROVAL-GATED and is wired in a LATER step. In B1 NOTHING
// calls any write function with execute=true — the whole account stays untouched.
//
// The three actions are deliberately reversible: pause ↔ resume, and a budget
// change can be set back to its prior ₹ value.
// ===========================================================================

/** The exact write a function would (dry-run) or did (execute) issue. */
export interface WriteAction {
  method: "POST";
  path: string; // Graph node path, e.g. "/1203..."
  params: Record<string, string>; // write params, e.g. { status: "PAUSED" }
  executed: boolean; // false in dry-run (nothing sent); true only on a live POST
  summary: string; // human-readable one-liner (also console.logged)
}

/** Render params like `{ status: 'PAUSED' }` for the printout. */
function formatParams(params: Record<string, string>): string {
  const inner = Object.entries(params)
    .map(([k, v]) => `${k}: '${v}'`)
    .join(", ");
  return `{ ${inner} }`;
}

/**
 * Low-level POST against the Graph API. THIS IS THE ONLY WRITE PATH to Meta.
 *
 * Reached ONLY when a write function is called with execute=true. Live execution
 * is approval-gated (see the Phase B guardrails) and gets wired behind that gate
 * in a later step; no code in B1 calls a write function with execute=true, so
 * this never runs in this step.
 */
async function metaPost(path: string, params: Record<string, string>): Promise<any> {
  const url = new URL(`${GRAPH}/${path}`);
  const body = new URLSearchParams({ ...params, access_token: env.metaAccessToken() });
  const res = await fetch(url, { method: "POST", body });
  const data = (await res.json()) as any;
  if (!res.ok || data?.error) {
    const message = data?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(`Meta API write error: ${message}`);
  }
  return data;
}

/**
 * Core of every write action. Reads current state (dry-run safe), then either
 * prints the intended request (execute=false) or performs the single live POST
 * (execute=true — gated, not used in B1).
 */
async function performWrite(
  campaignId: string,
  params: Record<string, string>,
  describeChange: (current: Campaign) => string,
  execute: boolean,
): Promise<WriteAction> {
  // READ current state — the only network call in dry-run. Never a write.
  const current = await getCampaign(campaignId);
  const path = `/${campaignId}`;
  const change = describeChange(current);

  if (!execute) {
    const summary = `DRY-RUN — would POST ${path} ${formatParams(params)}  (${change}) — nothing sent.`;
    console.log(summary);
    return { method: "POST", path, params, executed: false, summary };
  }

  // --- LIVE EXECUTION (gated) ---------------------------------------------
  // Real write path. Deliberately NOT exercised in B1: no caller passes
  // execute=true. Wired behind the operator approval gate in a later Phase B
  // step. This is the single point where the account is actually mutated.
  await metaPost(campaignId, params);
  const summary = `EXECUTED — POST ${path} ${formatParams(params)}  (${change})`;
  console.log(summary);
  return { method: "POST", path, params, executed: true, summary };
}

/** Would set a campaign's status to PAUSED. Dry-run by default (nothing sent). */
export function pauseCampaign(campaignId: string, execute = false): Promise<WriteAction> {
  return performWrite(campaignId, { status: "PAUSED" }, (c) => `status ${c.status} → PAUSED`, execute);
}

/** Would set a campaign's status to ACTIVE. Dry-run by default (nothing sent). */
export function resumeCampaign(campaignId: string, execute = false): Promise<WriteAction> {
  return performWrite(campaignId, { status: "ACTIVE" }, (c) => `status ${c.status} → ACTIVE`, execute);
}

/**
 * Would set a campaign's daily budget. Meta stores budgets in paise, so rupees
 * are converted ₹×100. Dry-run by default (nothing sent).
 */
export function setCampaignDailyBudget(
  campaignId: string,
  rupees: number,
  execute = false,
): Promise<WriteAction> {
  const paise = Math.round(rupees * 100);
  return performWrite(
    campaignId,
    { daily_budget: String(paise) },
    (c) =>
      `daily budget ${c.dailyBudget == null ? "(ad-set level)" : "₹" + c.dailyBudget} → ₹${rupees} (${paise} paise)`,
    execute,
  );
}
