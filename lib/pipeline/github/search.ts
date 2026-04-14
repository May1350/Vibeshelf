// GitHub Search API: query builder + paginator.
//
// Responsibilities:
//   1. Build search query strings from structured SearchQuery objects.
//   2. Cycle a fixed keyword list × the license allowlist into a daily
//      batch of queries (the caller decides how many to actually run).
//   3. Paginate /search/repositories results, cap at GitHub's hard
//      limits (1000 results / 10 pages of 100), and defense-in-depth
//      filter by license allowlist even though the query already
//      constrains license.
//   4. Provide a cheap dry-run that pings the Search API with perPage=1
//      so jobs can fail-fast if the token pool has no budget / the
//      query syntax regresses.
//
// Framework-free (dep-cruiser boundary). All HTTP + token rotation is
// delegated to githubFetch, so this module only handles query shaping
// and response mapping.

import type { SupabaseClient } from "@/lib/db";
import { githubFetch } from "./client";
import { ValidationError } from "./errors";
import { ALLOWED_LICENSES, isLicenseAllowed } from "./license-allowlist";

export interface SearchQuery {
  keyword: string;
  license: string; // SPDX id, lowercase
  minStars: number;
  pushedAfter: Date; // repos with push activity after this date
}

export interface SearchResultRepo {
  github_id: number;
  owner: string;
  name: string;
  full_name: string;
  description: string | null;
  homepage: string | null;
  license_spdx: string | null;
  stars: number;
  forks: number;
  watchers: number;
  default_branch: string;
  last_commit_at: string; // ISO, from pushed_at
  github_created_at: string;
  github_pushed_at: string;
}

/**
 * The keyword templates we cycle through each day. Chosen to match how
 * template/boilerplate authors actually name their repos on GitHub —
 * "template", "starter-kit", "boilerplate" are the three canonical
 * spellings; the remainder narrow by vertical (dashboard, landing-page,
 * ecommerce, portfolio) or by stack (nextjs-starter, saas-template,
 * ai-starter). Order matters only in that the first element is what
 * dryRunSearch hits — keep something popular there so a zero-hit run
 * reliably signals a real problem.
 */
export const SEARCH_KEYWORDS = [
  "template",
  "starter-kit",
  "boilerplate",
  "saas-starter",
  "dashboard",
  "landing-page",
  "nextjs-starter",
  "saas-template",
  "admin-dashboard",
  "ai-starter",
  "ecommerce-template",
  "portfolio-template",
] as const;

// Defaults used by buildDailySearchBatch. `minStars` of 10 filters out
// abandoned one-off repos while still admitting promising early-stage
// templates (the marketplace editorial layer curates further). The
// pushedAfter window (6 months) is applied by the caller — the batch
// builder just embeds whatever they pass.
const DEFAULT_MIN_STARS = 10;
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_PER_PAGE = 100;
const MAX_SEARCH_RESULTS_PER_QUERY = 1000; // GitHub hard cap

/**
 * Build a GitHub Search API query string. URL-encoding is the caller's
 * job (githubFetch handles it via the URL constructor).
 */
export function buildSearchQueryString(q: SearchQuery): string {
  const date = toDateString(q.pushedAfter);
  return `${q.keyword} license:${q.license} stars:>=${q.minStars} pushed:>=${date}`;
}

/**
 * Cross-product of SEARCH_KEYWORDS × ALLOWED_LICENSES. Caller decides
 * how many of the ~60 combos to execute per run (Search API is 30
 * req/min per token, so a full sweep over 10 pages × 60 queries would
 * need careful budgeting).
 */
export function buildDailySearchBatch(pushedAfter: Date): SearchQuery[] {
  const batch: SearchQuery[] = [];
  for (const keyword of SEARCH_KEYWORDS) {
    for (const license of ALLOWED_LICENSES) {
      batch.push({
        keyword,
        license,
        minStars: DEFAULT_MIN_STARS,
        pushedAfter,
      });
    }
  }
  return batch;
}

interface GithubSearchResponse {
  total_count: number;
  incomplete_results?: boolean;
  items: GithubSearchItem[];
}

interface GithubSearchItem {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string } | null;
  description: string | null;
  homepage: string | null;
  license: { spdx_id: string | null } | null;
  stargazers_count: number;
  forks_count: number;
  watchers_count: number;
  default_branch: string;
  pushed_at: string;
  created_at: string;
}

/**
 * Execute a search with pagination. Defense-in-depth license filtering
 * drops any row whose spdx_id isn't on the allowlist — GitHub's license
 * field has been known to mis-detect (e.g. projects with a LICENSE file
 * that is a modified MIT showing as `other`). The query already does
 * the heavy lifting; this is a belt-and-suspenders guard.
 */
export async function executeSearch(
  db: SupabaseClient,
  q: SearchQuery,
  opts: { maxPages?: number; perPage?: number } = {},
): Promise<SearchResultRepo[]> {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const perPage = opts.perPage ?? DEFAULT_PER_PAGE;
  const queryString = buildSearchQueryString(q);

  const results: SearchResultRepo[] = [];
  let totalCount = Number.POSITIVE_INFINITY;

  for (let page = 1; page <= maxPages; page++) {
    // Stop before the 1000-result GitHub ceiling — paginating past it
    // always returns 422, which we handle below, but it's cleaner to
    // just not ask.
    if ((page - 1) * perPage >= MAX_SEARCH_RESULTS_PER_QUERY) break;
    if ((page - 1) * perPage >= totalCount) break;

    const path = buildSearchPath(queryString, page, perPage);

    let response: Awaited<ReturnType<typeof githubFetch>>;
    try {
      response = await githubFetch(path, { scope: "search" }, db);
    } catch (err) {
      // 422 on pagination = we've run past the effective result cap for
      // this query (sometimes < 1000 when GitHub truncates). Return
      // what we have so far; everything else propagates.
      if (err instanceof ValidationError) break;
      throw err;
    }

    const payload = response.data as GithubSearchResponse | null;
    if (!payload || !Array.isArray(payload.items)) break;

    totalCount = typeof payload.total_count === "number" ? payload.total_count : totalCount;

    for (const item of payload.items) {
      const mapped = mapSearchItem(item);
      if (!mapped) continue;
      if (!isLicenseAllowed(mapped.license_spdx)) continue;
      results.push(mapped);
    }

    // Short page = no more results. Saves an API call vs. looping to
    // the edge.
    if (payload.items.length < perPage) break;
  }

  return results;
}

/**
 * Cheap validation: single page, single result. Any throw surfaces to
 * the caller (discover job), which should then bail before committing
 * to a full batch.
 */
export async function dryRunSearch(db: SupabaseClient): Promise<void> {
  const firstKeyword = SEARCH_KEYWORDS[0];
  // Destructure the Set so TS narrows `firstLicense` to `string`.
  const [firstLicense] = ALLOWED_LICENSES;
  if (!firstKeyword || !firstLicense) {
    throw new Error("dryRunSearch: SEARCH_KEYWORDS or ALLOWED_LICENSES is empty");
  }

  // pushedAfter: 6mo ago is a reasonable liveness bar. The query never
  // reads this value for correctness — we just need a syntactically
  // valid date.
  const pushedAfter = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);

  await executeSearch(
    db,
    {
      keyword: firstKeyword,
      license: firstLicense,
      minStars: DEFAULT_MIN_STARS,
      pushedAfter,
    },
    { maxPages: 1, perPage: 1 },
  );
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function buildSearchPath(queryString: string, page: number, perPage: number): string {
  const params = new URLSearchParams({
    q: queryString,
    sort: "stars",
    order: "desc",
    per_page: String(perPage),
    page: String(page),
  });
  return `/search/repositories?${params.toString()}`;
}

/**
 * Map GitHub's raw search item to our canonical shape. Returns null for
 * items missing mandatory fields (owner login, default branch) — we'd
 * rather skip a single weirdly-shaped row than fail the whole batch.
 */
function mapSearchItem(item: GithubSearchItem): SearchResultRepo | null {
  const ownerLogin = item.owner?.login;
  if (!ownerLogin) return null;
  if (!item.default_branch) return null;
  if (typeof item.id !== "number") return null;

  const licenseSpdx = item.license?.spdx_id ? item.license.spdx_id.toLowerCase() : null;

  return {
    github_id: item.id,
    owner: ownerLogin,
    name: item.name,
    full_name: item.full_name,
    description: item.description ?? null,
    homepage: item.homepage ?? null,
    license_spdx: licenseSpdx,
    stars: item.stargazers_count ?? 0,
    forks: item.forks_count ?? 0,
    watchers: item.watchers_count ?? 0,
    default_branch: item.default_branch,
    last_commit_at: item.pushed_at,
    github_created_at: item.created_at,
    github_pushed_at: item.pushed_at,
  };
}

function toDateString(d: Date): string {
  // GitHub search accepts ISO dates (YYYY-MM-DD); strip time for a
  // cleaner query and stable cache keys.
  const iso = d.toISOString();
  return iso.slice(0, 10);
}
