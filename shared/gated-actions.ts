import { ensureTab, readRange, appendRows } from "./google-sheets.js";
import { isSheetsConfigured } from "./env.js";

/**
 * Audit log for GATED write actions that were actually executed against Meta.
 *
 * Every live write (only ever run after an operator approval through the Slack
 * gate) appends one row here so the operator has a durable record of what changed
 * and when: action, campaign id/name, before → after, and a UTC timestamp. This
 * is write-only bookkeeping — it never touches Meta and has no ad/spend power.
 *
 * If Sheets isn't configured it's a safe no-op. Callers should still wrap it so a
 * logging hiccup can never undo or block the write it is recording.
 */

const TAB = "gated-actions";
const HEADER = ["timestamp", "action", "campaignId", "campaignName", "before", "after", "result"];

export interface GatedActionLog {
  action: string; // e.g. "pauseCampaign"
  campaignId: string;
  campaignName: string;
  before: string; // status/value before the write, e.g. "ACTIVE"
  after: string; // status/value after the write, e.g. "PAUSED"
  result: string; // "ok" or a short error note
}

/**
 * Append one gated-action row. Written "RAW" so the timestamp and campaign id
 * round-trip verbatim (no numeric/date coercion). Idempotency is not needed —
 * each executed write is a distinct event and should produce its own row.
 */
export async function logGatedAction(entry: GatedActionLog): Promise<void> {
  if (!isSheetsConfigured()) return;
  await ensureTab(TAB);
  const firstRow = await readRange(`${TAB}!A1:G1`);
  if (firstRow.length === 0) {
    await appendRows(`${TAB}!A1`, [HEADER]);
  }
  const row = [
    new Date().toISOString(),
    entry.action,
    entry.campaignId,
    entry.campaignName,
    entry.before,
    entry.after,
    entry.result,
  ];
  await appendRows(TAB, [row], "RAW");
}
