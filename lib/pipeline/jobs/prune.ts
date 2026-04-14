// Weekly retention cron: delete successful pipeline_runs older than 90
// days. Failed runs retained indefinitely for postmortem.

import type { JobContext, JobOutput } from "@/lib/types/jobs";

export interface PruneJobOutput extends JobOutput {
  rows_deleted: number;
}

export async function pruneJob(ctx: JobContext): Promise<PruneJobOutput> {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await ctx.db
    .from("pipeline_runs")
    .delete()
    .lt("started_at", cutoff)
    .eq("status", "success")
    .select("id");

  if (error) throw new Error(`prune delete failed: ${error.message}`);

  const deleted = (data ?? []).length;
  ctx.metric("rows_deleted", deleted);
  return { rows_deleted: deleted };
}
