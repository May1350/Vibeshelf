// Structured shape for scoring-job metrics. Using an interface with
// recordScoreMetrics forces typo-safety: ctx.metric('repos_socred', n)
// is impossible when callers must go through this helper.

import type { JobContext } from "@/lib/types/jobs";

export interface ScoreJobMetrics {
  repos_claimed: number;
  repos_scored: number;
  repos_published: number;
  repos_gated: number;
  repos_needs_review: number;
  repos_skipped_schema: number;
  repos_skipped_server_error: number;
  repos_skipped_readme_fetch: number;
  repos_stuck_reset: number;
  gemini_calls: number;
  gemini_input_tokens: number;
  gemini_output_tokens: number;
  gemini_429_count: number;
  cost_usd: number;
  budget_exhausted: boolean;
  avg_latency_ms: number;
}

export function recordScoreMetrics(ctx: JobContext, metrics: ScoreJobMetrics): void {
  for (const [key, value] of Object.entries(metrics)) {
    if (typeof value === "number" || typeof value === "boolean") {
      ctx.metric(key, typeof value === "boolean" ? (value ? 1 : 0) : value);
    }
  }
}
