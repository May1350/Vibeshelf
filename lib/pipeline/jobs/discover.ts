// Daily discover job — GitHub Search API → filter → fetch details →
// extract tags/media → upsert to repos/repo_tags/repo_assets.
//
// Flow (Plan §5a):
//   1. Advisory lock 'discover' (fail-fast on overlap).
//   2. dryRunSearch to validate token pool + query syntax.
//   3. Build daily search batch (keyword × license). Slice by
//      input.maxQueries (default 20).
//   4. Paginate each query, dedupe by github_id, filter out repos
//      we already know about.
//   5. Fetch per-repo details with bounded worker pool.
//   6. Extract tech stack / vibecoding tools / README media.
//   7. Upsert repos (jsonb `capabilities` populated here only —
//      single-writer rule per reviewer issue arch#6).
//   8. Resolve tag slugs → tag IDs (batch select + batch insert
//      missing) and insert repo_tags with source='auto'.
//   9. Insert repo_assets for discovered README media.
//
// No ctx.spawn / WDK: Foundation's WDK integration is stub-only.
// Concurrency lives inside fetchRepoDetailsBatch (capped at 5).

import { extractReadmeMedia } from "@/lib/pipeline/extractors/readme-media";
import { extractTechStack } from "@/lib/pipeline/extractors/tech-stack";
import { extractVibecodingCompat } from "@/lib/pipeline/extractors/vibecoding-compat";
import { rpcAcquirePipelineLock, rpcReleasePipelineLock } from "@/lib/pipeline/github/db-rpc";
import type {
  FetchRepoDetailsResult,
  RepoDetails,
  SkippedRepoDetails,
} from "@/lib/pipeline/github/repo-details";
import { fetchRepoDetailsBatch } from "@/lib/pipeline/github/repo-details";
import type { SearchResultRepo } from "@/lib/pipeline/github/search";
import { buildDailySearchBatch, dryRunSearch, executeSearch } from "@/lib/pipeline/github/search";
import { type TagInput, upsertAndLinkTags } from "@/lib/pipeline/tags/resolve";
import type { JobContext } from "@/lib/types/jobs";

const DEFAULT_MAX_QUERIES = 20;
const DETAILS_CONCURRENCY = 5;
const GITHUB_ID_LOOKUP_CHUNK = 500;
const PUSHED_AFTER_MS = 180 * 24 * 60 * 60 * 1000;

export interface DiscoverInput {
  readonly maxQueries?: number;
}

export interface DiscoverOutput {
  repos_discovered: number;
  repos_skipped: number;
  queries_executed: number;
  lock_acquired: boolean;
  // Index signature to satisfy runJob's `O extends JobOutput` constraint.
  [key: string]: unknown;
}

interface CapabilitiesJson {
  has_cursor_rules: boolean;
  has_package_json: boolean;
  has_readme: boolean;
  vibecoding_tools: string[];
}

export async function discoverJob(
  ctx: JobContext,
  input: DiscoverInput = {},
): Promise<DiscoverOutput> {
  const maxQueries = input.maxQueries ?? DEFAULT_MAX_QUERIES;

  const lock = await acquireLock(ctx);
  if (!lock) {
    ctx.metric("lock_skipped", 1);
    return {
      repos_discovered: 0,
      repos_skipped: 0,
      queries_executed: 0,
      lock_acquired: false,
    };
  }

  try {
    // ── 1. Dry-run: one request with perPage=1 to validate pool + syntax.
    await dryRunSearch(ctx.db);

    // ── 2. Build the query batch.
    const pushedAfter = new Date(Date.now() - PUSHED_AFTER_MS);
    const queries = buildDailySearchBatch(pushedAfter).slice(0, maxQueries);

    // ── 3. Execute queries, collect unique SearchResultRepo by github_id.
    const collected = new Map<number, SearchResultRepo>();
    let queriesExecuted = 0;
    for (const q of queries) {
      const results = await executeSearch(ctx.db, q, { maxPages: 10, perPage: 100 });
      for (const r of results) {
        if (!collected.has(r.github_id)) collected.set(r.github_id, r);
      }
      queriesExecuted += 1;
    }

    // ── 4. Filter out repos we already have in the `repos` table.
    const newRepos = await filterExistingRepos(ctx, [...collected.values()]);
    if (newRepos.length === 0) {
      ctx.metric("queries_executed", queriesExecuted);
      ctx.metric("repos_discovered", 0);
      ctx.metric("repos_skipped", 0);
      return {
        repos_discovered: 0,
        repos_skipped: 0,
        queries_executed: queriesExecuted,
        lock_acquired: true,
      };
    }

    // ── 5. Fetch per-repo details (README + tree + package.json).
    const detailsMap = await fetchRepoDetailsBatch(
      ctx.db,
      newRepos.map((r) => ({ owner: r.owner, name: r.name, default_branch: r.default_branch })),
      { concurrency: DETAILS_CONCURRENCY },
    );

    // ── 6-9. Per-repo: extract → upsert repos → tags → assets.
    let reposDiscovered = 0;
    let reposSkipped = 0;
    for (const repo of newRepos) {
      const key = `${repo.owner}/${repo.name}`;
      const outcome = detailsMap.get(key);
      if (!outcome || outcome.skipped) {
        reposSkipped += 1;
        continue;
      }
      await ingestOne(ctx, repo, outcome);
      reposDiscovered += 1;
    }

    ctx.metric("queries_executed", queriesExecuted);
    ctx.metric("repos_discovered", reposDiscovered);
    ctx.metric("repos_skipped", reposSkipped);

    return {
      repos_discovered: reposDiscovered,
      repos_skipped: reposSkipped,
      queries_executed: queriesExecuted,
      lock_acquired: true,
    };
  } finally {
    await releaseLock(ctx);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Per-repo ingest
// ──────────────────────────────────────────────────────────────────────

async function ingestOne(
  ctx: JobContext,
  repo: SearchResultRepo,
  outcome: Extract<FetchRepoDetailsResult | SkippedRepoDetails, { skipped: false }>,
): Promise<void> {
  const details: RepoDetails = outcome.details;

  const techTags = extractTechStack(details.packageJson);
  const vibecodingTags = extractVibecodingCompat(details.fileTree);
  const media = details.readme ? await extractReadmeMedia(details.readme.content) : [];

  const capabilities: CapabilitiesJson = {
    has_cursor_rules: vibecodingTags.some((t) => t.slug === "cursor"),
    has_package_json: details.packageJson !== null,
    has_readme: details.readme !== null,
    vibecoding_tools: vibecodingTags.map((t) => t.slug),
  };

  // Upsert `repos`. `capabilities` is written here only — the
  // single-writer rule means refresh.ts does NOT touch this column.
  const { data: inserted, error: upsertErr } = await ctx.db
    .from("repos")
    .upsert(
      {
        github_id: repo.github_id,
        owner: repo.owner,
        name: repo.name,
        description: repo.description,
        homepage: repo.homepage,
        license: repo.license_spdx ?? "unknown",
        default_branch: repo.default_branch,
        stars: repo.stars,
        forks: repo.forks,
        watchers: repo.watchers,
        last_commit_at: repo.last_commit_at,
        github_created_at: repo.github_created_at,
        github_pushed_at: repo.github_pushed_at,
        readme_sha: details.readme?.sha ?? null,
        status: "pending",
        capabilities: capabilities as unknown as Record<string, unknown>,
      },
      { onConflict: "github_id" },
    )
    .select("id")
    .single();

  if (upsertErr || !inserted) {
    throw new Error(
      `discoverJob: repos upsert failed for ${repo.owner}/${repo.name}: ${
        upsertErr?.message ?? "no row returned"
      }`,
    );
  }

  const repoId = inserted.id;

  // Tags: resolve/create tag IDs in batch, then insert repo_tags.
  const allTags = [...techTags, ...vibecodingTags];
  if (allTags.length > 0) {
    const tagInputs: TagInput[] = allTags.map((t) => ({
      ...t,
      source: "auto" as const,
    }));
    await upsertAndLinkTags(ctx.db, repoId, tagInputs);
  }

  // Assets: insert any README media we found.
  if (media.length > 0) {
    const assetRows = media.map((m) => ({
      repo_id: repoId,
      kind: m.kind,
      external_url: m.url,
      priority: m.priority,
      source_url: `https://github.com/${repo.owner}/${repo.name}`,
    }));
    const { error: assetErr } = await ctx.db.from("repo_assets").insert(assetRows);
    if (assetErr) {
      console.warn(
        `[discoverJob] repo_assets insert failed for ${repo.owner}/${repo.name}: ${assetErr.message}`,
      );
    }
  }
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

async function filterExistingRepos(
  ctx: JobContext,
  candidates: SearchResultRepo[],
): Promise<SearchResultRepo[]> {
  if (candidates.length === 0) return [];

  const existing = new Set<number>();
  for (let i = 0; i < candidates.length; i += GITHUB_ID_LOOKUP_CHUNK) {
    const chunk = candidates.slice(i, i + GITHUB_ID_LOOKUP_CHUNK).map((r) => r.github_id);
    const { data, error } = await ctx.db.from("repos").select("github_id").in("github_id", chunk);
    if (error) throw new Error(`discoverJob: existing-repos select failed: ${error.message}`);
    for (const row of (data ?? []) as { github_id: number }[]) {
      existing.add(row.github_id);
    }
  }

  return candidates.filter((r) => !existing.has(r.github_id));
}

async function acquireLock(ctx: JobContext): Promise<boolean> {
  const { data, error } = await rpcAcquirePipelineLock(ctx.db, "discover");
  if (error) throw new Error(`discoverJob: acquire_pipeline_lock failed: ${error.message}`);
  return data === true;
}

async function releaseLock(ctx: JobContext): Promise<void> {
  const { error } = await rpcReleasePipelineLock(ctx.db, "discover");
  if (error) {
    console.warn(`[discoverJob] release_pipeline_lock failed: ${error.message}`);
  }
}
