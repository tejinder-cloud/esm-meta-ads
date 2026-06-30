import {
  ensureTab,
  readAsObjects,
  appendRows,
  writeRange,
  clearRange,
  type Row,
} from "./google-sheets.js";
import { isSheetsConfigured } from "./env.js";

/**
 * Durable store for pending operator approvals, backed by a Google Sheet tab.
 *
 * The runtime keeps conversation state in an in-memory Map (the fast path), but
 * an operator's approval window can be 1–6 hours — long enough that a Railway
 * restart would silently drop a proposed plan that's still awaiting "approve".
 * This store mirrors each in-flight approval to the "pending-approvals" tab so
 * the runtime can rehydrate the Map on startup. It never touches Meta and has no
 * ad/spend capability — it only saves and restores conversation state.
 *
 * If Sheets isn't configured, every function is a safe no-op (logs once, returns
 * empty) so the service still runs fully in-memory.
 */

const TAB = "pending-approvals";
const HEADER = ["threadRoot", "agent", "phase", "lastPlan", "transcriptJson", "updatedAt"];

/** One line of the saved conversation transcript. */
export interface ApprovalTurn {
  who: string;
  text: string;
}

/** A pending approval as stored on (and read back from) the Sheet. */
export interface PendingApproval {
  threadRoot: string;
  agent: string;
  phase: string;
  lastPlan: string;
  transcript: ApprovalTurn[];
  updatedAt: string;
}

/** What the caller supplies to save — updatedAt is stamped by the store. */
export type PendingApprovalInput = Omit<PendingApproval, "updatedAt">;

// --- "Sheets not configured" → safe no-op (logged once) --------------------

let warnedNoSheets = false;

function sheetsReady(): boolean {
  if (isSheetsConfigured()) return true;
  if (!warnedNoSheets) {
    warnedNoSheets = true;
    console.log(
      "ℹ️  Google Sheets not configured — pending approvals stay in-memory only and will not survive a restart. (Set GOOGLE_SHEETS_* to enable durability.)",
    );
  }
  return false;
}

// --- Row <-> record conversion ---------------------------------------------

/**
 * Write approval rows with valueInputOption "RAW" (never "USER_ENTERED").
 *
 * Guard against silently reintroducing the numeric-coercion bug: the threadRoot
 * is a Slack timestamp like "1719761234.123456". Under "USER_ENTERED" Sheets
 * parses that numeric-looking string into a (lossy) number, and the default
 * FORMATTED_VALUE read hands back a rounded string — so the restored Map key no
 * longer equals the live thread and post-restart "approve" misses the planner.
 * "RAW" stores every field verbatim as text, so threadRoot (and lastPlan /
 * transcriptJson, which could otherwise start with "=" and become a formula)
 * round-trip byte-identically. All approvals writes MUST use this constant.
 */
const APPROVALS_INPUT_OPTION = "RAW" as const;

function toRow(r: PendingApproval): Row {
  return [r.threadRoot, r.agent, r.phase, r.lastPlan, JSON.stringify(r.transcript), r.updatedAt];
}

function fromObject(o: Record<string, string>): PendingApproval {
  let transcript: ApprovalTurn[] = [];
  try {
    const parsed = JSON.parse(o.transcriptJson || "[]");
    if (Array.isArray(parsed)) {
      transcript = parsed.map((t) => ({ who: String(t?.who ?? ""), text: String(t?.text ?? "") }));
    }
  } catch {
    transcript = []; // corrupt/blank JSON → empty transcript, never throw
  }
  return {
    threadRoot: o.threadRoot ?? "",
    agent: o.agent ?? "",
    phase: o.phase ?? "",
    lastPlan: o.lastPlan ?? "",
    transcript,
    updatedAt: o.updatedAt ?? "",
  };
}

// --- Public API ------------------------------------------------------------

/** Ensure the tab exists and carries the header row. Idempotent. */
export async function ensureApprovalsTab(): Promise<void> {
  if (!sheetsReady()) return;
  await ensureTab(TAB);
  // Writing A1:F1 only touches the header cells; any data rows below are left
  // intact. Safe to call repeatedly — it just re-asserts the header.
  await writeRange(`${TAB}!A1:F1`, [HEADER]);
}

/** Upsert a pending approval by threadRoot (overwrite the match, else append). */
export async function savePendingApproval(input: PendingApprovalInput): Promise<void> {
  if (!sheetsReady()) return;
  await ensureApprovalsTab();
  const record: PendingApproval = { ...input, updatedAt: new Date().toISOString() };
  const rows = await readAsObjects(TAB);
  const idx = rows.findIndex((o) => (o.threadRoot ?? "") === input.threadRoot);
  if (idx >= 0) {
    const rowNum = idx + 2; // +1 for the header row, +1 for 1-based indexing
    await writeRange(`${TAB}!A${rowNum}:F${rowNum}`, [toRow(record)], APPROVALS_INPUT_OPTION);
  } else {
    await appendRows(TAB, [toRow(record)], APPROVALS_INPUT_OPTION);
  }
}

/** Return all pending approvals as typed records (transcript parsed safely). */
export async function listPendingApprovals(): Promise<PendingApproval[]> {
  if (!sheetsReady()) return [];
  await ensureApprovalsTab();
  const rows = await readAsObjects(TAB);
  return rows.filter((o) => (o.threadRoot ?? "").trim() !== "").map(fromObject);
}

/** Remove one thread's pending approval (rewrites the survivors contiguously). */
export async function clearPendingApproval(threadRoot: string): Promise<void> {
  if (!sheetsReady()) return;
  await ensureApprovalsTab();
  const rows = await readAsObjects(TAB);
  const remaining = rows
    .filter((o) => (o.threadRoot ?? "").trim() !== "" && o.threadRoot !== threadRoot)
    .map(fromObject);
  // Clear every data row (keep the header), then write the survivors back.
  await clearRange(`${TAB}!A2:F`);
  if (remaining.length > 0) {
    await writeRange(`${TAB}!A2`, remaining.map(toRow), APPROVALS_INPUT_OPTION);
  }
}
