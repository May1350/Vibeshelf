import type { SupabaseClient } from "@/lib/db";

export type JobInput = Record<string, unknown>;

/**
 * Job output. Optional `changedRepoIds` lets cron route handlers
 * invalidate Next.js cache tags per affected repo. Pipeline jobs
 * cannot import next/cache (Foundation rule 9), so they surface
 * IDs and the route handles invalidation.
 */
export type JobOutput = Record<string, unknown> & {
  readonly changedRepoIds?: readonly string[];
};

export interface JobContext {
  readonly runId: string;
  readonly parentRunId: string | null;
  readonly db: SupabaseClient;
  metric(name: string, value: number | string): void;
  spawn<I extends JobInput, O extends JobOutput>(
    childJobName: string,
    childInput: I,
    childFn: (childCtx: JobContext) => Promise<O>,
  ): Promise<O>;
}
