import { google, type sheets_v4 } from "googleapis";
import { env } from "./env.js";

/**
 * Shared "memory" for the agent team, backed by a single Google Sheet.
 *
 * Agents write their plans, data, and reports here so the operator can read
 * everything directly in the spreadsheet. Each kind of artifact lives on its
 * own tab (worksheet), e.g. "media-plan", "competitive-intel", "reports".
 *
 * Auth: a Google service account (JWT). Share the target spreadsheet with the
 * service account's email (GOOGLE_SHEETS_CLIENT_EMAIL) and grant it edit access.
 * No credentials are stored in this repo — they come from env vars at runtime.
 */

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

let cachedSheets: sheets_v4.Sheets | null = null;

/** Lazily build (and cache) an authenticated Sheets client. */
function getSheets(): sheets_v4.Sheets {
  if (cachedSheets) return cachedSheets;

  const auth = new google.auth.JWT({
    email: env.sheetsClientEmail(),
    key: env.sheetsPrivateKey(),
    scopes: SCOPES,
  });

  cachedSheets = google.sheets({ version: "v4", auth });
  return cachedSheets;
}

/** A row of cell values (strings, numbers, booleans). */
export type Row = (string | number | boolean)[];

/**
 * Read a range and return the raw 2D array of values.
 * @param range A1 notation, e.g. "media-plan!A1:F100" or just "media-plan".
 */
export async function readRange(range: string): Promise<Row[]> {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: env.sheetsSpreadsheetId(),
    range,
  });
  return (res.data.values as Row[] | undefined) ?? [];
}

/**
 * Read a tab and return its rows as objects keyed by the header row.
 * The first row of the range is treated as headers.
 */
export async function readAsObjects(
  range: string,
): Promise<Record<string, string>[]> {
  const rows = await readRange(range);
  if (rows.length === 0) return [];
  const [header, ...body] = rows;
  const keys = header.map((h) => String(h));
  return body.map((row) => {
    const obj: Record<string, string> = {};
    keys.forEach((key, i) => {
      obj[key] = row[i] !== undefined ? String(row[i]) : "";
    });
    return obj;
  });
}

/**
 * How cell values are interpreted on write (Google Sheets `valueInputOption`):
 *   - "USER_ENTERED": parsed as if typed in the UI — numeric-looking strings
 *     become numbers, leading "=" becomes a formula. Right for human-readable
 *     data (e.g. ₹ figures in media-plans).
 *   - "RAW": stored verbatim as text — no number/formula coercion. Right for
 *     opaque identifiers that must round-trip byte-identically (e.g. Slack
 *     thread timestamps like "1719761234.123456").
 */
export type ValueInputOption = "USER_ENTERED" | "RAW";

/**
 * Append rows to the bottom of a tab. Use this for log-style writes
 * (e.g. appending a new report or a new line of campaign data).
 *
 * `valueInputOption` defaults to "USER_ENTERED"; pass "RAW" when a value must be
 * preserved exactly (no numeric/formula coercion).
 */
export async function appendRows(
  range: string,
  rows: Row[],
  valueInputOption: ValueInputOption = "USER_ENTERED",
): Promise<void> {
  const sheets = getSheets();
  await sheets.spreadsheets.values.append({
    spreadsheetId: env.sheetsSpreadsheetId(),
    range,
    valueInputOption,
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows },
  });
}

/**
 * Overwrite a range with the given rows. Use this to (re)write a whole
 * section, e.g. replacing the current media plan.
 *
 * `valueInputOption` defaults to "USER_ENTERED"; pass "RAW" when a value must be
 * preserved exactly (no numeric/formula coercion).
 */
export async function writeRange(
  range: string,
  rows: Row[],
  valueInputOption: ValueInputOption = "USER_ENTERED",
): Promise<void> {
  const sheets = getSheets();
  await sheets.spreadsheets.values.update({
    spreadsheetId: env.sheetsSpreadsheetId(),
    range,
    valueInputOption,
    requestBody: { values: rows },
  });
}

/** Clear all values in a range (without deleting the tab). */
export async function clearRange(range: string): Promise<void> {
  const sheets = getSheets();
  await sheets.spreadsheets.values.clear({
    spreadsheetId: env.sheetsSpreadsheetId(),
    range,
  });
}

/**
 * Ensure a tab (worksheet) with the given title exists; create it if missing.
 * Safe to call repeatedly — a no-op if the tab already exists.
 */
export async function ensureTab(title: string): Promise<void> {
  const sheets = getSheets();
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: env.sheetsSpreadsheetId(),
  });
  const exists = meta.data.sheets?.some(
    (s) => s.properties?.title === title,
  );
  if (exists) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: env.sheetsSpreadsheetId(),
    requestBody: {
      requests: [{ addSheet: { properties: { title } } }],
    },
  });
}
