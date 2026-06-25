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

interface MetaAction {
  action_type: string;
  value: string;
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
  });

  const row = (data.data?.[0] ?? {}) as Record<string, unknown> & { actions?: MetaAction[] };
  const spend = num(row.spend);
  const leads = sumLeads(row.actions);

  return {
    datePreset,
    spend,
    impressions: num(row.impressions),
    clicks: num(row.clicks),
    ctr: num(row.ctr),
    cpc: num(row.cpc),
    leads,
    cpl: leads > 0 ? spend / leads : null,
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
    limit: "200",
  });

  const rows = (data.data ?? []) as (Record<string, unknown> & { actions?: MetaAction[] })[];
  return rows.map((row) => {
    const spend = num(row.spend);
    const leads = sumLeads(row.actions);
    return {
      campaignId: String(row.campaign_id ?? ""),
      campaignName: String(row.campaign_name ?? ""),
      spend,
      impressions: num(row.impressions),
      clicks: num(row.clicks),
      ctr: num(row.ctr),
      leads,
      cpl: leads > 0 ? spend / leads : null,
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
