import "dotenv/config";

/**
 * Typed, centralized access to environment variables.
 * See .env.example for the full list and descriptions.
 *
 * Every secret is read here so the rest of the codebase never touches
 * process.env directly. Call validateEnv() once at startup to fail fast with a
 * friendly, complete list of anything missing — rather than a cryptic crash.
 */

/** Thrown when one or more required environment variables are missing. */
export class MissingEnvError extends Error {
  constructor(public readonly missing: string[]) {
    super(`Missing required environment variable(s): ${missing.join(", ")}`);
    this.name = "MissingEnvError";
  }
}

/** The required secrets, with a short description used in error messages. */
const REQUIRED: { name: string; description: string }[] = [
  { name: "ANTHROPIC_API_KEY", description: "Anthropic API key for the Claude Agent SDK (model claude-opus-4-8)" },
  { name: "SLACK_BOT_TOKEN", description: "Slack bot token (xoxb-...) to read and post messages" },
  { name: "SLACK_APP_TOKEN", description: "Slack app-level token (xapp-...) for Socket Mode" },
  { name: "SLACK_SIGNING_SECRET", description: "Slack signing secret to verify requests" },
  { name: "META_ACCESS_TOKEN", description: "Meta Marketing API long-lived access token" },
  { name: "META_APP_ID", description: "Meta App ID" },
  { name: "META_APP_SECRET", description: "Meta App secret" },
  { name: "META_AD_ACCOUNT_ID", description: "Meta ad account, e.g. act_1234567890 (INR)" },
  { name: "GOOGLE_SHEETS_SPREADSHEET_ID", description: "ID of the shared Google Sheet" },
  { name: "GOOGLE_SHEETS_CLIENT_EMAIL", description: "Google service account email (share the sheet with it)" },
  { name: "GOOGLE_SHEETS_PRIVATE_KEY", description: "Google service account private key (PEM)" },
  { name: "GEMINI_API_KEY", description: "Google Gemini API key for image/video generation" },
];

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
 * Validate that every required secret is present.
 * Throws MissingEnvError listing ALL missing secrets (not just the first).
 * Call this once at startup before constructing any clients.
 */
export function validateEnv(): void {
  const missing = REQUIRED.filter((r) => !isSet(r.name)).map((r) => r.name);
  if (missing.length > 0) throw new MissingEnvError(missing);
}

/** Human-readable description for a secret name (for friendly error output). */
export function describeEnv(name: string): string {
  return REQUIRED.find((r) => r.name === name)?.description ?? "(see .env.example)";
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
} as const;

/** Currency for all monetary values in this system. */
export const CURRENCY = "INR" as const;
