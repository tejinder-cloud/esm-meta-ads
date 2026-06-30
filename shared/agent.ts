import { query } from "@anthropic-ai/claude-agent-sdk";
import { CURRENCY } from "./env.js";

/**
 * Thin wrapper around the Claude Agent SDK — the "brain" every agent runs on.
 *
 * All agents use model claude-opus-4-8. Each agent supplies its own system
 * prompt (its role and instructions); this wrapper runs the Agent SDK and
 * returns the final text result.
 *
 * Note: the exact shape of the SDK's streamed messages can vary by version.
 * Pin @anthropic-ai/claude-agent-sdk and verify against the installed version
 * before extending message handling here.
 */

export const MODEL = "claude-opus-4-8" as const;

/** Shared context prepended to every agent's system prompt. */
export const TEAM_CONTEXT = `You are part of the ESM Overseas Meta Ads automation team.
Client: ESM Overseas. Target market: India. All monetary values are in ${CURRENCY} (Indian Rupees) unless stated otherwise.
Respect the operator approval gates: image approval, budget decisions, and briefs are human-approved — never act past a gate on your own.`;

export interface RunAgentOptions {
  /** The agent's role/instructions. Combined with TEAM_CONTEXT. */
  systemPrompt: string;
  /** The task/prompt for this run. */
  prompt: string;
}

/**
 * User-facing fallback returned when the Agent SDK errors out. It is a plain
 * text reply: callers treat it like any normal model answer (the Media Planner's
 * JSON parse falls through to posting it; the approval classifier reads it as
 * "ambiguous" and asks again). It never leaks a stack trace to Slack.
 */
export const AGENT_ERROR_REPLY =
  "I couldn't complete that request just now — please try again, and if it keeps happening, rephrase with a bit less detail.";

/**
 * Run a single agent turn and return its final text output.
 *
 * Never throws: if the Agent SDK errors (e.g. it hit the max-turns cap, or any
 * transport/API failure), we log the error and return a graceful, user-facing
 * string instead of crashing the caller. The planning path stays alive and the
 * operator gets a polite retry message rather than a dropped request.
 */
export async function runAgent({
  systemPrompt,
  prompt,
}: RunAgentOptions): Promise<string> {
  let finalText = "";

  try {
    const response = query({
      prompt,
      options: {
        model: MODEL,
        systemPrompt: `${TEAM_CONTEXT}\n\n${systemPrompt}`,
        // Keep replies pure text: no tools and don't load any local
        // settings/CLAUDE.md from disk. This is a server, not a coding agent.
        // allowedTools stays [] so the agent can reason but never act (no Meta
        // writes, no spend). maxTurns only bounds internal reasoning turns: the
        // model occasionally needs a second turn to finish, and maxTurns: 1 made
        // the SDK throw "Reached maximum number of turns (1)" on those runs.
        allowedTools: [],
        maxTurns: 12,
        settingSources: [],
      },
    });

    for await (const message of response) {
      // The "result" message carries the final answer for the run.
      if (message.type === "result" && "result" in message) {
        finalText = String((message as { result: unknown }).result ?? "");
      }
    }

    return finalText;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Max-turns is the most likely recurrence, so flag it distinctly in logs.
    if (/maximum number of turns/i.test(detail)) {
      console.error(
        `⚠️ Agent hit max turns — consider raising maxTurns or simplifying the request. (${detail})`,
      );
    } else {
      console.error(`runAgent: Agent SDK error — ${detail}`);
    }
    // Graceful, stack-trace-free reply so the planning path never crashes.
    return AGENT_ERROR_REPLY;
  }
}
