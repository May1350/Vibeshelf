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
import type { ExtractedTag } from "@/lib/pipeline/extractors/tech-stack";
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
    await insertRepoTags(ctx, repoId, allTags);
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
// Tag resolution
// ──────────────────────────────────────────────────────────────────────

interface TagRow {
  id: string;
  slug: string;
  kind: "tech_stack" | "vibecoding_tool" | "feature";
}

async function insertRepoTags(
  ctx: JobContext,
  repoId: string,
  tags: ExtractedTag[],
): Promise<void> {
  // Dedup by (slug, kind) — an extractor could emit the same slug twice.
  const seen = new Set<string>();
  const unique: ExtractedTag[] = [];
  for (const t of tags) {
    const key = `${t.kind}:${t.slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(t);
  }
  if (unique.length === 0) return;

  // Batch-select existing rows by slug (citext → case-insensitive match).
  const slugs = unique.map((t) => t.slug);
  const { data: existing, error: selErr } = await ctx.db
    .from("tags")
    .select("id, slug, kind")
    .in("slug", slugs);
  if (selErr) throw new Error(`discoverJob: tags select failed: ${selErr.message}`);

  const byKey = new Map<string, TagRow>();
  for (const row of (existing ?? []) as TagRow[]) {
    byKey.set(`${row.kind}:${row.slug.toLowerCase()}`, row);
  }

  // Insert any tags that are missing. Use individual upserts (rare path;
  // only happens the first time a slug is seen).
  const missing = unique.filter((t) => !byKey.has(`${t.kind}:${t.slug.toLowerCase()}`));
  if (missing.length > 0) {
    const { data: inserted, error: insErr } = await ctx.db
      .from("tags")
      .upsert(
        missing.map((t) => ({ slug: t.slug, kind: t.kind, label: humanizeSlug(t.slug) })),
        { onConflict: "slug", ignoreDuplicates: false },
      )
      .select("id, slug, kind");
    if (insErr) throw new Error(`discoverJob: tags insert failed: ${insErr.message}`);
    for (const row of (inserted ?? []) as TagRow[]) {
      byKey.set(`${row.kind}:${row.slug.toLowerCase()}`, row);
    }
  }

  // Build repo_tags rows, matching each ExtractedTag to its tag row.
  const repoTagRows: Array<{
    repo_id: string;
    tag_id: string;
    confidence: number;
    source: string;
  }> = [];
  for (const t of unique) {
    const row = byKey.get(`${t.kind}:${t.slug.toLowerCase()}`);
    if (!row) continue;
    repoTagRows.push({
      repo_id: repoId,
      tag_id: row.id,
      confidence: t.confidence,
      source: "auto",
    });
  }

  if (repoTagRows.length === 0) return;

  const { error: junctionErr } = await ctx.db
    .from("repo_tags")
    .upsert(repoTagRows, { onConflict: "repo_id,tag_id", ignoreDuplicates: true });
  if (junctionErr) {
    throw new Error(`discoverJob: repo_tags upsert failed: ${junctionErr.message}`);
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

function humanizeSlug(slug: string): string {
  // e.g. "nextjs" → "Nextjs", "react-query" → "React Query".
  // Lives here (not in a shared util) because only tag insertion needs it.
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");
}
