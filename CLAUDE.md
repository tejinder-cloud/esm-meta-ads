# ESM Overseas — Meta Ads Automation

This repository (`esm-meta-ads`) is a **10-agent Meta Ads automation system** built for the
client **ESM Overseas**. The agents plan, build, run, and optimize Meta (Facebook/Instagram)
advertising campaigns, with a human operator approving key decisions along the way.

This file is the single source of truth for any future session. Read it first.

---

## What this system is

A team of ten specialized AI agents, each owning one part of the Meta Ads workflow. A human
operator talks to the team in Slack; the agents do the work, write everything they produce to a
shared Google Sheet (so the operator can read all plans, data, and reports directly), and pause
for the operator at defined approval gates.

- **Client:** ESM Overseas
- **Target market:** India. **All money is in INR (₹).** Budgets, bids, CPMs, CPAs, ROAS targets,
  and every reported figure are denominated in Indian Rupees unless explicitly stated otherwise.
- **Operator interface:** Slack — channel **#esm-meta-ads** (channel ID **C05AU0AJSAV**).

---

## Architecture

| Layer | Choice | Role |
|-------|--------|------|
| **Agent brain** | **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`), model **`claude-opus-4-8`** | Each agent is a Claude Agent SDK run with its own system prompt and tools. |
| **Runtime** | **GitHub + Railway** | Code lives in GitHub (`esm-meta-ads`); Railway builds from the repo and runs the long-lived service. |
| **Interface** | **Slack** (`@slack/bolt`, Socket Mode) | The operator and the agents communicate in **#esm-meta-ads** (`C05AU0AJSAV`). |
| **Shared memory** | **Google Sheet** (service account via `googleapis`) | All plans, data, and reports are read from / written to one spreadsheet so the operator can read everything directly. |
| **Repo** | `esm-meta-ads` | This repository. |

### Why TypeScript / Node.js (recorded tooling decision)

The three pillars of this system all have first-class TypeScript support, so a single language
covers the whole stack:

- **Claude Agent SDK** ships an official TypeScript package (`@anthropic-ai/claude-agent-sdk`).
- **Slack** has `@slack/bolt`, the most mature Slack framework, with **Socket Mode** — no public
  URL or inbound webhook is required, which keeps Railway deployment simple.
- **Railway** deploys Node.js with zero config (detects `package.json`, runs `build` then `start`).
- **Google Sheets** is covered by the official `googleapis` SDK.

Node.js 20+, ES modules, compiled with `tsc` to `dist/` and started with `node dist/runtime/index.js`.

---

## The 10 agents

Each lives under `/agents/<name>/` (folders are currently empty scaffolding). The **manager** is the
entry point: it receives operator messages from Slack and delegates to the others.

| # | Agent | Folder | Responsibility |
|---|-------|--------|----------------|
| 1 | **Media Planner** | `agents/media-planner` | Channel mix, budget allocation, flighting, and the overall media plan (INR). |
| 2 | **Competitive Intel** | `agents/competitive-intel` | Competitor ad research, Meta Ad Library scans, positioning gaps. |
| 3 | **Creative Strategist** | `agents/creative-strategist` | Campaign concepts, messaging pillars, creative direction. |
| 4 | **Image Production** | `agents/image-production` | Generates ad images (Gemini). **Gated:** images need operator approval. |
| 5 | **Campaign Builder** | `agents/campaign-builder` | Builds campaigns, ad sets, and ads in Meta Ads Manager. |
| 6 | **Video Production** | `agents/video-production` | Produces/edits video creative for Meta placements. |
| 7 | **Tracking & Data** | `agents/tracking-data` | Pixel/CAPI health, event setup, conversion data integrity. |
| 8 | **Analyst** | `agents/analyst` | Performance analysis and reporting against INR targets. |
| 9 | **Optimizer** | `agents/optimizer` | Bid/budget tuning, scaling, kill decisions. **Gated:** budget changes need approval. |
| 10 | **Manager** | `agents/manager` | Orchestrates the team, talks to the operator in Slack, enforces approval gates. |

---

## Operator approval gates (manual, required)

The agents must **stop and wait for the operator** at these points. They never proceed past a gate
on their own:

1. **Image approval** — generated ad images must be approved before they are used in any ad.
2. **Budget decisions** — any spend, budget change, scaling, or kill decision must be approved.
3. **Briefs** — the operator provides the brief; agents do not invent scope or launch work without one.

All approvals happen in **#esm-meta-ads** (`C05AU0AJSAV`).

---

## Project structure

```
esm-meta-ads/
├── CLAUDE.md            ← this file
├── README.md
├── .env.example         ← every secret the system needs (no real values)
├── .gitignore           ← keeps .env and build output out of git
├── package.json
├── tsconfig.json
├── Procfile             ← Railway/Procfile start command
├── agents/              ← one empty subfolder per agent (10)
│   ├── media-planner/   ├── competitive-intel/ ├── creative-strategist/
│   ├── image-production/├── campaign-builder/   ├── video-production/
│   ├── tracking-data/   ├── analyst/            ├── optimizer/  └── manager/
├── shared/              ← reusable code shared across agents and runtime
│   ├── env.ts           ← typed environment-variable access
│   ├── agent.ts         ← Claude Agent SDK wrapper (model claude-opus-4-8)
│   └── google-sheets.ts ← shared "memory": read/write the Google Sheet
└── runtime/             ← the deployable service
    └── index.ts         ← Slack listener (Socket Mode) → manager agent
```

- **`/agents`** — one folder per agent. Empty for now; each will hold that agent's prompt,
  tools, and logic.
- **`/shared`** — reusable building blocks every agent and the runtime depend on (env config,
  Agent SDK wrapper, Google Sheets memory).
- **`/runtime`** — the single long-running service Railway deploys: it listens to Slack and runs
  the agents.

---

## Secrets & configuration

All secrets are defined in **`.env.example`** with a one-line description each. Real values go in a
local `.env` (gitignored, never committed) or in **Railway's environment variables** for production.

Categories: **Anthropic** (Agent SDK), **Slack**, **Meta** (Marketing API), **Google Sheets**
(service account), **Gemini** (image/video generation).

The Google Sheet is accessed with a **service account** — share the target spreadsheet with the
service account's email, then set `GOOGLE_SHEETS_*` in the environment.

---

## Local development

```bash
npm install
cp .env.example .env   # fill in real values locally
npm run dev            # run the runtime service with tsx (hot reload)
```

## Deploy (Railway)

Railway builds from GitHub: it runs `npm run build` (`tsc` → `dist/`) then `npm start`
(`node dist/runtime/index.js`). Set all `.env.example` keys as Railway environment variables.

---

## Conventions

- **Money is INR (₹).** Every figure produced or reported is in Indian Rupees unless stated otherwise.
- **Model is `claude-opus-4-8`** for all agents (see `shared/agent.ts`).
- **Never bypass an approval gate.** Image, budget, and brief gates are hard stops for the operator.
- **The Google Sheet is the shared memory** — agents write plans/data/reports there so the operator
  can read everything directly.

## Implementation status

- **Manager** — implemented (hello-world acknowledgement + routing). Routes media-plan / budget /
  forecast requests (or messages starting with `/plan`) to the Media Planner; everything else gets a
  brief acknowledgement.
- **Agent 1 — Media Planner** — implemented in `agents/media-planner/`. Gathers required inputs
  (product, objective, budget, target CPR/ROAS, timeframe, landing page; India/INR), asking only for
  what's missing; proposes a plan (test + scale phases with daily ₹ amounts) and a low–mid–high
  forecast; then waits for the operator to reply **approve** or **change: …**. On approve it saves to
  the Google Sheet (tab `media-plans`) if Sheets is configured, otherwise posts a self-contained
  final plan plus a `✅ Media plan approved` record. It only proposes — never creates, spends, or
  launches.
- **Conversation state** — in-memory, keyed by Slack thread root (`runtime/index.ts`). A request
  starts a thread; replies in that thread continue the same agent. (Not persisted across restarts.)
- Agents 2–10 are still empty scaffolding.

> Pin and verify the installed `@anthropic-ai/claude-agent-sdk` version before relying on its message
> shapes. The Agent SDK is constrained to pure text replies (no tools, single turn) in `shared/agent.ts`.
