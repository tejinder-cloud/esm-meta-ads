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
 * Run a single agent turn and return its final text output.
 */
export async function runAgent({
  systemPrompt,
  prompt,
}: RunAgentOptions): Promise<string> {
  let finalText = "";

  const response = query({
    prompt,
    options: {
      model: MODEL,
      systemPrompt: `${TEAM_CONTEXT}\n\n${systemPrompt}`,
    },
  });

  for await (const message of response) {
    // The "result" message carries the final answer for the run.
    if (message.type === "result" && "result" in message) {
      finalText = String((message as { result: unknown }).result ?? "");
    }
  }

  return finalText;
}
