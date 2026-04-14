// Weekly refresh job — re-fetch metadata for known repos, detect
// drift (README sha changes, renames, removals, license flips).
//
// Design notes:
//   - Batch pagination by composite cursor (updated_at, id) ASC.
//     The `trg_repos_updated_at` trigger bumps updated_at on every
//     UPDATE, so processed rows sort to the end of the queue
//     naturally. The id-tiebreaker prevents starvation on tied
//     timestamps (e.g. bulk-insert siblings).
//   - A per-run runtime budget (default 250s — Vercel cron max is
//     300s on Pro, 60s on Hobby) lets the job exit cleanly before
//     a platform timeout. Whatever we didn't reach this week will
//     be first in line next week.
//   - No ctx.spawn / WDK: Foundation's WDK is stub-only.
//
// SCOPE GAP (sub-project #3 or dedicated follow-up):
//   When `readme_sha` drifts we bump the counter and update the
//   stored sha, but we do NOT currently re-fetch the README body
//   and re-run media extraction. The repo_assets table therefore
//   retains stale media until the repo is re-ingested. This is an
//   intentional MVP cut — README bodies change often enough that
//   blanket re-extraction would multiply API calls; we want the
//   re-score pipeline (sub-project #3) to drive selective re-fetch.
//
// REMOVED repos: `status='removed'` preserves `repo_tags` /
// `repo_assets` rows. Marketplace queries filter on
// `status='published'` so the removed repo's tags don't leak into
// public aggregates. Retention is deliberate — it keeps review
// history linkable even after a repo is delisted.

import { githubFetch } from "@/lib/pipeline/github/client";
import { rpcAcquirePipelineLock, rpcReleasePipelineLock } from "@/lib/pipeline/github/db-rpc";
import {
  LegallyUnavailableError,
  NotFoundError,
  PermissionError,
  PoolExhaustedError,
  RateLimitError,
  RateLimitExhaustedError,
  ServerError,
  TokenRevokedError,
} from "@/lib/pipeline/github/errors";
import { isLicenseAllowed } from "@/lib/pipeline/github/license-allowlist";
import type { JobContext } from "@/lib/types/jobs";

const DEFAULT_BUDGET_MS = 250_000;
const DEFAULT_BATCH_SIZE = 50;

// Circuit breaker: guard against a catastrophic mass-removal. If a
// pipeline bug (license-allowlist regression, 404-from-GitHub-outage,
// rename-detection miscomputing full_name, etc.) would flip too many
// live repos to `status='removed'` in one run, abort BEFORE applying
// the removal that would trip the threshold.
//
// Dual gate (OR-semantic — either trips):
//   - ABSOLUTE: hard cap on total removals per run. A true catastrophe
//     (all-404 from an outage, token-scope revoked) is bounded regardless
//     of catalog size.
//   - RATIO: after a statistically-meaningful sample (MIN_PROCESSED),
//     abort if the removal fraction exceeds MAX_REMOVAL_RATIO. Catches
//     a pervasive regression even below the absolute cap.
//
// Worst-case committed removals before the breaker trips: MAX_ABSOLUTE.
// At defaults (10), re-publishing by hand is a trivial UPDATE.
//
// On trip: runJob's top-level catch writes pipeline_runs.status='failed'
// with the error message. Cache tags are NOT revalidated on the error
// path — Cache Components serves the previous list/facets for up to
// cacheLife('hours'), so the marketplace never reflects a partially-
// wiped catalog (safer than post-trip revalidation).
const MAX_ABSOLUTE_REMOVALS = 10;
const MAX_REMOVAL_RATIO = 0.1;
const MIN_PROCESSED_BEFORE_RATIO_CHECK = 20;

export class ExcessiveRemovalError extends Error {
  constructor(
    readonly removed: number,
    readonly processed: number,
    readonly reason: "absolute-cap" | "ratio-exceeded",
  ) {
    const pct = processed > 0 ? ((removed / processed) * 100).toFixed(1) : "n/a";
    super(
      `refreshJob circuit breaker (${reason}): would-be-removed=${removed}/${processed} ` +
        `(${pct}%) — aborting`,
    );
    this.name = "ExcessiveRemovalError";
  }
}

export interface RefreshInput {
  readonly maxRuntimeMs?: number;
  readonly batchSize?: number;
}

export interface RefreshOutput {
  repos_refreshed: number;
  repos_removed: number;
  readmes_changed: number;
  batches_processed: number;
  timed_out: boolean;
  lock_acquired: boolean;
  // IDs surfaced to the cron route for revalidateTag invalidation.
  // Pipeline jobs cannot import next/cache (Foundation rule 9).
  changedRepoIds: readonly string[];
  [key: string]: unknown;
}

type RefreshableStatus = "pending" | "scored" | "published" | "dormant";

const REFRESHABLE_STATUSES: RefreshableStatus[] = ["pending", "scored", "published", "dormant"];

interface RepoRow {
  id: string;
  github_id: number;
  owner: string;
  name: string;
  readme_sha: string | null;
  updated_at: string;
}

interface RawRepoResponse {
  id: number;
  full_name: string;
  name: string;
  description: string | null;
  homepage: string | null;
  license: { spdx_id: string | null } | null;
  default_branch: string;
  stargazers_count: number;
  forks_count: number;
  watchers_count: number;
  pushed_at: string;
  owner: { login: string };
}

export async function refreshJob(
  ctx: JobContext,
  input: RefreshInput = {},
): Promise<RefreshOutput> {
  const budget = input.maxRuntimeMs ?? DEFAULT_BUDGET_MS;
  const batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE;
  const startedAt = Date.now();

  const lock = await acquireLock(ctx);
  if (!lock) {
    ctx.metric("lock_skipped", 1);
    return {
      repos_refreshed: 0,
      repos_removed: 0,
      readmes_changed: 0,
      batches_processed: 0,
      timed_out: false,
      lock_acquired: false,
      changedRepoIds: [],
    };
  }

  let reposRefreshed = 0;
  let reposRemoved = 0;
  // reposProcessed is incremented for every per-row iteration, regardless
  // of outcome (refresh success, readme-change, remove-intent, OR a
  // non-fatal error that consumed the row without producing a counter
  // bump). This is the correct denominator for the circuit-breaker ratio
  // — using `reposRefreshed + reposRemoved` would undercount rows that
  // errored into the non-fatal catch, which skews the ratio upward and
  // could false-trip during a transient-error storm.
  let reposProcessed = 0;
  let readmesChanged = 0;
  let batchesProcessed = 0;
  let timedOut = false;
  const changedIds: string[] = [];
  // Composite cursor (updated_at, id) — tied updated_at values between
  // consecutive rows would otherwise strand repos at the batch boundary
  // because a pure `.gt(updated_at, ...)` would skip siblings. Advancing
  // on (updated_at, id) guarantees every row is visited exactly once.
  let cursorUpdatedAt: string | null = null;
  let cursorId: string | null = null;

  try {
    while (Date.now() - startedAt < budget) {
      const batch: RepoRow[] = await fetchRepoBatch(ctx, cursorUpdatedAt, cursorId, batchSize);
      if (batch.length === 0) break;

      // Process sequentially inside a batch to keep DB-write pressure
      // low. Concurrency is the job of the pool manager across
      // invocations, not this loop.
      for (const repo of batch) {
        if (Date.now() - startedAt >= budget) {
          timedOut = true;
          break;
        }

        // refreshOne returns the INTENT, not the applied result. The
        // circuit-breaker check runs in this loop BEFORE setRemoved is
        // called, so we never commit the removal that would trip.
        let outcome: RefreshOutcome;
        try {
          outcome = await refreshOne(ctx, repo);
        } catch (err) {
          reposProcessed += 1; // errored row still consumed the iteration
          if (isFatalPoolError(err)) throw err;
          console.warn(
            `[refreshJob] ${repo.owner}/${repo.name}: non-fatal error, skipping: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          continue;
        }
        reposProcessed += 1;

        if (outcome === "remove") {
          // Prospective-ratio circuit breaker: evaluate the ratio AFTER
          // applying this removal; if it would trip the threshold, abort
          // before setRemoved actually runs.
          const wouldBeRemoved = reposRemoved + 1;
          const exceedsAbsolute = wouldBeRemoved > MAX_ABSOLUTE_REMOVALS;
          const exceedsRatio =
            reposProcessed >= MIN_PROCESSED_BEFORE_RATIO_CHECK &&
            wouldBeRemoved / reposProcessed > MAX_REMOVAL_RATIO;
          if (exceedsAbsolute || exceedsRatio) {
            const reason = exceedsAbsolute ? "absolute-cap" : "ratio-exceeded";
            ctx.metric("removal_ratio_breaker_tripped", 1);
            ctx.metric(
              "removal_ratio_pct",
              Math.round((wouldBeRemoved / reposProcessed) * 1000) / 10,
            );
            throw new ExcessiveRemovalError(wouldBeRemoved, reposProcessed, reason);
          }
          await setRemoved(ctx, repo.id);
          reposRemoved += 1;
          changedIds.push(repo.id);
        } else if (outcome === "readme-changed") {
          readmesChanged += 1;
          reposRefreshed += 1;
          changedIds.push(repo.id);
        } else {
          reposRefreshed += 1;
          changedIds.push(repo.id);
        }
      }

      batchesProcessed += 1;
      const last = batch[batch.length - 1];
      if (last) {
        cursorUpdatedAt = last.updated_at;
        cursorId = last.id;
      }

      if (batch.length < batchSize) break;
      if (timedOut) break;
    }

    if (!timedOut && Date.now() - startedAt >= budget) timedOut = true;

    ctx.metric("repos_refreshed", reposRefreshed);
    ctx.metric("repos_removed", reposRemoved);
    ctx.metric("readmes_changed", readmesChanged);
    ctx.metric("batches_processed", batchesProcessed);
    ctx.metric("timed_out", timedOut ? 1 : 0);

    return {
      repos_refreshed: reposRefreshed,
      repos_removed: reposRemoved,
      readmes_changed: readmesChanged,
      batches_processed: batchesProcessed,
      timed_out: timedOut,
      lock_acquired: true,
      changedRepoIds: changedIds,
    };
  } finally {
    await releaseLock(ctx);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Per-repo refresh
// ──────────────────────────────────────────────────────────────────────

// "remove" is the REMOVAL INTENT — the caller runs the circuit breaker
// check before actually calling setRemoved. Using a distinct vocabulary
// from "removed" (past tense / applied) prevents future edits from
// re-introducing the inline removal that bypasses the breaker.
type RefreshOutcome = "refreshed" | "readme-changed" | "remove";

async function refreshOne(ctx: JobContext, repo: RepoRow): Promise<RefreshOutcome> {
  let rawRepo: RawRepoResponse;
  try {
    const { data } = await githubFetch(
      `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`,
      { scope: "rest" },
      ctx.db,
    );
    rawRepo = data as RawRepoResponse;
  } catch (err) {
    // Not-found / legally-unavailable → signal removal intent.
    if (err instanceof NotFoundError || err instanceof LegallyUnavailableError) {
      return "remove";
    }
    // Permission-denied usually means the repo went private. Treat as
    // a removal for marketplace purposes.
    if (err instanceof PermissionError) {
      return "remove";
    }
    throw err;
  }

  // License-flip detection.
  const licenseSpdx = rawRepo.license?.spdx_id?.toLowerCase() ?? null;
  if (!isLicenseAllowed(licenseSpdx)) {
    return "remove";
  }

  // Rename detection: if full_name differs, GitHub already redirected
  // us; update owner/name to match the new canonical path.
  const [newOwner, newName] = splitFullName(rawRepo.full_name);
  const ownerChanged = newOwner !== null && newOwner !== repo.owner;
  const nameChanged = newName !== null && newName !== repo.name;

  // README-sha drift detection.
  let newReadmeSha: string | null = repo.readme_sha;
  let readmeDrifted = false;
  try {
    newReadmeSha = await fetchReadmeSha(ctx, rawRepo.owner.login, rawRepo.name);
    readmeDrifted = newReadmeSha !== null && newReadmeSha !== repo.readme_sha;
  } catch (err) {
    if (err instanceof NotFoundError) {
      newReadmeSha = null;
    } else if (isFatalPoolError(err)) {
      throw err;
    }
    // Other errors: keep old sha, don't claim drift.
  }

  const patch: Record<string, unknown> = {
    description: rawRepo.description,
    homepage: rawRepo.homepage,
    license: licenseSpdx,
    default_branch: rawRepo.default_branch,
    stars: rawRepo.stargazers_count,
    forks: rawRepo.forks_count,
    watchers: rawRepo.watchers_count,
    last_commit_at: rawRepo.pushed_at,
    github_pushed_at: rawRepo.pushed_at,
    readme_sha: newReadmeSha,
  };
  if (ownerChanged && newOwner !== null) patch.owner = newOwner;
  if (nameChanged && newName !== null) patch.name = newName;

  const { error } = await ctx.db.from("repos").update(patch).eq("id", repo.id);
  if (error) throw new Error(`refreshJob: repos update failed: ${error.message}`);

  return readmeDrifted ? "readme-changed" : "refreshed";
}

// ──────────────────────────────────────────────────────────────────────
// DB helpers (private)
// ──────────────────────────────────────────────────────────────────────

async function fetchRepoBatch(
  ctx: JobContext,
  cursorUpdatedAt: string | null,
  cursorId: string | null,
  size: number,
): Promise<RepoRow[]> {
  let query = ctx.db
    .from("repos")
    .select("id, github_id, owner, name, readme_sha, updated_at")
    .in("status", REFRESHABLE_STATUSES)
    .order("updated_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(size);
  if (cursorUpdatedAt !== null && cursorId !== null) {
    // Composite cursor: `updated_at > cursor OR (updated_at = cursor AND id > cursorId)`
    // encoded as PostgREST OR filter. Prevents starvation of rows sharing
    // a timestamp at the batch boundary.
    query = query.or(
      `updated_at.gt.${cursorUpdatedAt},and(updated_at.eq.${cursorUpdatedAt},id.gt.${cursorId})`,
    );
  }
  const { data, error } = await query;
  if (error) throw new Error(`refreshJob: batch select failed: ${error.message}`);
  return (data ?? []) as RepoRow[];
}

async function setRemoved(ctx: JobContext, repoId: string): Promise<void> {
  const { error } = await ctx.db.from("repos").update({ status: "removed" }).eq("id", repoId);
  if (error) throw new Error(`refreshJob: setRemoved failed: ${error.message}`);
}

async function fetchReadmeSha(
  ctx: JobContext,
  owner: string,
  repo: string,
): Promise<string | null> {
  const { data } = await githubFetch(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/readme`,
    { scope: "rest" },
    ctx.db,
  );
  const payload = data as { sha?: string } | null;
  return payload?.sha ?? null;
}

async function acquireLock(ctx: JobContext): Promise<boolean> {
  const { data, error } = await rpcAcquirePipelineLock(ctx.db, "refresh");
  if (error) throw new Error(`refreshJob: acquire_pipeline_lock failed: ${error.message}`);
  return data === true;
}

async function releaseLock(ctx: JobContext): Promise<void> {
  const { error } = await rpcReleasePipelineLock(ctx.db, "refresh");
  if (error) {
    console.warn(`[refreshJob] release_pipeline_lock failed: ${error.message}`);
  }
}

function splitFullName(fullName: string): [string | null, string | null] {
  const idx = fullName.indexOf("/");
  if (idx <= 0 || idx === fullName.length - 1) return [null, null];
  return [fullName.slice(0, idx), fullName.slice(idx + 1)];
}

function isFatalPoolError(err: unknown): boolean {
  return (
    err instanceof RateLimitError ||
    err instanceof RateLimitExhaustedError ||
    err instanceof PoolExhaustedError ||
    err instanceof TokenRevokedError ||
    err instanceof ServerError
  );
}
