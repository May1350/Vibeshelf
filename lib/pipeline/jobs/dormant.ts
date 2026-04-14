// Monthly dormant job — flag repos with no push activity in >12 months.
//
// Simple SELECT-to-UPDATE in a single statement. No GitHub API calls,
// no extractors, no fan-out. Runs as a single pipeline_run with an
// advisory lock to prevent overlap with manual retriggers.

import { rpcAcquirePipelineLock, rpcReleasePipelineLock } from "@/lib/pipeline/github/db-rpc";
import type { JobContext } from "@/lib/types/jobs";

const DORMANT_THRESHOLD_MS = 365 * 24 * 60 * 60 * 1000;

export interface DormantInput {
  /** Test-only override for the cutoff timestamp. */
  readonly cutoffIso?: string;
}

export interface DormantOutput {
  /** Number of repos flipped to status='dormant' this run. */
  repos_marked_dormant: number;
  /** False when another run already holds the advisory lock. */
  lock_acquired: boolean;
  [key: string]: unknown;
}

export async function dormantJob(
  ctx: JobContext,
  input: DormantInput = {},
): Promise<DormantOutput> {
  const lock = await acquireLock(ctx);
  if (!lock) {
    ctx.metric("lock_skipped", 1);
    return { repos_marked_dormant: 0, lock_acquired: false };
  }

  try {
    const cutoffIso = input.cutoffIso ?? new Date(Date.now() - DORMANT_THRESHOLD_MS).toISOString();

    const { data, error } = await ctx.db
      .from("repos")
      .update({ status: "dormant" })
      .lt("last_commit_at", cutoffIso)
      .not("status", "in", "(dormant,removed)")
      .select("id");

    if (error) throw new Error(`dormantJob: update failed: ${error.message}`);

    const count = data?.length ?? 0;
    ctx.metric("repos_marked_dormant", count);
    return { repos_marked_dormant: count, lock_acquired: true };
  } finally {
    await releaseLock(ctx);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Advisory lock helpers (private)
// ──────────────────────────────────────────────────────────────────────

async function acquireLock(ctx: JobContext): Promise<boolean> {
  const { data, error } = await rpcAcquirePipelineLock(ctx.db, "dormant");
  if (error) throw new Error(`dormantJob: acquire_pipeline_lock failed: ${error.message}`);
  return data === true;
}

async function releaseLock(ctx: JobContext): Promise<void> {
  const { error } = await rpcReleasePipelineLock(ctx.db, "dormant");
  if (error) {
    // Never throw from a finally that's cleaning up — just log. The
    // advisory lock will be released automatically at session end.
    console.warn(`[dormantJob] release_pipeline_lock failed: ${error.message}`);
  }
}
