import "dotenv/config";

/**
 * Typed, centralized access to environment variables.
 * See .env.example for the full list and descriptions.
 *
 * Secrets are split into two tiers:
 *   - REQUIRED: needed for the service to run at all (Anthropic + Slack).
 *     validateEnv() fails fast with a friendly, complete list if any are missing.
 *   - OPTIONAL_FEATURES: power features not wired up yet (Meta, Google Sheets,
 *     Gemini). If missing, the service still starts; optionalFeatureStatus()
 *     reports which features aren't configured so the runtime can log a note.
 *
 * The rest of the codebase never touches process.env directly. A feature's
 * getter still throws MissingEnvError if called while unconfigured, so an agent
 * can't silently use an absent secret.
 */

/** Thrown when one or more required environment variables are missing. */
export class MissingEnvError extends Error {
  constructor(public readonly missing: string[]) {
    super(`Missing required environment variable(s): ${missing.join(", ")}`);
    this.name = "MissingEnvError";
  }
}

interface EnvVar {
  name: string;
  description: string;
}

interface FeatureGroup {
  /** Human-readable feature name, used in startup notes. */
  feature: string;
  vars: EnvVar[];
}

/** Secrets required for the service to run right now (Anthropic + Slack). */
const REQUIRED: EnvVar[] = [
  { name: "ANTHROPIC_API_KEY", description: "Anthropic API key for the Claude Agent SDK (model claude-opus-4-8)" },
  { name: "SLACK_BOT_TOKEN", description: "Slack bot token (xoxb-...) to read and post messages" },
  { name: "SLACK_APP_TOKEN", description: "Slack app-level token (xapp-...) for Socket Mode" },
  { name: "SLACK_SIGNING_SECRET", description: "Slack signing secret to verify requests" },
];

/** Secrets for features not yet wired up. Missing → feature unavailable, not a startup failure. */
const OPTIONAL_FEATURES: FeatureGroup[] = [
  {
    feature: "Meta Ads (Marketing API)",
    vars: [
      { name: "META_ACCESS_TOKEN", description: "Meta Marketing API long-lived access token" },
      { name: "META_APP_ID", description: "Meta App ID" },
      { name: "META_APP_SECRET", description: "Meta App secret" },
      { name: "META_AD_ACCOUNT_ID", description: "Meta ad account, e.g. act_1234567890 (INR)" },
    ],
  },
  {
    feature: "Google Sheets (shared memory)",
    vars: [
      { name: "GOOGLE_SHEETS_SPREADSHEET_ID", description: "ID of the shared Google Sheet" },
      { name: "GOOGLE_SHEETS_CLIENT_EMAIL", description: "Google service account email (share the sheet with it)" },
      { name: "GOOGLE_SHEETS_PRIVATE_KEY", description: "Google service account private key (PEM)" },
    ],
  },
  {
    feature: "Gemini (image/video generation)",
    vars: [{ name: "GEMINI_API_KEY", description: "Google Gemini API key for image/video generation" }],
  },
];

const ALL_VARS: EnvVar[] = [...REQUIRED, ...OPTIONAL_FEATURES.flatMap((g) => g.vars)];

function isSet(name: string): boolean {
  const v = process.env[name];
  return !!v && v.trim() !== "";
}

function required(name: string): string {
  if (!isSet(name)) throw new MissingEnvError([name]);
  return process.env[name]!.trim();
}

function optional(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

/**
 * Validate that every REQUIRED secret is present (Anthropic + Slack).
 * Throws MissingEnvError listing ALL missing required secrets (not just the first).
 * Optional-feature secrets are NOT checked here — call this once at startup.
 */
export function validateEnv(): void {
  const missing = REQUIRED.filter((r) => !isSet(r.name)).map((r) => r.name);
  if (missing.length > 0) throw new MissingEnvError(missing);
}

/**
 * Report which optional features are not yet configured.
 * A feature is considered "not configured" if any of its secrets is missing.
 * Returns an empty array when everything optional is set.
 */
export function optionalFeatureStatus(): { feature: string; missing: string[] }[] {
  return OPTIONAL_FEATURES.map((g) => ({
    feature: g.feature,
    missing: g.vars.filter((v) => !isSet(v.name)).map((v) => v.name),
  })).filter((g) => g.missing.length > 0);
}

/** True only when the Meta read credentials (token + ad account) are present. */
export function isMetaConfigured(): boolean {
  return ["META_ACCESS_TOKEN", "META_AD_ACCOUNT_ID"].every(isSet);
}

/** True only when all Google Sheets secrets are present (shared memory configured). */
export function isSheetsConfigured(): boolean {
  return ["GOOGLE_SHEETS_SPREADSHEET_ID", "GOOGLE_SHEETS_CLIENT_EMAIL", "GOOGLE_SHEETS_PRIVATE_KEY"].every(isSet);
}

/** Human-readable description for a secret name (for friendly error output). */
export function describeEnv(name: string): string {
  return ALL_VARS.find((r) => r.name === name)?.description ?? "(see .env.example)";
}

export const env = {
  // Anthropic / Claude Agent SDK
  anthropicApiKey: () => required("ANTHROPIC_API_KEY"),

  // Slack
  slackBotToken: () => required("SLACK_BOT_TOKEN"),
  slackAppToken: () => required("SLACK_APP_TOKEN"),
  slackSigningSecret: () => required("SLACK_SIGNING_SECRET"),
  slackChannelId: () => optional("SLACK_CHANNEL_ID", "C05AU0AJSAV"),

  // Meta Marketing API
  metaAccessToken: () => required("META_ACCESS_TOKEN"),
  metaAppId: () => required("META_APP_ID"),
  metaAppSecret: () => required("META_APP_SECRET"),
  metaAdAccountId: () => required("META_AD_ACCOUNT_ID"),

  // Google Sheets (service account)
  sheetsSpreadsheetId: () => required("GOOGLE_SHEETS_SPREADSHEET_ID"),
  sheetsClientEmail: () => required("GOOGLE_SHEETS_CLIENT_EMAIL"),
  // Private keys are stored with literal "\n" in env; convert back to real newlines.
  sheetsPrivateKey: () => required("GOOGLE_SHEETS_PRIVATE_KEY").replace(/\\n/g, "\n"),

  // Gemini (image / video generation)
  geminiApiKey: () => required("GEMINI_API_KEY"),

  /**
   * Optimizer (B3) arming flag. Default FALSE = shadow mode (detect + alert only,
   * never pauses). "true" arms autonomous auto-pause on the NZ pilot — a
   * deliberate later step, kept off for now. Any value other than "true"
   * (case-insensitive) is treated as false so shadow is the safe default.
   */
  optimizerArmed: () => optional("OPTIMIZER_ARMED", "false").toLowerCase() === "true",
} as const;

/** Currency for all monetary values in this system. */
export const CURRENCY = "INR" as const;
