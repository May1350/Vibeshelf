// Server-only marketplace queries. Routes through Postgres RPCs (defined in
// supabase/migrations/20260416000002_marketplace_rpcs.sql) which use the
// anon-client + RLS for read protection.
//
// IMPORTANT: empty-array convention for tag filter — pass [] never null.
// list_repos_with_tags HAVING uses array_length(p_tags, 1) which returns
// NULL on empty array; we handle that by routing through list_repos_no_tags
// when tags is empty.

import "server-only";

import { cacheLife, cacheTag } from "next/cache";
import { createAnonClient } from "@/lib/db";
import type { MarketplaceQuery } from "./search-params";

export interface MarketplaceRepoRow {
  id: string;
  owner: string;
  name: string;
  description: string | null;
  homepage: string | null;
  stars: number;
  forks: number;
  last_commit_at: string;
  category: string | null;
  tags_freeform: string[];
  total_score: number | null;
  documentation_score: number | null;
  maintenance_score: number | null;
  popularity_score: number | null;
  code_health_score: number | null;
  visual_preview_score: number | null;
  feature_tags: string[];
  tech_stack_tags: string[];
  vibecoding_tags: string[];
  hero_asset: HeroAsset | null;
}

export interface HeroAsset {
  kind: "readme_gif" | "readme_image" | "demo_screenshot" | "ai_generated";
  external_url: string | null;
  storage_key: string | null;
  width: number | null;
  height: number | null;
  priority: number;
}

export interface ListReposResult {
  items: MarketplaceRepoRow[];
  totalCount: number;
}

export async function listRepos(query: MarketplaceQuery): Promise<ListReposResult> {
  // Cache Components: each distinct query object gets its own cache entry.
  // Cron jobs `revalidateTag('repos:list', 'max')` on any changed repo data,
  // busting every cached list variant at once.
  "use cache";
  cacheTag("repos:list");
  cacheLife("hours");

  const db = createAnonClient();
  const offset = (query.page - 1) * 36;
  // Empty array → null (RPC treats either as "no category filter").
  const categoriesParam = query.categories.length > 0 ? query.categories : null;
  const baseParams = {
    p_q: query.q ?? null,
    p_categories: categoriesParam,
    p_min_score: query.min_score ?? null,
    p_vibecoding: query.vibecoding ?? null,
    p_sort: query.sort,
    p_offset: offset,
  };

  // biome-ignore lint/suspicious/noExplicitAny: RPC types regen pending (post-merge db:types)
  const dbAny = db as any;

  const hasTags = query.tags.length > 0;
  const fnName = hasTags ? "list_repos_with_tags" : "list_repos_no_tags";
  const countFnName = hasTags ? "list_repos_with_tags_count" : "list_repos_no_tags_count";
  const params = hasTags ? { ...baseParams, p_tags: query.tags } : baseParams;
  // Count RPC takes the WHERE-clause params only (no sort/offset).
  const countParams = {
    p_q: query.q ?? null,
    p_categories: categoriesParam,
    p_min_score: query.min_score ?? null,
    p_vibecoding: query.vibecoding ?? null,
    ...(hasTags ? { p_tags: query.tags } : {}),
  };
  const [listResult, countResult] = await Promise.all([
    dbAny.rpc(fnName, params),
    dbAny.rpc(countFnName, countParams),
  ]);
  if (listResult.error) throw new Error(`listRepos failed: ${listResult.error.message}`);
  if (countResult.error) throw new Error(`listRepos count failed: ${countResult.error.message}`);
  const data = listResult.data;
  const totalCount = (countResult.data as number | null) ?? 0;

  return {
    items: (data ?? []) as MarketplaceRepoRow[],
    totalCount,
  };
}

export interface RepoDetail extends MarketplaceRepoRow {
  scores: {
    documentation: number;
    code_health: number;
    maintenance: number;
    popularity: number;
    visual_preview: number;
    total: number;
    evidence_strength: "strong" | "partial" | "weak" | null;
  };
  assets: HeroAsset[];
  github_created_at: string;
  github_pushed_at: string;
  license: string;
  default_branch: string;
}

export async function getRepo(owner: string, name: string): Promise<RepoDetail | null> {
  // Cache Components: key on (owner, name) + tag by repo id once we know it.
  // Cron jobs `revalidateTag(\`repo:\${id}\`, 'max')` when a repo's data changes.
  "use cache";
  cacheLife("hours");

  const db = createAnonClient();
  // biome-ignore lint/suspicious/noExplicitAny: RPC types regen pending
  const dbAny = db as any;
  const { data, error } = await dbAny.rpc("get_repo_detail", { p_owner: owner, p_name: name });
  if (error) throw new Error(`getRepo failed: ${error.message}`);
  const repo = (data as RepoDetail | null) ?? null;
  // Tag with the resolved id so individual invalidations can hit this entry.
  // Calling cacheTag with a fallback string for missing repos still attaches a
  // tag so a future repo with that (owner, name) can bust the negative cache.
  cacheTag(repo ? `repo:${repo.id}` : `repo:missing:${owner}/${name}`);
  return repo;
}
