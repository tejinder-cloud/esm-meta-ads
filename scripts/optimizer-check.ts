import { isMetaConfigured, env } from "../shared/env.js";
import { assess, formatCheck } from "../agents/optimizer/index.js";

/**
 * Manual hook for the Optimizer (`npm run optimizer:check`). Runs ONE assessment
 * pass NOW on the NZ pilot and prints today's spend/leads/CPL, the trailing-30d
 * CPQL, and exactly which breakers would trip.
 *
 * Strictly read-only: it performs NO pause and NO writes, regardless of
 * OPTIMIZER_ARMED — it only reads Meta and prints its judgement.
 */

if (!isMetaConfigured()) {
  console.error("❌ Meta is not configured — set META_ACCESS_TOKEN and META_AD_ACCOUNT_ID in .env.");
  process.exit(1);
}

const a = await assess();

console.log("\n=== Optimizer check — one pass (read-only; no pause regardless of ARMED) ===\n");
console.log(formatCheck(a));

const armed = env.optimizerArmed();
console.log(
  `\nMode: OPTIMIZER_ARMED=${armed} → ${armed ? "ARMED (would pause on a tripped breaker)" : "SHADOW (detect + alert only)"}.`,
);
console.log("This check performs no pause and no writes.\n");
