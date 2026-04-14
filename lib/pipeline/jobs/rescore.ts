// Monthly rescore job. Selects candidates by prompt-version mismatch
// (priority) or staleness (> 30 days). Delegates to scoreJob with
// explicit repoIds so they route through claim_repos_by_id RPC.
//
// RESCORE_DRAIN_MODE=true switches to larger batch (500) so a major
// prompt-version migration drains in days rather than months.

import { env } from "@/lib/env";
import { SCORING_PROMPT_VERSION } from "@/lib/pipeline/gemini/scoring-prompt";
import type { JobContext, JobOutput } from "@/lib/types/jobs";
import { scoreJob } from "./score";

export interface RescoreJobInput {
  readonly batchSize?: number;
}

export interface RescoreJobOutput extends JobOutput {
  candidates_found: number;
  repos_scored: number;
  drain_mode: boolean;
}

export async function rescoreJob(
  ctx: JobContext,
  input: RescoreJobInput = {},
): Promise<RescoreJobOutput> {
  const drainMode = env.RESCORE_DRAIN_MODE === "true";
  const batchSize = input.batchSize ?? (drainMode ? 500 : 200);

  // 1. Find candidates.
  const { data: candidates, error } = await ctx.db
    .from("repo_scores")
    .select("repo_id, scoring_prompt_version, scored_at")
    .eq("is_latest", true);
  if (error) throw new Error(`rescore candidate query failed: ${error.message}`);

  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
  // Version mismatches first, then stale.
  const versionMismatches: string[] = [];
  const stales: string[] = [];
  for (const row of candidates ?? []) {
    if (row.scoring_prompt_version !== SCORING_PROMPT_VERSION) {
      versionMismatches.push(row.repo_id);
    } else if (row.scored_at && Date.parse(row.scored_at) < thirtyDaysAgo) {
      stales.push(row.repo_id);
    }
  }
  const targetIds = [...versionMismatches, ...stales].slice(0, batchSize);

  if (targetIds.length === 0) {
    return { candidates_found: 0, repos_scored: 0, drain_mode: drainMode };
  }

  // 2. Delegate to scoreJob — it routes through claim_repos_by_id for
  //    atomic status transition.
  const result = await scoreJob(ctx, { mode: "rescore", repoIds: targetIds });

  return {
    candidates_found: targetIds.length,
    repos_scored: result.repos_scored,
    drain_mode: drainMode,
  };
}
