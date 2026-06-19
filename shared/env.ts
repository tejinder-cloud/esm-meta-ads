import "dotenv/config";

/**
 * Typed, centralized access to environment variables.
 * See .env.example for the full list and descriptions.
 *
 * Every secret is read here so the rest of the codebase never touches
 * process.env directly. Missing required values fail loudly at startup.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `Set it in .env (local) or Railway env vars (production). See .env.example.`,
    );
  }
  return value;
}

function optional(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
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
