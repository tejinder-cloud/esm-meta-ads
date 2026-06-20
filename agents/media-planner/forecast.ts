/**
 * Deterministic, benchmark-seeded forecasting for the Media Planner.
 *
 * The LLM no longer invents forecast numbers (they used to move illogically —
 * e.g. lower budget producing higher reach). Instead the LLM extracts the
 * structured inputs and the code computes every number from category benchmark
 * ranges, so the figures always move logically:
 *   - lower budget  → lower impressions, reach, and results
 *   - tighter geo   → higher frequency → lower reach
 *   - cost-per-result and ROAS are efficiency metrics (independent of budget)
 *
 * Benchmarks are for India — education / study-abroad. They are assumptions, not
 * guarantees; they are documented in CLAUDE.md so they stay consistent and easy
 * to adjust. Keep this file and CLAUDE.md in sync.
 */

export type Objective = "leads" | "purchases" | "traffic";
export type GeoTightness = "broad" | "medium" | "tight";

export interface Range {
  low: number;
  mid: number;
  high: number;
}

/** India education / study-abroad benchmarks. Adjustable — mirror in CLAUDE.md. */
export const BENCHMARKS = {
  // ₹ per 1,000 impressions.
  cpmInr: { low: 80, mid: 150, high: 250 } as Range,
  // ₹ cost per result, by objective (CPL / CPA / CPC).
  costPerResultInr: {
    leads: { low: 250, mid: 450, high: 700 },
    purchases: { low: 900, mid: 1800, high: 3200 },
    traffic: { low: 4, mid: 10, high: 22 },
  } as Record<Objective, Range>,
  // Assumed revenue value per result, used only for ROAS (the softest assumption).
  // Traffic has no conversion value → ROAS is not applicable.
  valuePerResultInr: {
    leads: { low: 1200, mid: 2500, high: 4500 },
    purchases: { low: 2500, mid: 5000, high: 9000 },
  } as Partial<Record<Objective, Range>>,
  // Impressions per unique person over the flight, by geo tightness.
  // Tighter geo = fewer unique people = higher frequency = lower reach.
  frequencyByGeo: { broad: 1.4, medium: 2.0, tight: 3.0 } as Record<GeoTightness, number>,
  // Budget split: a small test phase, then scale.
  testBudgetShare: 0.2,
  maxTestDays: 7,
};

export const RESULT_LABELS: Record<Objective, { result: string; cost: string }> = {
  leads: { result: "Leads", cost: "Cost per lead" },
  purchases: { result: "Purchases", cost: "Cost per purchase" },
  traffic: { result: "Clicks", cost: "Cost per click" },
};

export interface ForecastInputs {
  totalBudgetInr: number;
  timeframeDays: number;
  objective: Objective;
  geoTightness: GeoTightness;
}

export interface BudgetSplit {
  testDays: number;
  testBudget: number;
  testDaily: number;
  scaleDays: number;
  scaleBudget: number;
  scaleDaily: number;
}

export interface Forecast {
  impressions: Range;
  reach: Range;
  results: Range;
  costPerResultInr: Range;
  roas: Range | null;
  valuePerResultUsed: Range | null;
}

function roundTo(n: number, step: number): number {
  return Math.round(n / step) * step;
}

function roundResults(n: number): number {
  return n >= 100 ? roundTo(n, 5) : Math.max(0, Math.round(n));
}

/** Small test phase up front, the rest to scale. Daily ₹ derived from totals. */
export function computeBudgetSplit(totalBudgetInr: number, timeframeDays: number): BudgetSplit {
  const days = Math.max(1, Math.round(timeframeDays));
  const testDays = days <= 7 ? Math.max(1, Math.floor(days / 3)) : BENCHMARKS.maxTestDays;
  const scaleDays = Math.max(1, days - testDays);
  const testBudget = Math.round(totalBudgetInr * BENCHMARKS.testBudgetShare);
  const scaleBudget = Math.max(0, totalBudgetInr - testBudget);
  return {
    testDays,
    testBudget,
    testDaily: Math.round(testBudget / testDays),
    scaleDays,
    scaleBudget,
    scaleDaily: Math.round(scaleBudget / scaleDays),
  };
}

/**
 * Compute the forecast deterministically from total budget, objective, and geo.
 * Ranges come from the benchmark CPM / cost-per-result spread; lower cost → more
 * volume (so the high estimate uses the low cost, and vice-versa).
 */
export function computeForecast(inp: ForecastInputs): Forecast {
  const B = Math.max(0, inp.totalBudgetInr);
  const cpm = BENCHMARKS.cpmInr;
  const freq = BENCHMARKS.frequencyByGeo[inp.geoTightness];
  const cpr = BENCHMARKS.costPerResultInr[inp.objective];

  // impressions = budget / CPM * 1000 — low CPM yields the high estimate.
  const impressions: Range = {
    low: roundTo((B / cpm.high) * 1000, 1000),
    mid: roundTo((B / cpm.mid) * 1000, 1000),
    high: roundTo((B / cpm.low) * 1000, 1000),
  };

  // reach = impressions / frequency — tighter geo (higher freq) lowers reach.
  const reach: Range = {
    low: roundTo(impressions.low / freq, 1000),
    mid: roundTo(impressions.mid / freq, 1000),
    high: roundTo(impressions.high / freq, 1000),
  };

  // results = budget / cost-per-result — low cost yields the high estimate.
  const results: Range = {
    low: roundResults(B / cpr.high),
    mid: roundResults(B / cpr.mid),
    high: roundResults(B / cpr.low),
  };

  const costPerResultInr: Range = { low: cpr.low, mid: cpr.mid, high: cpr.high };

  // ROAS = value-per-result / cost-per-result (efficiency; independent of budget).
  const value = BENCHMARKS.valuePerResultInr[inp.objective] ?? null;
  const roas: Range | null = value
    ? {
        low: Number((value.low / cpr.high).toFixed(1)),
        mid: Number((value.mid / cpr.mid).toFixed(1)),
        high: Number((value.high / cpr.low).toFixed(1)),
      }
    : null;

  return { impressions, reach, results, costPerResultInr, roas, valuePerResultUsed: value };
}

// --- Formatting (INR with Indian grouping) ---------------------------------

const inr = new Intl.NumberFormat("en-IN");

export function money(n: number): string {
  return `₹${inr.format(Math.round(n))}`;
}
export function num(n: number): string {
  return inr.format(Math.round(n));
}
export function moneyRange(r: Range): string {
  return `${money(r.low)} – ${money(r.mid)} – ${money(r.high)}`;
}
export function numRange(r: Range): string {
  return `${num(r.low)} – ${num(r.mid)} – ${num(r.high)}`;
}
export function roasRange(r: Range): string {
  return `${r.low.toFixed(1)}x – ${r.mid.toFixed(1)}x – ${r.high.toFixed(1)}x`;
}

/** Render the budget-split section (deterministic daily ₹ amounts). */
export function formatBudgetSplit(split: BudgetSplit, totalBudgetInr: number): string {
  return [
    `*Budget split* (total ${money(totalBudgetInr)})`,
    `• *Test phase* — first ${split.testDays} day${split.testDays === 1 ? "" : "s"}: ${money(split.testBudget)} (~${money(split.testDaily)}/day)`,
    `• *Scale phase* — remaining ${split.scaleDays} day${split.scaleDays === 1 ? "" : "s"}: ${money(split.scaleBudget)} (~${money(split.scaleDaily)}/day)`,
  ].join("\n");
}

/** Render the forecast section (deterministic, benchmark-based ranges). */
export function formatForecast(forecast: Forecast, objective: Objective): string {
  const labels = RESULT_LABELS[objective];
  const lines = [
    "*Forecast (low – mid – high)* — directional, benchmark-based; tightens as real account data comes in",
    `• Impressions: ${numRange(forecast.impressions)}`,
    `• Reach: ${numRange(forecast.reach)} people`,
    `• ${labels.result}: ${numRange(forecast.results)}`,
    `• ${labels.cost}: ${moneyRange(forecast.costPerResultInr)}`,
  ];
  if (forecast.roas && forecast.valuePerResultUsed) {
    lines.push(`• ROAS: ${roasRange(forecast.roas)}`);
    lines.push(
      `  _ROAS assumes ~${moneyRange(forecast.valuePerResultUsed)} revenue value per result — the softest assumption here; adjust once you know your real value per result._`,
    );
  } else {
    lines.push("• ROAS: not applicable for a traffic objective (no conversion value).");
  }
  return lines.join("\n");
}
