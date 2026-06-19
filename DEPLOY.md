# Deploying ESM Meta Ads on Railway

This guide walks you through running the ESM Overseas Meta Ads service on
[Railway](https://railway.com) so it stays online 24/7. No coding required — just
follow the steps in order.

The service talks to Slack over **Socket Mode** (an outbound connection), so it
does **not** need a public website. It also runs a tiny health endpoint so
Railway can confirm it's alive.

---

## What you need before starting

- A **Railway account** (sign up at https://railway.com — you can log in with GitHub).
- Access to the **GitHub repo** `tejinder-cloud/esm-meta-ads`.
- Your secret values ready to paste (the same ones from your local `.env`):
  Anthropic and Slack are required; Meta, Google Sheets, and Gemini are optional
  for now.

---

## Step 1 — Create the project from GitHub

1. Go to https://railway.com and click **New Project**.
2. Choose **Deploy from GitHub repo**.
3. If prompted, authorize Railway to access your GitHub account.
4. Select the **`tejinder-cloud/esm-meta-ads`** repository.
5. Railway creates a service and starts the first build. It will **fail or stay
   "crashed" until you add the environment variables** in Step 2 — that's
   expected. (It can't start without the Anthropic and Slack secrets.)

Railway automatically:
- Builds the production code with `npm run build`.
- Starts it with `npm start`.
- Provides a `PORT` value, which the health endpoint uses.

(These are pinned in `railway.json` in the repo, so you don't configure them by hand.)

---

## Step 2 — Set the environment variables

1. Open your service in Railway → the **Variables** tab.
2. Add each variable below as a **name → value** pair. Use **Raw Editor** if you
   want to paste several at once.

### Required (the service will not start without all of these)

| Variable | What it is |
|----------|------------|
| `ANTHROPIC_API_KEY` | Anthropic API key the agents run on (model claude-opus-4-8) |
| `SLACK_BOT_TOKEN` | Slack bot token, starts with `xoxb-` |
| `SLACK_APP_TOKEN` | Slack app-level token, starts with `xapp-` (powers Socket Mode) |
| `SLACK_SIGNING_SECRET` | Slack signing secret |

### Recommended

| Variable | What it is |
|----------|------------|
| `SLACK_CHANNEL_ID` | The channel to operate in. Defaults to `C05AU0AJSAV` (#esm-meta-ads) if you leave it out. |

### Optional (features not wired up yet — safe to skip for now)

Leave these unset for now. The service starts fine without them and simply logs
that the feature is "not yet configured." Add them later when those features go live.

| Variable | Feature |
|----------|---------|
| `META_ACCESS_TOKEN` | Meta Ads (Marketing API) |
| `META_APP_ID` | Meta Ads (Marketing API) |
| `META_APP_SECRET` | Meta Ads (Marketing API) |
| `META_AD_ACCOUNT_ID` | Meta Ads (Marketing API), e.g. `act_1234567890` |
| `GOOGLE_SHEETS_SPREADSHEET_ID` | Google Sheets (shared memory) |
| `GOOGLE_SHEETS_CLIENT_EMAIL` | Google Sheets (shared memory) |
| `GOOGLE_SHEETS_PRIVATE_KEY` | Google Sheets (shared memory) |
| `GEMINI_API_KEY` | Gemini (image/video generation) |

> **Do not set `PORT`** — Railway provides it automatically.

3. After saving variables, Railway redeploys automatically. If it doesn't, click
   **Deploy** (or the **⋮ → Redeploy** menu) on the latest deployment.

---

## Step 3 — Read the logs to confirm it started

1. In your service, open the **Deployments** tab and click the latest deployment.
2. Open the **Deploy Logs** (or **Logs**) view.
3. You're looking for these lines, in order:

   ```
   🩺 Health endpoint listening on :<port> (returns 200 OK).
   ✅ ESM Meta Ads runtime started. Listening on #esm-meta-ads (C05AU0AJSAV) as U0........
   ```

   - The 🩺 line means Railway's health check will pass.
   - The ✅ line means it connected to Slack and is ready.
   - You may also see `ℹ️ ... is not yet configured` notes for Meta, Google
     Sheets, and Gemini — that's normal and harmless until those are set up.

4. Railway should show the service as **Active / healthy**.

### If something looks wrong

- **`❌ Cannot start ... required secret(s) are not set`** — a required variable
  in Step 2 is missing or empty. The log lists exactly which one. Add it and redeploy.
- **`invalid_auth`** — a Slack token is wrong. Re-copy `SLACK_BOT_TOKEN` and
  `SLACK_APP_TOKEN` from your Slack app settings.
- **Service keeps restarting** — open the logs; the last lines say why. Railway
  retries automatically on failure.

---

## Step 4 — Test it

In the **#esm-meta-ads** Slack channel, @mention the bot (e.g.
`@ESM Meta Ads hello`). It should reply in a thread within a few seconds.

That's it — the service now stays online and reconnects on its own if it restarts.
