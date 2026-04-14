// Daily scoring job. Resets stuck rows, claims pending (or explicit IDs
// for rescore), and orchestrates per-repo scoring via ctx.spawn for
// observability. Budget exhaustion bulk-reverts remaining repos.

import { GeminiClient } from "@/lib/pipeline/gemini/client";
import { GeminiRateLimitError, GeminiServerError } from "@/lib/pipeline/gemini/errors";
import { recordScoreMetrics, type ScoreJobMetrics } from "@/lib/pipeline/metrics/scoring-metrics";
import { RequestBudget } from "@/lib/pipeline/scoring/request-budget";
import { type ClaimedRepo, scoreRepo } from "@/lib/pipeline/scoring/score-repo";
import type { JobContext, JobOutput } from "@/lib/types/jobs";

export interface ScoreJobInput {
  readonly batchSize?: number;
  readonly mode?: "score" | "rescore";
  /**
   * When set, scoreJob operates on these specific repo IDs via
   * claim_repos_by_id instead of claim_pending_repos (which only picks
   * status='pending' rows). Used by rescoreJob.
   */
  readonly repoIds?: readonly string[];
}

export interface ScoreJobOutput extends JobOutput {
  repos_scored: number;
  repos_stuck_reset: number;
  budget_exhausted: boolean;
  // IDs surfaced to the cron route for revalidateTag invalidation.
  // Pipeline jobs cannot import next/cache (Foundation rule 9).
  changedRepoIds: readonly string[];
}

export async function scoreJob(
  ctx: JobContext,
  input: ScoreJobInput = {},
): Promise<ScoreJobOutput> {
  const batchSize = input.batchSize ?? 50;
  const isRescore = input.mode === "rescore";

  // 1. Reaper — reset rows stuck in 'scoring' >15 min.
  const { data: stuckCount } = await ctx.db.rpc("reset_stuck_scoring_repos");
  const stuckReset = typeof stuckCount === "number" ? stuckCount : 0;

  // 2. Budget (context-aware for rescore backfill drain).
  const budget = new RequestBudget({
    maxCalls: isRescore ? 2000 : 500,
    maxCostUsd: 5.0,
  });

  // 3. Claim — branch on rescore (explicit IDs) vs score (pending).
  let claimed: ClaimedRepo[];
  if (input.repoIds && input.repoIds.length > 0) {
    const { data, error } = await ctx.db.rpc("claim_repos_by_id", {
      p_ids: input.repoIds,
    });
    if (error) throw new Error(`claim_repos_by_id failed: ${error.message}`);
    claimed = (data ?? []) as ClaimedRepo[];
  } else {
    const { data, error } = await ctx.db.rpc("claim_pending_repos", {
      p_limit: batchSize,
    });
    if (error) throw new Error(`claim_pending_repos failed: ${error.message}`);
    claimed = (data ?? []) as ClaimedRepo[];
  }

  const metrics: ScoreJobMetrics = {
    repos_claimed: claimed.length,
    repos_scored: 0,
    repos_published: 0,
    repos_gated: 0,
    repos_needs_review: 0,
    repos_skipped_schema: 0,
    repos_skipped_server_error: 0,
    repos_skipped_readme_fetch: 0,
    repos_stuck_reset: stuckReset,
    gemini_calls: 0,
    gemini_input_tokens: 0,
    gemini_output_tokens: 0,
    gemini_429_count: 0,
    cost_usd: 0,
    budget_exhausted: false,
    avg_latency_ms: 0,
  };

  if (claimed.length === 0) {
    recordScoreMetrics(ctx, metrics);
    return {
      repos_scored: 0,
      repos_stuck_reset: stuckReset,
      budget_exhausted: false,
      changedRepoIds: [],
    };
  }

  const gemini = new GeminiClient();
  const latencies: number[] = [];
  const changedIds: string[] = [];

  // 4. Per-repo via ctx.spawn (child runs for observability).
  for (let i = 0; i < claimed.length; i++) {
    const repo = claimed[i];
    if (!repo) continue; // noUncheckedIndexedAccess narrows claimed[i] to T | undefined
    if (!budget.canProceed()) {
      metrics.budget_exhausted = true;
      // Bulk-revert all remaining (including current) to 'pending'.
      const remainingIds = claimed.slice(i).map((r) => r.id);
      await ctx.db.from("repos").update({ status: "pending" }).in("id", remainingIds);
      break;
    }

    const t0 = Date.now();
    try {
      const outcome = await ctx.spawn(
        "score-repo",
        { repo_id: repo.id, owner: repo.owner, name: repo.name },
        async (childCtx) => {
          return await scoreRepo(childCtx, repo, { gemini, budget, isRescore });
        },
      );

      metrics.repos_scored += 1;
      if (outcome.status === "published") {
        metrics.repos_published += 1;
        changedIds.push(repo.id);
      } else if (outcome.status === "scored") {
        metrics.repos_gated += 1;
        changedIds.push(repo.id);
      } else if (outcome.status === "needs_review") {
        metrics.repos_needs_review += 1;
        changedIds.push(repo.id);
      } else if (outcome.status === "skipped" && outcome.reason === "schema_error") {
        metrics.repos_skipped_schema += 1;
        await ctx.db.from("repos").update({ status: "pending" }).eq("id", repo.id);
      } else if (outcome.status === "skipped" && outcome.reason === "server_error") {
        metrics.repos_skipped_server_error += 1;
        await ctx.db.from("repos").update({ status: "pending" }).eq("id", repo.id);
      } else if (outcome.status === "skipped" && outcome.reason === "readme_fetch") {
        metrics.repos_skipped_readme_fetch += 1;
        await ctx.db.from("repos").update({ status: "pending" }).eq("id", repo.id);
      }
    } catch (err) {
      if (err instanceof GeminiRateLimitError) {
        metrics.gemini_429_count += 1;
        // Revert current + bulk-revert remaining, then halt.
        const remainingIds = claimed.slice(i).map((r) => r.id);
        await ctx.db.from("repos").update({ status: "pending" }).in("id", remainingIds);
        throw err;
      }
      if (err instanceof GeminiServerError) {
        metrics.repos_skipped_server_error += 1;
        await ctx.db.from("repos").update({ status: "pending" }).eq("id", repo.id);
        // Continue to next repo.
      } else {
        // Unknown error — revert this repo, continue batch.
        await ctx.db.from("repos").update({ status: "pending" }).eq("id", repo.id);
      }
    } finally {
      latencies.push(Date.now() - t0);
    }
  }

  const state = budget.state();
  metrics.gemini_calls = state.calls;
  metrics.cost_usd = state.costUsd;
  metrics.budget_exhausted = state.exhausted;
  metrics.avg_latency_ms =
    latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;

  recordScoreMetrics(ctx, metrics);

  return {
    repos_scored: metrics.repos_scored,
    repos_stuck_reset: stuckReset,
    budget_exhausted: metrics.budget_exhausted,
    changedRepoIds: changedIds,
  };
}
