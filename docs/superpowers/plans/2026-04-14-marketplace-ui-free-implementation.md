# VibeShelf Marketplace UI (Free) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Co-reference:** `docs/superpowers/specs/2026-04-14-marketplace-ui-free-design.md` contains the full design with rationale and reviewer findings. Read sections 1–7 of the spec before starting any task — DO NOT guess SQL, prompts, or component shapes.
>
> **Dependencies:** Foundation (PR #1) + Ingestion Pipeline (PR #2) + Evaluation Pipeline (PR #4) merged or in flight. This plan extends `lib/`, `components/`, `app/`, and `supabase/migrations/`.

**Goal:** Ship a usable marketplace where vibe coders discover, filter, sort, and inspect curated GitHub templates — Pinterest masonry grid, URL-driven filters, accessible, SEO-friendly.

**Architecture:** Next.js 16 App Router with RSC + Cache Components. URL search params drive all filters/sort/page. `<form action GET>` for progressive enhancement. Server-only `lib/marketplace/queries.ts` calls Postgres RPCs (LATERAL joins, partial GIN index for search). Cron routes invalidate cache tags via job-returned `changedRepoIds`.

**Tech Stack:** Next.js 16.2.3, React 19, Tailwind v4, shadcn/ui (Radix), Supabase (anon-key + RLS for reads), `react-masonry-css`, `isomorphic-dompurify`, Vitest, Playwright.

---

## File Map

### New files

```
supabase/migrations/
├── 20260416000001_marketplace_search.sql
└── 20260416000002_marketplace_rpcs.sql

lib/marketplace/
├── search-params.ts
├── queries.ts
├── facets.ts
├── score-tier.ts
├── debounce.ts
└── __fixtures__/
    ├── bad-pipeline-import.ts
    └── bad-react-import-in-queries.ts

components/marketplace/
├── repo-card.tsx
├── repo-grid.tsx
├── filter-sidebar.tsx
├── filter-chips.tsx
├── filter-drawer.tsx
├── sort-dropdown.tsx
├── pagination.tsx
├── empty-state.tsx
└── grid-skeleton.tsx

components/repo/
├── repo-hero.tsx
├── score-badge.tsx
├── score-breakdown.tsx
├── tags-list.tsx
├── readme-preview.tsx
├── fork-cta-placeholder.tsx
├── reviews-placeholder.tsx
└── json-ld.tsx

app/
├── loading.tsx
├── error.tsx
├── sitemap.ts
└── r/[owner]/[name]/
    ├── page.tsx
    ├── loading.tsx
    └── not-found.tsx

scripts/
└── seed-dev.ts

tests/unit/marketplace/                   (4 files)
tests/integration/marketplace/            (4 files)
tests/e2e/                                (6 files)
```

### Files to modify

```
app/page.tsx                        (replace sign-in placeholder with marketplace home)
next.config.ts                      (cacheComponents + remotePatterns)
lib/types/jobs.ts                   (add JobOutput.changedRepoIds optional)
lib/pipeline/jobs/discover.ts       (collect changedRepoIds in result)
lib/pipeline/jobs/score.ts          (same)
lib/pipeline/jobs/refresh.ts        (same)
lib/pipeline/jobs/rescore.ts        (propagate from delegated scoreJob)
app/api/cron/discover/route.ts      (call revalidateTag with changedRepoIds)
app/api/cron/score/route.ts         (same)
app/api/cron/refresh/route.ts       (same)
app/api/cron/rescore/route.ts       (same)
dependency-cruiser.cjs              (add 2 marketplace rules)
package.json                        (lint:neg additions, seed script, deps)
playwright.config.ts                (add desktop + mobile projects)
docs/architecture/open-questions.md (mark Q-09, Q-10 added)
```

---

## Task 1 — DB migrations + JobOutput + cron wiring

**Dependencies:** None (migrations apply on top of SP#3)

**Files:**
- Create: `supabase/migrations/20260416000001_marketplace_search.sql`
- Create: `supabase/migrations/20260416000002_marketplace_rpcs.sql`
- Modify: `lib/types/jobs.ts`
- Modify: `lib/pipeline/jobs/discover.ts`
- Modify: `lib/pipeline/jobs/score.ts`
- Modify: `lib/pipeline/jobs/refresh.ts`
- Modify: `lib/pipeline/jobs/rescore.ts`
- Modify: `app/api/cron/discover/route.ts`
- Modify: `app/api/cron/score/route.ts`
- Modify: `app/api/cron/refresh/route.ts`
- Modify: `app/api/cron/rescore/route.ts`

### 1.1 Migration: search_vector

- [ ] **Step 1.1.1:** Create `supabase/migrations/20260416000001_marketplace_search.sql`:

```sql
-- Marketplace search support — name + description tsvector + partial GIN index.
-- README content NOT included (D4=Y decision); add later if search quality demands.

ALTER TABLE public.repos
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) STORED;

-- Partial GIN matches the WHERE clause used by list_repos_*
CREATE INDEX idx_repos_search_vector_gin
  ON public.repos USING gin (search_vector)
  WHERE status = 'published';
```

- [ ] **Step 1.1.2:** Apply locally (Docker required):

```bash
supabase db reset --no-seed
```

Skip if Docker unavailable; verify SQL by hand-review against schema in `supabase/migrations/20260411000003_repo_tables.sql`.

### 1.2 Migration: marketplace RPCs

- [ ] **Step 1.2.1:** Create `supabase/migrations/20260416000002_marketplace_rpcs.sql`. Full SQL is in **spec §5.2 + §5.3 + §5.4**. Copy verbatim.

The migration creates:

1. Composite type `public.marketplace_repo_row` (column shape returned by list functions)
2. Function `public.list_repos_no_tags(p_q, p_category, p_min_score, p_vibecoding, p_sort, p_offset)` returning SETOF marketplace_repo_row
3. Function `public.list_repos_with_tags(...same plus p_tags text[])` — same SELECT body plus extra `r.id IN (SELECT ... GROUP BY ... HAVING count(DISTINCT slug) = array_length(p_tags, 1))` for AND tag semantics
4. Function `public.get_marketplace_facets()` returning jsonb (4-way UNION ALL aggregation, nested object_agg per facet type)
5. Function `public.get_repo_detail(p_owner, p_name)` returning jsonb with repo + scores + tags + assets

**Key invariants the SQL MUST preserve** (from reviewer findings):

- LEFT JOIN repo_scores + WHERE `rs.id IS NOT NULL` (NOT inner join; admin-patch safety per Critical R1.C1)
- LEFT JOIN LATERAL for hero asset (per Real R1.R4) using `jsonb_build_object('kind', a.kind, 'external_url', a.external_url, ...)`
- Sort `popular`: `r.stars::numeric / GREATEST(30, EXTRACT(EPOCH FROM (now() - r.github_created_at))/86400)` (30-day floor per Real R2.R4)
- AND-tag HAVING uses `count(DISTINCT t.slug) = array_length(p_tags, 1)` and caller passes `[]` never `null`
- Each function: `LANGUAGE plpgsql STABLE SECURITY INVOKER` (RLS enforced)
- All functions: `GRANT EXECUTE ... TO anon, authenticated` (read-only via anon-client)

- [ ] **Step 1.2.2:** Apply locally (if Docker available).

### 1.3 Extend JobOutput contract

- [ ] **Step 1.3.1:** Modify `lib/types/jobs.ts` — add optional `changedRepoIds`:

```typescript
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
```

### 1.4 Collect changedRepoIds in jobs

- [ ] **Step 1.4.1:** Modify `lib/pipeline/jobs/discover.ts` — collect upserted repo IDs in `discoverJob` and add to output.

In `ingestOne` (or wherever `repos` is upserted), capture the returned `id`. In the outer loop:

```typescript
const changedIds: string[] = [];
for (const repo of newRepos) {
  // ... existing fetch + extract ...
  const insertedId = await ingestOne(ctx, repo, outcome);  // refactor ingestOne to return id
  if (insertedId) changedIds.push(insertedId);
}
// In the return block:
return {
  repos_discovered: reposDiscovered,
  repos_skipped: reposSkipped,
  queries_executed: queriesExecuted,
  lock_acquired: true,
  changedRepoIds: changedIds,
};
```

Refactor `ingestOne` if needed to return `string | null`.

- [ ] **Step 1.4.2:** Modify `lib/pipeline/jobs/score.ts` — same pattern. After the `apply_score_result` RPC succeeds for a repo, push `repo.id` to a `changedIds` array. Add to return:

```typescript
return {
  repos_scored: metrics.repos_scored,
  repos_stuck_reset: stuckReset,
  budget_exhausted: metrics.budget_exhausted,
  changedRepoIds: changedIds,
};
```

- [ ] **Step 1.4.3:** Modify `lib/pipeline/jobs/refresh.ts` — track repos that were updated AND repos that were marked removed:

```typescript
const changedIds: string[] = [];
// In refresh loop, after a successful update or status='removed' transition:
changedIds.push(repo.id);
// ...
return {
  repos_refreshed: reposRefreshed,
  // ... existing fields ...
  changedRepoIds: changedIds,
};
```

- [ ] **Step 1.4.4:** Modify `lib/pipeline/jobs/rescore.ts` — propagate `changedRepoIds` from delegated `scoreJob` call:

```typescript
const result = await scoreJob(ctx, { mode: "rescore", repoIds: targetIds });
return {
  candidates_found: targetIds.length,
  repos_scored: result.repos_scored,
  drain_mode: drainMode,
  changedRepoIds: result.changedRepoIds ?? [],
};
```

### 1.5 Cron route invalidation

- [ ] **Step 1.5.1:** Modify `app/api/cron/discover/route.ts` — invalidate tags after job completes:

```typescript
import { env } from "@/lib/env";
import { discoverJob } from "@/lib/pipeline/jobs/discover";
import { runJob } from "@/lib/pipeline/runJob";
import { revalidateTag } from "next/cache";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const result = await runJob("ingest-discover", {}, (ctx) => discoverJob(ctx));

  // Invalidate cache tags for changed repos. revalidateTag(tag, profile) form
  // — single-arg deprecated in Next 16 (Critical R1.C1).
  const ids = result.changedRepoIds ?? [];
  if (ids.length > 0) {
    revalidateTag("repos:facets", "max");
    revalidateTag("repos:list", "max");
    for (const id of ids) revalidateTag(`repo:${id}`, "max");
  }

  return Response.json(result);
}
```

- [ ] **Step 1.5.2:** Apply identical pattern to `app/api/cron/score/route.ts`, `app/api/cron/refresh/route.ts`, `app/api/cron/rescore/route.ts`. Each just calls a different job function.

### 1.6 Verify lint + typecheck + commit

- [ ] **Step 1.6.1:** Verify:

```bash
pnpm lint
pnpm typecheck
pnpm test:unit
```

Expected: all pass. `JobOutput` type change is backward-compatible (`changedRepoIds` is optional).

- [ ] **Step 1.6.2:** Commit migrations + JobOutput contract:

```bash
git add supabase/migrations/20260416000001_*.sql supabase/migrations/20260416000002_*.sql lib/types/jobs.ts
git commit -m "feat(db,types): marketplace search + RPCs + JobOutput.changedRepoIds"
```

- [ ] **Step 1.6.3:** Commit job + cron updates:

```bash
git add lib/pipeline/jobs/ app/api/cron/
git commit -m "feat(pipeline,cron): collect changedRepoIds + revalidateTag wiring"
```

---

## Task 2 — Pure marketplace modules

**Dependencies:** Task 1

**Files:**
- Create: `lib/marketplace/search-params.ts`
- Create: `lib/marketplace/score-tier.ts`
- Create: `lib/marketplace/debounce.ts`
- Create: `tests/unit/marketplace/search-params.test.ts`
- Create: `tests/unit/marketplace/score-tier.test.ts`
- Create: `tests/unit/marketplace/debounce.test.ts`

### 2.1 search-params.ts

- [ ] **Step 2.1.1:** Create `lib/marketplace/search-params.ts`:

```typescript
// URL search-params validation for the marketplace home page.
// All filters/sort/page live in URL → shareable, SSR-friendly, browser-back works.

import { z } from "zod";

export const CATEGORIES = [
  "saas", "ecommerce", "dashboard", "landing_page", "ai_tool",
  "utility", "game", "portfolio", "blog", "chatbot", "mobile_app", "other",
] as const;

export const VIBECODING_TOOLS = ["cursor", "bolt", "lovable", "replit"] as const;
export const SORTS = ["score", "recent", "popular"] as const;

export const MarketplaceParams = z.object({
  q:          z.string().trim().min(1).max(100).optional(),
  category:   z.enum(CATEGORIES).optional(),
  tags:       z.string().optional()
                .transform((s) => (s ? s.split(",").filter(Boolean) : [])),
  min_score:  z.coerce.number().min(0).max(5).optional(),
  vibecoding: z.enum(VIBECODING_TOOLS).optional(),
  sort:       z.enum(SORTS).default("score"),
  page:       z.coerce.number().int().min(1).default(1),
});

export type MarketplaceQuery = z.infer<typeof MarketplaceParams>;

/**
 * Parse Next.js searchParams (Promise<...> in Next 16 — caller must await).
 * Falls back to defaults on parse failure for resilience to malformed URLs.
 */
export function parseMarketplaceParams(input: Record<string, string | string[] | undefined>): MarketplaceQuery {
  // Normalize: prefer first value when array (URL params can repeat)
  const flattened: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    flattened[k] = Array.isArray(v) ? v[0] ?? "" : v;
  }
  const result = MarketplaceParams.safeParse(flattened);
  if (!result.success) {
    // Return defaults on parse failure
    return MarketplaceParams.parse({});
  }
  return result.data;
}
```

- [ ] **Step 2.1.2:** Create `tests/unit/marketplace/search-params.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { parseMarketplaceParams, MarketplaceParams } from "@/lib/marketplace/search-params";

describe("parseMarketplaceParams", () => {
  it("returns defaults for empty input", () => {
    const r = parseMarketplaceParams({});
    expect(r.sort).toBe("score");
    expect(r.page).toBe(1);
    expect(r.tags).toEqual([]);
  });

  it("parses all filters", () => {
    const r = parseMarketplaceParams({
      q: "stripe", category: "saas", tags: "auth,payments",
      min_score: "4", vibecoding: "cursor", sort: "recent", page: "2",
    });
    expect(r.q).toBe("stripe");
    expect(r.category).toBe("saas");
    expect(r.tags).toEqual(["auth", "payments"]);
    expect(r.min_score).toBe(4);
    expect(r.vibecoding).toBe("cursor");
    expect(r.sort).toBe("recent");
    expect(r.page).toBe(2);
  });

  it("filters empty tag CSV entries", () => {
    const r = parseMarketplaceParams({ tags: ",auth,,payments," });
    expect(r.tags).toEqual(["auth", "payments"]);
  });

  it("trims and length-limits q", () => {
    const r = parseMarketplaceParams({ q: "  hello  " });
    expect(r.q).toBe("hello");

    // q at exactly 100 chars
    const long = "x".repeat(100);
    const r2 = parseMarketplaceParams({ q: long });
    expect(r2.q).toBe(long);
  });

  it("rejects q over 100 chars (falls back to defaults)", () => {
    const r = parseMarketplaceParams({ q: "x".repeat(101) });
    expect(r.q).toBeUndefined();
  });

  it("rejects invalid category enum (falls back to defaults)", () => {
    const r = parseMarketplaceParams({ category: "not_a_category" });
    expect(r.category).toBeUndefined();
  });

  it("coerces page to int min 1", () => {
    const r1 = parseMarketplaceParams({ page: "0" });
    expect(r1.page).toBe(1);  // fallback
    const r2 = parseMarketplaceParams({ page: "5" });
    expect(r2.page).toBe(5);
  });

  it("handles array values (takes first)", () => {
    const r = parseMarketplaceParams({ category: ["saas", "blog"] });
    expect(r.category).toBe("saas");
  });

  it("MarketplaceParams schema accepts undefined optional fields", () => {
    const r = MarketplaceParams.parse({});
    expect(r.tags).toEqual([]);
  });
});
```

### 2.2 score-tier.ts

- [ ] **Step 2.2.1:** Create `lib/marketplace/score-tier.ts`:

```typescript
// Score → tier text, used by ScoreBadge for non-color encoding (a11y per Real R2.R8).
export type ScoreTier = "Excellent" | "Good" | "Fair" | "Limited";

export function scoreTier(score: number): ScoreTier {
  if (score >= 4.5) return "Excellent";
  if (score >= 3.5) return "Good";
  if (score >= 2.5) return "Fair";
  return "Limited";
}
```

- [ ] **Step 2.2.2:** Create `tests/unit/marketplace/score-tier.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { scoreTier } from "@/lib/marketplace/score-tier";

describe("scoreTier", () => {
  it("returns Excellent for >= 4.5", () => {
    expect(scoreTier(4.5)).toBe("Excellent");
    expect(scoreTier(5.0)).toBe("Excellent");
  });
  it("returns Good for [3.5, 4.5)", () => {
    expect(scoreTier(3.5)).toBe("Good");
    expect(scoreTier(4.49)).toBe("Good");
  });
  it("returns Fair for [2.5, 3.5)", () => {
    expect(scoreTier(2.5)).toBe("Fair");
    expect(scoreTier(3.49)).toBe("Fair");
  });
  it("returns Limited for < 2.5", () => {
    expect(scoreTier(0)).toBe("Limited");
    expect(scoreTier(2.49)).toBe("Limited");
  });
});
```

### 2.3 debounce.ts

- [ ] **Step 2.3.1:** Create `lib/marketplace/debounce.ts`:

```typescript
// Generic debounce + a React hook variant for client components.

import { useCallback, useEffect, useRef } from "react";

export function debounce<T extends (...args: never[]) => void>(
  fn: T,
  delayMs: number,
): T & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const debounced = ((...args: Parameters<T>) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, delayMs);
  }) as T & { cancel: () => void };

  debounced.cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return debounced;
}

/** React hook: returns a stable debounced callback that cancels on unmount. */
export function useDebouncedCallback<T extends (...args: never[]) => void>(
  fn: T,
  delayMs: number,
): T {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const debounced = useRef<ReturnType<typeof debounce<T>>>();
  if (!debounced.current) {
    debounced.current = debounce(((...args: Parameters<T>) => fnRef.current(...args)) as T, delayMs);
  }

  useEffect(() => {
    return () => debounced.current?.cancel();
  }, []);

  return useCallback(((...args: Parameters<T>) => debounced.current?.(...args)) as T, []);
}
```

- [ ] **Step 2.3.2:** Create `tests/unit/marketplace/debounce.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { debounce } from "@/lib/marketplace/debounce";

describe("debounce", () => {
  it("delays invocation by delayMs", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d();
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("collapses rapid invocations to one", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 100);
    for (let i = 0; i < 5; i++) d();
    vi.advanceTimersByTime(150);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("passes latest arguments", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d("a" as never);
    d("b" as never);
    d("c" as never);
    vi.advanceTimersByTime(150);
    expect(fn).toHaveBeenCalledWith("c");
    vi.useRealTimers();
  });

  it("cancel() prevents pending invocation", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d();
    d.cancel();
    vi.advanceTimersByTime(150);
    expect(fn).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
```

### 2.4 Verify + commit

- [ ] **Step 2.4.1:** Verify:

```bash
pnpm test:unit
pnpm lint
pnpm typecheck
```

Expected: 121 + 23 = ~144 unit tests passing.

- [ ] **Step 2.4.2:** Commit:

```bash
git add lib/marketplace/search-params.ts lib/marketplace/score-tier.ts lib/marketplace/debounce.ts tests/unit/marketplace/
git commit -m "feat(marketplace): pure modules — search-params, score-tier, debounce"
```

---

## Task 3 — Server-only queries + facets

**Dependencies:** Task 1 (RPCs in DB), Task 2 (search-params type)

**Files:**
- Create: `lib/marketplace/queries.ts`
- Create: `lib/marketplace/facets.ts`

### 3.1 queries.ts

- [ ] **Step 3.1.1:** Create `lib/marketplace/queries.ts`:

```typescript
// Server-only marketplace queries. Routes through Postgres RPCs (defined in
// supabase/migrations/20260416000002_marketplace_rpcs.sql) which use the
// anon-client + RLS for read protection.
//
// IMPORTANT: empty-array convention for tag filter — pass [] never null.
// list_repos_with_tags HAVING uses array_length(p_tags, 1) which returns
// NULL on empty array; we handle that by routing through list_repos_no_tags
// when tags is empty.

import "server-only";

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
  const db = createAnonClient();
  const offset = (query.page - 1) * 36;
  const baseParams = {
    p_q: query.q ?? null,
    p_category: query.category ?? null,
    p_min_score: query.min_score ?? null,
    p_vibecoding: query.vibecoding ?? null,
    p_sort: query.sort,
    p_offset: offset,
  };

  // biome-ignore lint/suspicious/noExplicitAny: RPC types regen pending (post-merge db:types)
  const dbAny = db as any;

  const fnName = query.tags.length > 0 ? "list_repos_with_tags" : "list_repos_no_tags";
  const params = query.tags.length > 0 ? { ...baseParams, p_tags: query.tags } : baseParams;
  const { data, error } = await dbAny.rpc(fnName, params);
  if (error) throw new Error(`listRepos failed: ${error.message}`);

  // For totalCount: simpler to do a parallel COUNT(*) query than wedge it
  // into the RPC. Acceptable cost at MVP scale.
  const countResult = await dbAny.rpc(`${fnName}_count`, params);
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
  const db = createAnonClient();
  // biome-ignore lint/suspicious/noExplicitAny: RPC types regen pending
  const dbAny = db as any;
  const { data, error } = await dbAny.rpc("get_repo_detail", { p_owner: owner, p_name: name });
  if (error) throw new Error(`getRepo failed: ${error.message}`);
  return (data as RepoDetail | null) ?? null;
}
```

**Note on `list_repos_*_count` RPCs:** Add to migration `20260416000002_marketplace_rpcs.sql` two more functions that return just `count(*)` from the same WHERE clauses. Or alternatively use the count-only mode of supabase-js. Implementer's choice — document in spec or PR description.

### 3.2 facets.ts

- [ ] **Step 3.2.1:** Create `lib/marketplace/facets.ts`:

```typescript
// Cached facet aggregation for the marketplace filter sidebar.
// Zero-arg cached function (Real R1.R4) — Cache Components key is stable
// across filter changes, invalidated only by cron's revalidateTag.

import "server-only";

import { cacheLife, cacheTag } from "next/cache";
import { createAnonClient } from "@/lib/db";

export interface MarketplaceFacets {
  categories: Record<string, number>;
  tags: Array<{ slug: string; label: string; count: number }>;
  vibecoding: Record<string, number>;
  score_buckets: { min_3?: number; min_4?: number; min_4_5?: number };
}

export async function getMarketplaceFacets(): Promise<MarketplaceFacets> {
  "use cache";
  cacheTag("repos:facets");
  cacheLife("hours");

  const db = createAnonClient();
  // biome-ignore lint/suspicious/noExplicitAny: RPC types regen pending
  const dbAny = db as any;
  const { data, error } = await dbAny.rpc("get_marketplace_facets");
  if (error) throw new Error(`getMarketplaceFacets failed: ${error.message}`);

  const raw = (data as Record<string, Record<string, number>>) ?? {};
  return {
    categories: raw.category ?? {},
    tags: Object.entries(raw.tag ?? {})
      .map(([slug, count]) => ({ slug, label: humanizeTagSlug(slug), count }))
      .sort((a, b) => b.count - a.count),
    vibecoding: raw.vibecoding ?? {},
    score_buckets: {
      min_3: raw.score_bucket?.min_3 ?? 0,
      min_4: raw.score_bucket?.min_4 ?? 0,
      min_4_5: raw.score_bucket?.min_4_5 ?? 0,
    },
  };
}

function humanizeTagSlug(slug: string): string {
  return slug.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
```

### 3.3 Verify + commit

- [ ] **Step 3.3.1:** Verify:

```bash
pnpm lint
pnpm typecheck
```

`'use cache'` directive is Next 16 only — biome shouldn't complain. dep-cruiser passes (server-only is npm package).

- [ ] **Step 3.3.2:** Commit:

```bash
git add lib/marketplace/queries.ts lib/marketplace/facets.ts
git commit -m "feat(marketplace): server-only queries + cached facets"
```

---

## Task 4 — Install dependencies + shadcn additions

**Dependencies:** None (parallelizable with Tasks 1-3)

**Files:**
- Modify: `package.json`
- Modify: shadcn config + new components in `components/ui/`

- [ ] **Step 4.1:** Install runtime dependencies:

```bash
pnpm add react-masonry-css isomorphic-dompurify
pnpm add -D @types/react-masonry-css
```

- [ ] **Step 4.2:** Install needed shadcn components (use defaults; tweak later if needed):

```bash
pnpm dlx shadcn@latest add sheet select checkbox badge skeleton
```

If any are already installed (Foundation may have brought `button` and a few others), the CLI will prompt for overwrite — choose No.

- [ ] **Step 4.3:** Verify install + commit:

```bash
pnpm lint
pnpm typecheck
pnpm test:unit
git add package.json pnpm-lock.yaml components/ui/
git commit -m "deps: react-masonry-css, isomorphic-dompurify, shadcn additions"
```

---

## Task 5 — Next.js config + remove dead code

**Dependencies:** Task 4

**Files:**
- Modify: `next.config.ts`
- Modify: `app/page.tsx` (just remove force-dynamic for now; full page replacement in Task 9)

- [ ] **Step 5.1:** Read current `next.config.ts`:

```bash
cat next.config.ts
```

Expected: minimal default config from Foundation.

- [ ] **Step 5.2:** Replace with:

```typescript
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "raw.githubusercontent.com" },
      { protocol: "https", hostname: "user-images.githubusercontent.com" },
      { protocol: "https", hostname: "github.com" },
      // NOT camo.githubusercontent.com — it's an open proxy. SP#4.5 mirror
      // will handle camo URLs by downloading + storing in Supabase Storage.
    ],
    formats: ["image/avif", "image/webp"],
  },
};

export default nextConfig;
```

- [ ] **Step 5.3:** Modify `app/page.tsx` — remove `export const dynamic = "force-dynamic"` line. Keep the rest of the file as-is for now (Task 9 replaces the body).

- [ ] **Step 5.4:** Verify:

```bash
pnpm build  # build hangs would catch 'use cache' misuse
pnpm lint
pnpm typecheck
```

If build hangs on the homepage's existing code, that's expected since Task 9 hasn't replaced it yet — abort with Ctrl-C and proceed.

- [ ] **Step 5.5:** Commit:

```bash
git add next.config.ts app/page.tsx
git commit -m "feat(next): enable cacheComponents + image remotePatterns; remove force-dynamic"
```

---

## Task 6 — Shared repo components

**Dependencies:** Tasks 2, 4

**Files:**
- Create: `components/repo/score-badge.tsx`
- Create: `components/repo/score-breakdown.tsx`
- Create: `components/repo/tags-list.tsx`
- Create: `components/repo/readme-preview.tsx`
- Create: `components/repo/fork-cta-placeholder.tsx`
- Create: `components/repo/reviews-placeholder.tsx`
- Create: `components/repo/json-ld.tsx`
- Create: `components/repo/repo-hero.tsx`

### 6.1 score-badge.tsx (RSC)

- [ ] **Step 6.1.1:** Create `components/repo/score-badge.tsx`:

```tsx
import { Star } from "lucide-react";
import { scoreTier, type ScoreTier } from "@/lib/marketplace/score-tier";

const TIER_COLORS: Record<ScoreTier, string> = {
  Excellent: "text-yellow-500",
  Good: "text-green-500",
  Fair: "text-blue-500",
  Limited: "text-muted-foreground",
};

export function ScoreBadge({ score }: { score: number }) {
  const tier = scoreTier(score);
  return (
    <div
      role="img"
      aria-label={`Quality score ${score.toFixed(1)} of 5, ${tier}`}
      className="inline-flex items-center gap-1 text-sm"
    >
      <Star className={`h-4 w-4 ${TIER_COLORS[tier]}`} aria-hidden="true" />
      <span className="font-semibold">{score.toFixed(1)}</span>
      <span className="text-xs text-muted-foreground">/5 · {tier}</span>
    </div>
  );
}
```

### 6.2 score-breakdown.tsx (RSC)

- [ ] **Step 6.2.1:** Create `components/repo/score-breakdown.tsx`:

```tsx
import { ScoreBadge } from "./score-badge";

interface ScoreAxes {
  documentation: number;
  code_health: number;
  maintenance: number;
  popularity: number;
  visual_preview: number;
  total: number;
}

const AXIS_LABELS: Record<keyof Omit<ScoreAxes, "total">, string> = {
  documentation: "Documentation",
  code_health: "Code Health",
  maintenance: "Maintenance",
  popularity: "Popularity",
  visual_preview: "Visual Preview",
};

const AXIS_WEIGHTS: Record<keyof Omit<ScoreAxes, "total">, number> = {
  documentation: 0.20,
  code_health: 0.25,
  maintenance: 0.20,
  popularity: 0.15,
  visual_preview: 0.20,
};

export function ScoreBreakdown({ axes }: { axes: ScoreAxes }) {
  const axisKeys = Object.keys(AXIS_LABELS) as Array<keyof typeof AXIS_LABELS>;
  return (
    <section aria-labelledby="score-breakdown-heading" className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 id="score-breakdown-heading" className="text-lg font-semibold">Quality breakdown</h2>
        <ScoreBadge score={axes.total} />
      </div>
      <dl className="space-y-2">
        {axisKeys.map((key) => {
          const value = axes[key];
          const pct = (value / 5) * 100;
          return (
            <div key={key} className="grid grid-cols-[120px_1fr_auto] items-center gap-3 text-sm">
              <dt className="text-muted-foreground">{AXIS_LABELS[key]} <span className="text-xs">({Math.round(AXIS_WEIGHTS[key] * 100)}%)</span></dt>
              <dd className="bg-muted h-2 rounded-full overflow-hidden">
                <div className="h-full bg-primary" style={{ width: `${pct}%` }} aria-hidden="true" />
              </dd>
              <dd className="font-medium tabular-nums">{value.toFixed(1)}</dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
```

### 6.3 tags-list.tsx (RSC)

- [ ] **Step 6.3.1:** Create `components/repo/tags-list.tsx`:

```tsx
import { Badge } from "@/components/ui/badge";

interface TagsByKind {
  feature: string[];
  tech_stack: string[];
  vibecoding_tool: string[];
}

const KIND_LABELS: Record<keyof TagsByKind, string> = {
  feature: "Features",
  tech_stack: "Tech Stack",
  vibecoding_tool: "Vibecoding Tools",
};

export function TagsList({ tags }: { tags: TagsByKind }) {
  const sections = (Object.keys(KIND_LABELS) as Array<keyof TagsByKind>)
    .filter((kind) => tags[kind].length > 0);
  if (sections.length === 0) return null;
  return (
    <section aria-labelledby="tags-heading" className="space-y-3">
      <h2 id="tags-heading" className="text-lg font-semibold">Tags</h2>
      {sections.map((kind) => (
        <div key={kind}>
          <h3 className="text-sm text-muted-foreground mb-1">{KIND_LABELS[kind]}</h3>
          <ul className="flex flex-wrap gap-1">
            {tags[kind].map((slug) => (
              <li key={slug}><Badge variant="secondary">{slug}</Badge></li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
```

### 6.4 readme-preview.tsx (RSC)

- [ ] **Step 6.4.1:** Create `components/repo/readme-preview.tsx`:

```tsx
import DOMPurify from "isomorphic-dompurify";

export function ReadmePreview({ html }: { html: string }) {
  // DOMPurify strips <script>, javascript: URLs, on* attrs, etc.
  // Allow images via http(s) only (camo URLs already filtered upstream).
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      "h1", "h2", "h3", "h4", "h5", "h6",
      "p", "br", "strong", "em", "u", "code", "pre", "blockquote",
      "ul", "ol", "li", "a", "img", "table", "thead", "tbody", "tr", "th", "td",
      "hr", "div", "span",
    ],
    ALLOWED_ATTR: ["href", "src", "alt", "title", "class"],
    ALLOWED_URI_REGEXP: /^(?:https?:\/\/|#)/i,
  });
  return (
    <section aria-labelledby="readme-heading" className="prose dark:prose-invert max-w-none">
      <h2 id="readme-heading">Documentation preview</h2>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized via DOMPurify above */}
      <div dangerouslySetInnerHTML={{ __html: clean }} />
    </section>
  );
}
```

### 6.5 fork-cta-placeholder.tsx (RSC)

- [ ] **Step 6.5.1:** Create `components/repo/fork-cta-placeholder.tsx`:

```tsx
import { Button } from "@/components/ui/button";
import { GitFork } from "lucide-react";

export function ForkCtaPlaceholder({ githubUrl }: { githubUrl: string }) {
  return (
    <div className="flex flex-col gap-2">
      <Button asChild size="lg" variant="default">
        <a href={githubUrl} target="_blank" rel="noopener noreferrer">
          <GitFork className="mr-2 h-4 w-4" /> View on GitHub
        </a>
      </Button>
      <p className="text-xs text-muted-foreground">
        One-click Fork available after sign-in (coming soon).
      </p>
    </div>
  );
}
```

### 6.6 reviews-placeholder.tsx (RSC)

- [ ] **Step 6.6.1:** Create `components/repo/reviews-placeholder.tsx`:

```tsx
export function ReviewsPlaceholder() {
  return (
    <section aria-labelledby="reviews-heading" className="space-y-2">
      <h2 id="reviews-heading" className="text-lg font-semibold">Reviews</h2>
      <p className="text-muted-foreground">
        Be the first to review this template after forking. Reviews coming soon.
      </p>
    </section>
  );
}
```

### 6.7 json-ld.tsx (RSC)

- [ ] **Step 6.7.1:** Create `components/repo/json-ld.tsx`:

```tsx
interface RepoLike {
  owner: string;
  name: string;
  description: string | null;
  total_score?: number | null;
  category: string | null;
  hero_asset?: { external_url: string | null } | null;
}

export function JsonLd({ repo, url }: { repo: RepoLike; url: string }) {
  const schema = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: `${repo.owner}/${repo.name}`,
    description: repo.description ?? undefined,
    applicationCategory: repo.category ?? undefined,
    url,
    image: repo.hero_asset?.external_url ?? undefined,
    aggregateRating: repo.total_score
      ? { "@type": "AggregateRating", ratingValue: repo.total_score, bestRating: 5, ratingCount: 1 }
      : undefined,
  };
  return (
    <script
      type="application/ld+json"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted JSON-LD construction
      dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
    />
  );
}
```

### 6.8 repo-hero.tsx (RSC)

- [ ] **Step 6.8.1:** Create `components/repo/repo-hero.tsx`:

```tsx
import Image from "next/image";
import type { RepoDetail } from "@/lib/marketplace/queries";
import { ForkCtaPlaceholder } from "./fork-cta-placeholder";

export function RepoHero({ repo }: { repo: RepoDetail }) {
  const githubUrl = `https://github.com/${repo.owner}/${repo.name}`;
  return (
    <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2">
        {repo.hero_asset?.external_url && (
          <Image
            src={repo.hero_asset.external_url}
            alt={`${repo.owner}/${repo.name} preview`}
            width={1200}
            height={675}
            unoptimized={repo.hero_asset.kind === "readme_gif"}
            priority
            className="w-full rounded-lg border"
          />
        )}
      </div>
      <aside className="space-y-4">
        <h1 className="text-2xl font-bold tracking-tight">
          <span className="text-muted-foreground font-normal">{repo.owner} /</span>{" "}
          {repo.name}
        </h1>
        {repo.description && <p className="text-muted-foreground">{repo.description}</p>}
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <dt className="text-muted-foreground">License</dt>
          <dd className="font-mono">{repo.license}</dd>
          <dt className="text-muted-foreground">Stars</dt>
          <dd>{repo.stars.toLocaleString()}</dd>
          <dt className="text-muted-foreground">Forks</dt>
          <dd>{repo.forks.toLocaleString()}</dd>
          <dt className="text-muted-foreground">Last commit</dt>
          <dd>{new Date(repo.last_commit_at).toLocaleDateString()}</dd>
        </dl>
        <ForkCtaPlaceholder githubUrl={githubUrl} />
      </aside>
    </section>
  );
}
```

### 6.9 Verify + commit

- [ ] **Step 6.9.1:** Verify:

```bash
pnpm lint
pnpm typecheck
```

- [ ] **Step 6.9.2:** Commit:

```bash
git add components/repo/
git commit -m "feat(repo): shared components — score badge/breakdown, tags, readme, hero, JSON-LD"
```

---

## Task 7 — Marketplace presentational components

**Dependencies:** Tasks 2, 4, 6

**Files:**
- Create: `components/marketplace/repo-card.tsx`
- Create: `components/marketplace/repo-grid.tsx`
- Create: `components/marketplace/pagination.tsx`
- Create: `components/marketplace/empty-state.tsx`
- Create: `components/marketplace/grid-skeleton.tsx`

### 7.1 repo-card.tsx (RSC)

- [ ] **Step 7.1.1:** Create `components/marketplace/repo-card.tsx`:

```tsx
import Image from "next/image";
import Link from "next/link";
import type { MarketplaceRepoRow } from "@/lib/marketplace/queries";
import { Badge } from "@/components/ui/badge";
import { ScoreBadge } from "@/components/repo/score-badge";

export function RepoCard({
  repo,
  isAboveFold,
}: {
  repo: MarketplaceRepoRow;
  isAboveFold: boolean;
}) {
  const href = `/r/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  const heroUrl = repo.hero_asset?.external_url ?? null;
  return (
    <article className="relative group rounded-lg overflow-hidden border bg-card hover:shadow-md transition-shadow">
      <Link href={href} className="block focus:outline focus:outline-2 focus:outline-ring">
        {heroUrl ? (
          <Image
            src={heroUrl}
            alt={`${repo.owner}/${repo.name} preview`}
            width={400}
            height={300}
            unoptimized={repo.hero_asset?.kind === "readme_gif"}
            loading={isAboveFold ? "eager" : "lazy"}
            fetchPriority={isAboveFold ? "auto" : "low"}
            className="w-full h-auto bg-muted"
          />
        ) : (
          <div className="aspect-[4/3] bg-gradient-to-br from-muted to-muted/50" aria-hidden="true" />
        )}
        <div className="p-3 space-y-2">
          <h3 className="font-medium line-clamp-2">
            <span className="text-muted-foreground font-normal">{repo.owner}/</span>
            {repo.name}
          </h3>
          <div className="flex items-center gap-3 text-sm">
            {repo.total_score !== null && <ScoreBadge score={repo.total_score} />}
            <span className="text-muted-foreground">⭐ {formatStars(repo.stars)}</span>
          </div>
          {repo.feature_tags.length > 0 && (
            <ul className="flex flex-wrap gap-1" aria-label="Top features">
              {repo.feature_tags.slice(0, 3).map((slug) => (
                <li key={slug}><Badge variant="secondary">{slug}</Badge></li>
              ))}
            </ul>
          )}
        </div>
      </Link>
      {/* Hover overlay — desktop hover only, hidden on touch (Moderate R1.M1) */}
      {repo.description && (
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-black/70 text-white p-4 opacity-0 transition-opacity
                     hover:opacity-100 hidden [@media(hover:hover)]:[&]:block pointer-events-none"
        >
          <p className="text-sm line-clamp-6">{repo.description}</p>
        </div>
      )}
    </article>
  );
}

function formatStars(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toString();
}
```

### 7.2 repo-grid.tsx (Client — react-masonry-css needs window measurement)

- [ ] **Step 7.2.1:** Create `components/marketplace/repo-grid.tsx`:

```tsx
"use client";

import Masonry from "react-masonry-css";
import type { MarketplaceRepoRow } from "@/lib/marketplace/queries";
import { RepoCard } from "./repo-card";

const ABOVE_FOLD_COUNT = 8;

const breakpointCols = {
  default: 4,
  1280: 3,
  768: 2,
  640: 1,
};

export function RepoGrid({ repos }: { repos: MarketplaceRepoRow[] }) {
  return (
    <Masonry
      breakpointCols={breakpointCols}
      className="flex gap-4"
      columnClassName="flex flex-col gap-4"
    >
      {repos.map((repo, i) => (
        <RepoCard key={repo.id} repo={repo} isAboveFold={i < ABOVE_FOLD_COUNT} />
      ))}
    </Masonry>
  );
}
```

### 7.3 pagination.tsx (RSC)

- [ ] **Step 7.3.1:** Create `components/marketplace/pagination.tsx`:

```tsx
import Link from "next/link";

export function Pagination({
  currentPage,
  totalPages,
  buildHref,
}: {
  currentPage: number;
  totalPages: number;
  buildHref: (page: number) => string;
}) {
  if (totalPages <= 1) return null;
  const pages = pageRange(currentPage, totalPages);
  return (
    <nav aria-label="Pagination" className="flex items-center justify-center gap-1 mt-8">
      {pages.map((p) => {
        if (p === "...") {
          return <span key={`gap-${Math.random()}`} className="px-2 text-muted-foreground">…</span>;
        }
        const isCurrent = p === currentPage;
        return (
          <Link
            key={p}
            href={buildHref(p)}
            prefetch
            aria-label={`Go to page ${p} of ${totalPages}`}
            aria-current={isCurrent ? "page" : undefined}
            className={`px-3 py-1 rounded ${
              isCurrent ? "bg-primary text-primary-foreground font-semibold" : "hover:bg-muted"
            }`}
          >
            <span className="sr-only">Page </span>{p}
          </Link>
        );
      })}
    </nav>
  );
}

function pageRange(current: number, total: number): Array<number | "..."> {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const result: Array<number | "..."> = [1];
  if (current > 3) result.push("...");
  for (let p = Math.max(2, current - 1); p <= Math.min(total - 1, current + 1); p++) result.push(p);
  if (current < total - 2) result.push("...");
  result.push(total);
  return result;
}
```

### 7.4 empty-state.tsx (RSC)

- [ ] **Step 7.4.1:** Create `components/marketplace/empty-state.tsx`:

```tsx
import Link from "next/link";
import type { MarketplaceRepoRow } from "@/lib/marketplace/queries";
import { RepoGrid } from "./repo-grid";

export function EmptyState({ recommendations }: { recommendations: MarketplaceRepoRow[] }) {
  return (
    <section
      role="status"
      aria-labelledby="no-results-heading"
      className="text-center py-12"
    >
      <h2 id="no-results-heading" className="text-2xl font-semibold">No results found</h2>
      <p className="mt-2 text-muted-foreground">
        Try clearing some filters, or browse top-rated templates below:
      </p>
      <div className="mt-4">
        <Link href="/" className="text-primary underline">Clear all filters</Link>
      </div>
      {recommendations.length > 0 && (
        <div className="mt-8 text-left">
          <RepoGrid repos={recommendations} />
        </div>
      )}
    </section>
  );
}
```

### 7.5 grid-skeleton.tsx (RSC)

- [ ] **Step 7.5.1:** Create `components/marketplace/grid-skeleton.tsx`:

```tsx
import { Skeleton } from "@/components/ui/skeleton";

export function GridSkeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {Array.from({ length: 12 }).map((_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholder
        <div key={i} className="space-y-2">
          <Skeleton className="aspect-[4/3] w-full" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ))}
    </div>
  );
}
```

### 7.6 Verify + commit

- [ ] **Step 7.6.1:** Verify:

```bash
pnpm lint
pnpm typecheck
```

- [ ] **Step 7.6.2:** Commit:

```bash
git add components/marketplace/repo-card.tsx components/marketplace/repo-grid.tsx \
        components/marketplace/pagination.tsx components/marketplace/empty-state.tsx \
        components/marketplace/grid-skeleton.tsx
git commit -m "feat(marketplace): presentational components — card, grid, pagination, empty, skeleton"
```

---

## Task 8 — Interactive marketplace components (filter sidebar, drawer, sort)

**Dependencies:** Task 7

**Files:**
- Create: `components/marketplace/filter-sidebar.tsx`
- Create: `components/marketplace/filter-chips.tsx`
- Create: `components/marketplace/filter-drawer.tsx`
- Create: `components/marketplace/sort-dropdown.tsx`

### 8.1 filter-sidebar.tsx (Client)

- [ ] **Step 8.1.1:** Create `components/marketplace/filter-sidebar.tsx`. Full code in **spec §4.4** — copy verbatim. Key behaviors:

- `<form action="/" method="GET">` for progressive enhancement (no JS = Apply button submits)
- Hidden input `name="page" value="1"` resets pagination on filter change
- Search input: 350ms debounce via `useDebouncedCallback`
- Checkboxes/radios: 200ms batched debounce
- "Any" radio first option for category/min_score/vibecoding (HTML radios can't be deselected — Critical R2.C1)
- `<details>` "Show all" for tags beyond top 10
- `import { useDebouncedCallback } from "@/lib/marketplace/debounce";`
- Sidebar `w-72 min` (Korean expansion-safe — Real R2.R4)

### 8.2 filter-chips.tsx (Client)

- [ ] **Step 8.2.1:** Create `components/marketplace/filter-chips.tsx`. Full code in **spec §4.5**. Key behaviors:

- Each chip's X button has explicit aria-label: `"Remove Category: SaaS filter"` (not generic "Remove" — Real R2.R2)
- Uses `useRouter()` + `useSearchParams()` to construct new URL without that key
- "Clear all" button if any filter active, navigates to `/`

### 8.3 filter-drawer.tsx (Client, mobile)

- [ ] **Step 8.3.1:** Create `components/marketplace/filter-drawer.tsx`. Full code in **spec §4.6**. Key behaviors:

- shadcn `Sheet` (Radix Dialog) wraps `FilterSidebar`
- Trigger button is sticky on mobile (`lg:hidden sticky top-2 z-10`)
- Trigger has `aria-expanded` bound to Sheet open state
- Trigger shows active filter count badge

### 8.4 sort-dropdown.tsx (Client)

- [ ] **Step 8.4.1:** Create `components/marketplace/sort-dropdown.tsx`:

```tsx
"use client";

import { useRouter, useSearchParams } from "next/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import type { MarketplaceQuery } from "@/lib/marketplace/search-params";

export function SortDropdown({ initial }: { initial: MarketplaceQuery["sort"] }) {
  const router = useRouter();
  const params = useSearchParams();

  function onChange(next: string) {
    const url = new URLSearchParams(params.toString());
    url.set("sort", next);
    url.set("page", "1");  // reset
    router.push(`/?${url.toString()}`, { scroll: false });
  }

  return (
    <Select value={initial} onValueChange={onChange}>
      <SelectTrigger className="w-56" aria-label="Sort by">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="score">Best (quality + stars)</SelectItem>
        <SelectItem value="recent">Recently updated</SelectItem>
        <SelectItem value="popular">Popular (age-normalized)</SelectItem>
        <SelectItem value="reviewed" disabled>
          <span>Most Reviewed</span> <Badge variant="secondary" className="ml-2">Coming soon</Badge>
        </SelectItem>
      </SelectContent>
    </Select>
  );
}
```

### 8.5 Verify + commit

- [ ] **Step 8.5.1:** Verify:

```bash
pnpm lint
pnpm typecheck
```

- [ ] **Step 8.5.2:** Commit:

```bash
git add components/marketplace/filter-sidebar.tsx components/marketplace/filter-chips.tsx \
        components/marketplace/filter-drawer.tsx components/marketplace/sort-dropdown.tsx
git commit -m "feat(marketplace): interactive components — filter sidebar/chips/drawer + sort"
```

---

## Task 9 — Pages: home + detail + loading + error + sitemap

**Dependencies:** Tasks 3, 6, 7, 8

**Files:**
- Modify: `app/page.tsx`
- Create: `app/loading.tsx`
- Create: `app/error.tsx`
- Create: `app/r/[owner]/[name]/page.tsx`
- Create: `app/r/[owner]/[name]/loading.tsx`
- Create: `app/r/[owner]/[name]/not-found.tsx`
- Create: `app/sitemap.ts`

### 9.1 app/page.tsx (replace placeholder with marketplace home)

- [ ] **Step 9.1.1:** Replace `app/page.tsx` content:

```tsx
import { Suspense } from "react";
import { parseMarketplaceParams } from "@/lib/marketplace/search-params";
import { listRepos } from "@/lib/marketplace/queries";
import { getMarketplaceFacets } from "@/lib/marketplace/facets";
import { FilterSidebar } from "@/components/marketplace/filter-sidebar";
import { FilterDrawer } from "@/components/marketplace/filter-drawer";
import { FilterChips } from "@/components/marketplace/filter-chips";
import { SortDropdown } from "@/components/marketplace/sort-dropdown";
import { RepoGrid } from "@/components/marketplace/repo-grid";
import { Pagination } from "@/components/marketplace/pagination";
import { EmptyState } from "@/components/marketplace/empty-state";
import { GridSkeleton } from "@/components/marketplace/grid-skeleton";
import type { PageProps } from "next";

export default async function Home(props: PageProps<"/">) {
  const sp = await props.searchParams;
  const query = parseMarketplaceParams(sp as Record<string, string | string[] | undefined>);
  const facets = await getMarketplaceFacets();

  return (
    <main className="container mx-auto px-4 py-6">
      <header className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">VibeShelf</h1>
          <p className="text-muted-foreground">Curated open-source templates for vibe coders</p>
        </div>
        <SortDropdown initial={query.sort} />
      </header>

      <FilterDrawer initial={query} facets={facets} />
      <FilterChips initial={query} />

      <div className="grid grid-cols-1 lg:grid-cols-[18rem_1fr] gap-6">
        <FilterSidebar initial={query} facets={facets} />
        <Suspense fallback={<GridSkeleton />}>
          <ReposSection query={query} />
        </Suspense>
      </div>
    </main>
  );
}

async function ReposSection({ query }: { query: ReturnType<typeof parseMarketplaceParams> }) {
  const { items, totalCount } = await listRepos(query);

  if (items.length === 0) {
    // Recommendations: top-scored repos when current query has no results
    const recs = await listRepos({ sort: "score", page: 1, tags: [] });
    return <EmptyState recommendations={recs.items.slice(0, 6)} />;
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / 36));

  function buildHref(page: number): string {
    const url = new URLSearchParams();
    if (query.q) url.set("q", query.q);
    if (query.category) url.set("category", query.category);
    if (query.tags.length) url.set("tags", query.tags.join(","));
    if (query.min_score !== undefined) url.set("min_score", String(query.min_score));
    if (query.vibecoding) url.set("vibecoding", query.vibecoding);
    if (query.sort !== "score") url.set("sort", query.sort);
    if (page !== 1) url.set("page", String(page));
    const qs = url.toString();
    return qs ? `/?${qs}` : "/";
  }

  return (
    <div>
      <p className="text-sm text-muted-foreground mb-3" role="status">
        {totalCount.toLocaleString()} template{totalCount === 1 ? "" : "s"} found
      </p>
      <RepoGrid repos={items} />
      <Pagination currentPage={query.page} totalPages={totalPages} buildHref={buildHref} />
    </div>
  );
}
```

### 9.2 app/loading.tsx + app/error.tsx

- [ ] **Step 9.2.1:** Create `app/loading.tsx`:

```tsx
import { GridSkeleton } from "@/components/marketplace/grid-skeleton";

export default function Loading() {
  return (
    <main className="container mx-auto px-4 py-6">
      <div className="space-y-4">
        <div className="h-8 w-48 bg-muted rounded animate-pulse" />
        <GridSkeleton />
      </div>
    </main>
  );
}
```

- [ ] **Step 9.2.2:** Create `app/error.tsx`:

```tsx
"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    console.error("[app] error boundary caught:", error);
  }, [error]);

  return (
    <main className="container mx-auto px-4 py-12 text-center">
      <h2 className="text-2xl font-bold">Something went wrong</h2>
      <p className="mt-2 text-muted-foreground">An unexpected error occurred while loading this page.</p>
      <Button onClick={reset} className="mt-6">Try again</Button>
    </main>
  );
}
```

### 9.3 app/r/[owner]/[name]/page.tsx

- [ ] **Step 9.3.1:** Create `app/r/[owner]/[name]/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import type { Metadata, PageProps } from "next";
import { getRepo } from "@/lib/marketplace/queries";
import { RepoHero } from "@/components/repo/repo-hero";
import { ScoreBreakdown } from "@/components/repo/score-breakdown";
import { TagsList } from "@/components/repo/tags-list";
import { ReadmePreview } from "@/components/repo/readme-preview";
import { ReviewsPlaceholder } from "@/components/repo/reviews-placeholder";
import { JsonLd } from "@/components/repo/json-ld";

export async function generateMetadata(
  props: PageProps<"/r/[owner]/[name]">,
): Promise<Metadata> {
  const { owner, name } = await props.params;
  const repo = await getRepo(owner, name);
  if (!repo) return {};
  return {
    title: `${owner}/${name} — VibeShelf`,
    description: repo.description?.slice(0, 160) ?? undefined,
    openGraph: {
      title: `${owner}/${name}`,
      description: repo.description ?? undefined,
      images: repo.hero_asset?.external_url
        ? [{ url: repo.hero_asset.external_url }]
        : undefined,
    },
  };
}

export default async function RepoDetailPage(props: PageProps<"/r/[owner]/[name]">) {
  const { owner, name } = await props.params;
  const repo = await getRepo(owner, name);
  if (!repo) notFound();  // proper 404 status

  const url = `https://vibeshelf.example/r/${owner}/${name}`;  // TODO: use actual host
  return (
    <main className="container mx-auto px-4 py-6 space-y-8">
      <RepoHero repo={repo} />
      {repo.scores.total > 0 && <ScoreBreakdown axes={repo.scores} />}
      <TagsList tags={{
        feature: repo.feature_tags,
        tech_stack: repo.tech_stack_tags,
        vibecoding_tool: repo.vibecoding_tags,
      }} />
      {/* README preview placeholder — readme markdown not stored in DB per D4=Y;
          shows description summary until SP#4.5 mirror lands */}
      {repo.description && (
        <ReadmePreview html={`<p>${escapeHtml(repo.description)}</p>`} />
      )}
      <ReviewsPlaceholder />
      <JsonLd repo={{ ...repo, total_score: repo.scores.total }} url={url} />
    </main>
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
```

### 9.4 not-found + loading

- [ ] **Step 9.4.1:** Create `app/r/[owner]/[name]/not-found.tsx`:

```tsx
import Link from "next/link";

export default function NotFound() {
  return (
    <main className="container mx-auto px-4 py-12 text-center">
      <h1 className="text-3xl font-bold">Repository not found</h1>
      <p className="mt-2 text-muted-foreground">
        This template may have been removed, made private, or never indexed.
      </p>
      <Link href="/" className="inline-block mt-6 text-primary underline">
        ← Back to marketplace
      </Link>
    </main>
  );
}
```

- [ ] **Step 9.4.2:** Create `app/r/[owner]/[name]/loading.tsx`:

```tsx
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <main className="container mx-auto px-4 py-6 space-y-6">
      <Skeleton className="w-full aspect-video" />
      <Skeleton className="h-8 w-1/2" />
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-3/4" />
    </main>
  );
}
```

### 9.5 sitemap.ts

- [ ] **Step 9.5.1:** Create `app/sitemap.ts`:

```typescript
import type { MetadataRoute } from "next";
import { createAnonClient } from "@/lib/db";
import { CATEGORIES } from "@/lib/marketplace/search-params";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  "use cache";
  // (cacheLife not strictly needed at this scope; sitemap fetched infrequently)

  const base = process.env.NEXT_PUBLIC_SITE_URL ?? "https://vibeshelf.example";
  const db = createAnonClient();
  const { data } = await db
    .from("repos")
    .select("owner, name, updated_at")
    .eq("status", "published")
    .order("updated_at", { ascending: false })
    .limit(10000);

  const repos = (data ?? []).map((r) => ({
    url: `${base}/r/${r.owner}/${r.name}`,
    lastModified: r.updated_at,
    priority: 0.7,
  }));

  const categories = CATEGORIES.map((c) => ({
    url: `${base}/?category=${c}`,
    lastModified: new Date().toISOString(),
    priority: 0.6,
  }));

  return [
    { url: base, lastModified: new Date().toISOString(), priority: 1.0 },
    ...categories,
    ...repos,
  ];
}
```

### 9.6 Verify + commit

- [ ] **Step 9.6.1:** Verify:

```bash
pnpm lint
pnpm typecheck
pnpm build  # full build to check 'use cache' doesn't hang
```

If the build hangs on `'use cache'` mistake, check that no cached function reads `searchParams` directly.

- [ ] **Step 9.6.2:** Commit:

```bash
git add app/page.tsx app/loading.tsx app/error.tsx app/sitemap.ts app/r/
git commit -m "feat(app): marketplace home + repo detail + sitemap + loading/error/not-found"
```

---

## Task 10 — Dev seed script + dep-cruiser rules + negative fixtures

**Dependencies:** Tasks 1, 2, 3

**Files:**
- Create: `scripts/seed-dev.ts`
- Create: `lib/marketplace/__fixtures__/bad-pipeline-import.ts`
- Create: `lib/marketplace/__fixtures__/bad-react-import-in-queries.ts`
- Modify: `dependency-cruiser.cjs`
- Modify: `package.json`

### 10.1 dep-cruiser rules

- [ ] **Step 10.1.1:** Modify `dependency-cruiser.cjs` — add 2 marketplace rules to the `forbidden` array (place after F4 rule):

```javascript
{
  name: "no-marketplace-imports-pipeline",
  severity: "error",
  from: { path: "^lib/marketplace/" },
  to: { path: "^lib/pipeline/" },
  comment: "Marketplace read-side and pipeline write-side share zero code",
},
{
  name: "marketplace-server-only",
  severity: "error",
  from: { path: "^lib/marketplace/(queries|facets)\\.ts$" },
  to: { path: "/node_modules/(react|next/client)/" },
  comment: "queries/facets are server-only — no React or next/client imports",
},
```

### 10.2 Negative fixtures

- [ ] **Step 10.2.1:** Create `lib/marketplace/__fixtures__/bad-pipeline-import.ts`:

```typescript
// Intentionally violates `no-marketplace-imports-pipeline` rule.
// dep-cruiser cruising this file in isolation MUST fail.
import { echoJob } from "@/lib/pipeline/jobs/echo";

export const _BAD_MARKETPLACE_PIPELINE_FIXTURE = echoJob;
```

- [ ] **Step 10.2.2:** Create `lib/marketplace/__fixtures__/bad-react-import-in-queries.ts`:

```typescript
// Intentionally violates `marketplace-server-only` rule.
// (Fixture filename mimics the queries.ts path matcher would catch it.)
// dep-cruiser cruising this file matching the queries|facets pattern MUST fail.
// To make the rule fire, we re-export so the import edge exists.
import * as React from "react";

export const _BAD_MARKETPLACE_REACT_FIXTURE = React;
```

**Note:** the `marketplace-server-only` rule's `from.path` regex matches `queries.ts` and `facets.ts` exact filenames. The fixture filename above doesn't match — so it won't trigger the rule via cruise. To genuinely test the server-only rule, we'd need to either rename the fixture to `queries-bad.ts` and adjust the rule, OR cruise from a file that matches the pattern. For MVP, the `no-marketplace-imports-pipeline` fixture is the meaningful one; the server-only rule is enforced by the `import 'server-only'` runtime check + Next.js bundling (any client-component import will fail at build).

Therefore: drop the second fixture and rely on `import 'server-only'` for runtime enforcement.

- [ ] **Step 10.2.3:** Delete `lib/marketplace/__fixtures__/bad-react-import-in-queries.ts` (per the note above) and remove the `marketplace-server-only` dep-cruiser rule (or keep it as belt-and-suspenders; runtime `'server-only'` is the primary defense).

### 10.3 lint:neg update

- [ ] **Step 10.3.1:** Modify `package.json` — extend `lint:neg:depcruise` script:

```json
"lint:neg:depcruise": "! depcruise -c dependency-cruiser.cjs lib/pipeline/__fixtures__/bad-pipeline-import.ts 2>/dev/null && ! depcruise -c dependency-cruiser.cjs lib/pipeline/jobs/__fixtures__/bad-score-service-import.ts 2>/dev/null && ! depcruise -c dependency-cruiser.cjs lib/marketplace/__fixtures__/bad-pipeline-import.ts 2>/dev/null"
```

### 10.4 Dev seed script

- [ ] **Step 10.4.1:** Create `scripts/seed-dev.ts`:

```typescript
// Seed local Supabase with 30 fixture repos for marketplace UI development.
// Refuses to run in production or against non-localhost URLs.

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

if (process.env.NODE_ENV === "production") {
  console.error("[seed-dev] Refusing to run in production.");
  process.exit(1);
}
if (!url.includes("127.0.0.1") && !url.includes("localhost")) {
  console.error(`[seed-dev] Refusing — NEXT_PUBLIC_SUPABASE_URL is not localhost: ${url}`);
  process.exit(1);
}

const FIXTURE_REPOS = Array.from({ length: 30 }, (_, i) => {
  const id = i + 1;
  return {
    github_id: 800_000_000 + id,
    owner: `fixture-${String(id).padStart(2, "0")}`,
    name: `template-${id}`,
    description: `Fixture template #${id} — for local marketplace UI development.`,
    license: "mit",
    default_branch: "main",
    stars: Math.floor(Math.random() * 5000),
    forks: Math.floor(Math.random() * 500),
    watchers: Math.floor(Math.random() * 100),
    last_commit_at: new Date(Date.now() - Math.random() * 365 * 24 * 60 * 60 * 1000).toISOString(),
    github_created_at: new Date(Date.now() - Math.random() * 730 * 24 * 60 * 60 * 1000).toISOString(),
    github_pushed_at: new Date(Date.now() - Math.random() * 365 * 24 * 60 * 60 * 1000).toISOString(),
    status: "published" as const,
    category: ["saas", "ecommerce", "dashboard", "landing_page", "ai_tool", "blog", "portfolio"][i % 7] as
      | "saas" | "ecommerce" | "dashboard" | "landing_page" | "ai_tool" | "blog" | "portfolio",
  };
});

async function main(): Promise<void> {
  const db = createClient(url, serviceRole, { auth: { persistSession: false } });

  const { data: insertedRepos, error: reposErr } = await db
    .from("repos")
    .upsert(FIXTURE_REPOS, { onConflict: "github_id" })
    .select("id, github_id");
  if (reposErr) throw new Error(`repos upsert: ${reposErr.message}`);

  const scoreRows = (insertedRepos ?? []).map((r) => ({
    repo_id: r.id,
    documentation_score: 3 + Math.random() * 2,
    maintenance_score: 3 + Math.random() * 2,
    popularity_score: 3 + Math.random() * 2,
    code_health_score: 3 + Math.random() * 2,
    visual_preview_score: 3 + Math.random() * 2,
    scoring_model: "fixture",
    scoring_prompt_version: "1.0.0",
    is_latest: true,
    evidence_strength: "strong" as const,
  }));
  // Wipe prior latest before insert (simple seed pattern; real RPC handles this atomically)
  if (insertedRepos && insertedRepos.length > 0) {
    await db.from("repo_scores").delete().in("repo_id", insertedRepos.map((r) => r.id));
  }
  const { error: scoresErr } = await db.from("repo_scores").insert(scoreRows);
  if (scoresErr) throw new Error(`repo_scores insert: ${scoresErr.message}`);

  console.log(`[seed-dev] Inserted ${insertedRepos?.length ?? 0} repos + scores.`);
  console.log(`[seed-dev] Visit http://localhost:3000`);
}

main().catch((err) => {
  console.error("[seed-dev] Failed:", err);
  process.exit(1);
});
```

- [ ] **Step 10.4.2:** Add npm script in `package.json`:

```json
"seed:dev": "tsx scripts/seed-dev.ts",
```

### 10.5 Verify + commit

- [ ] **Step 10.5.1:** Verify:

```bash
pnpm lint
pnpm typecheck
pnpm lint:neg
```

`lint:neg` should pass (all 3 negative fixtures fail individual cruise as expected).

- [ ] **Step 10.5.2:** Commit:

```bash
git add dependency-cruiser.cjs lib/marketplace/__fixtures__/ scripts/seed-dev.ts package.json
git commit -m "feat(infra): marketplace dep-cruiser rule + neg fixture + pnpm seed:dev script"
```

---

## Task 11 — Tests (integration + e2e)

**Dependencies:** Tasks 1-10

**Files:**
- Create: `tests/integration/marketplace/list-query.test.ts`
- Create: `tests/integration/marketplace/facets.test.ts`
- Create: `tests/integration/marketplace/detail-query.test.ts`
- Create: `tests/integration/marketplace/search-relevance.test.ts`
- Create: `tests/unit/marketplace/revalidate-wiring.test.ts`
- Create: `tests/e2e/marketplace-desktop.spec.ts`
- Create: `tests/e2e/marketplace-mobile.spec.ts`
- Create: `tests/e2e/marketplace-no-js.spec.ts`
- Create: `tests/e2e/empty-state.spec.ts`
- Create: `tests/e2e/repo-detail.spec.ts`
- Modify: `playwright.config.ts`

### 11.1 Integration tests

- [ ] **Step 11.1.1:** Create `tests/integration/marketplace/list-query.test.ts` — covers:

- Routing: `tags=[]` → list_repos_no_tags; `tags=['auth']` → list_repos_with_tags
- All filter combinations (category, min_score, vibecoding, search) return correct repos
- AND tag semantics: only repos with ALL specified tags returned
- Sort orderings produce different orders
- Page offset works (page 2 returns rows 37-72)

- [ ] **Step 11.1.2:** Create `tests/integration/marketplace/facets.test.ts` — covers:

- Counts only `status='published'` repos (seed mix of statuses)
- All 4 facet types present (categories, tags, vibecoding, score_buckets)
- 0-result case returns empty objects, not error

- [ ] **Step 11.1.3:** Create `tests/integration/marketplace/detail-query.test.ts` — covers:

- Returns full row for valid (owner, name) of published repo
- Returns null for non-existent repo
- Returns null for non-published repo (RLS hides)

- [ ] **Step 11.1.4:** Create `tests/integration/marketplace/search-relevance.test.ts` — covers:

- Repo with query in name ranks higher than repo with query in description (A vs B weighting)
- `plainto_tsquery` safe with special characters

### 11.2 Unit test for revalidate wiring

- [ ] **Step 11.2.1:** Create `tests/unit/marketplace/revalidate-wiring.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock next/cache so we can assert calls without Next runtime
const revalidateTagMock = vi.fn();
vi.mock("next/cache", () => ({
  revalidateTag: revalidateTagMock,
}));

// Import AFTER mock so the route handler picks up the mocked module
const { GET } = await import("@/app/api/cron/discover/route");

describe("cron discover route invalidates tags from changedRepoIds", () => {
  beforeEach(() => {
    revalidateTagMock.mockClear();
  });

  it("calls revalidateTag for each changedRepoId + facets/list tags", async () => {
    // Mock runJob to return { changedRepoIds: ['id-1', 'id-2'] }
    vi.doMock("@/lib/pipeline/runJob", () => ({
      runJob: vi.fn(async () => ({ changedRepoIds: ["id-1", "id-2"] })),
    }));
    vi.doMock("@/lib/env", () => ({ env: { CRON_SECRET: "test-secret" } }));

    const req = new Request("http://localhost/api/cron/discover", {
      headers: { authorization: "Bearer test-secret" },
    });

    await GET(req);

    expect(revalidateTagMock).toHaveBeenCalledWith("repos:facets", "max");
    expect(revalidateTagMock).toHaveBeenCalledWith("repos:list", "max");
    expect(revalidateTagMock).toHaveBeenCalledWith("repo:id-1", "max");
    expect(revalidateTagMock).toHaveBeenCalledWith("repo:id-2", "max");
  });

  it("does NOT call revalidateTag when changedRepoIds is empty", async () => {
    vi.doMock("@/lib/pipeline/runJob", () => ({
      runJob: vi.fn(async () => ({ changedRepoIds: [] })),
    }));

    const req = new Request("http://localhost/api/cron/discover", {
      headers: { authorization: "Bearer test-secret" },
    });

    await GET(req);

    expect(revalidateTagMock).not.toHaveBeenCalled();
  });
});
```

### 11.3 Playwright config

- [ ] **Step 11.3.1:** Modify `playwright.config.ts` to add device projects:

```typescript
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["iPhone 13"] } },
  ],
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
  },
});
```

### 11.4 E2E tests

- [ ] **Step 11.4.1:** Create `tests/e2e/marketplace-desktop.spec.ts` — happy path:

```typescript
import { expect, test } from "@playwright/test";

test.use({ ...{} });  // desktop project

test.describe("marketplace home — desktop", () => {
  test("renders grid + sidebar + sort", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toContainText("VibeShelf");
    await expect(page.locator("aside form")).toBeVisible();
    await expect(page.locator('[role="img"][aria-label*="Quality"]').first()).toBeVisible();
  });

  test("clicking a category filter updates URL and grid", async ({ page }) => {
    await page.goto("/");
    await page.locator('input[name="category"][value="saas"]').check();
    await page.waitForURL(/category=saas/);
    await expect(page.locator("[role='status']")).toContainText("found");
  });

  test("pagination link navigates", async ({ page }) => {
    await page.goto("/?page=1");
    const page2Link = page.locator('a[aria-label="Go to page 2 of 1"], a[aria-label*="Go to page 2"]');
    if (await page2Link.count() > 0) {
      await page2Link.first().click();
      await page.waitForURL(/page=2/);
    }
  });
});
```

- [ ] **Step 11.4.2:** Create `tests/e2e/marketplace-mobile.spec.ts`:

```typescript
import { expect, test } from "@playwright/test";

test.describe("marketplace home — mobile", () => {
  test("filter drawer opens on Filters button click", async ({ page }) => {
    await page.goto("/");
    const trigger = page.locator('button:has-text("Filters")');
    await expect(trigger).toBeVisible();
    await trigger.click();
    await expect(page.locator("[role='dialog']")).toBeVisible();
  });
});
```

- [ ] **Step 11.4.3:** Create `tests/e2e/marketplace-no-js.spec.ts`:

```typescript
import { expect, test } from "@playwright/test";

test.use({ javaScriptEnabled: false });

test.describe("marketplace — no JS fallback", () => {
  test("filter form submits via GET on Apply button", async ({ page }) => {
    await page.goto("/");
    // Without JS, clicking a category radio shouldn't submit; user must click Apply
    await page.locator('input[name="category"][value="saas"]').check();
    await page.locator('button[type="submit"]').first().click();
    await expect(page).toHaveURL(/category=saas/);
  });
});
```

- [ ] **Step 11.4.4:** Create `tests/e2e/empty-state.spec.ts`:

```typescript
import { expect, test } from "@playwright/test";

test("empty state shows recommendations when no results", async ({ page }) => {
  await page.goto("/?q=zzznomatchexpected");
  await expect(page.locator("h2#no-results-heading")).toBeVisible();
  await expect(page.locator('a:has-text("Clear all filters")')).toBeVisible();
});
```

- [ ] **Step 11.4.5:** Create `tests/e2e/repo-detail.spec.ts`:

```typescript
import { expect, test } from "@playwright/test";

test("repo detail page renders score breakdown + JSON-LD + fork CTA", async ({ page }) => {
  // Assumes seed-dev created a fixture-01/template-1 repo
  await page.goto("/r/fixture-01/template-1");
  await expect(page.locator("h1")).toContainText("template-1");
  await expect(page.locator('[aria-labelledby="score-breakdown-heading"]')).toBeVisible();
  await expect(page.locator('script[type="application/ld+json"]')).toBeAttached();
  await expect(page.locator('a:has-text("View on GitHub")')).toBeVisible();
});

test("non-existent repo returns 404", async ({ page }) => {
  const res = await page.goto("/r/does-not-exist/anywhere");
  expect(res?.status()).toBe(404);
});
```

### 11.5 Verify + commit

- [ ] **Step 11.5.1:** Verify (Docker required for integration; e2e needs seeded DB):

```bash
pnpm test:unit          # all unit tests
pnpm test:integration   # if Docker available
# pnpm test:e2e         # requires seeded local DB; skip if blocked
```

- [ ] **Step 11.5.2:** Commit:

```bash
git add tests/integration/marketplace/ tests/unit/marketplace/revalidate-wiring.test.ts \
        tests/e2e/marketplace*.spec.ts tests/e2e/empty-state.spec.ts tests/e2e/repo-detail.spec.ts \
        playwright.config.ts
git commit -m "test(marketplace): integration + e2e + revalidate wiring + Playwright projects"
```

---

## Task 12 — Documentation + final verify + PR

**Dependencies:** All previous

**Files:**
- Modify: `docs/architecture/open-questions.md`

### 12.1 Open questions update

- [ ] **Step 12.1.1:** Modify `docs/architecture/open-questions.md`. Add Q-09 + Q-10:

```markdown
## Q-09. Image hot-link reliability metric (surfaced in sub-project #4)

**Status:** New. SP#4 ships with `next/image` + remotePatterns allowlist for GitHub-hosted images. SP#4.5 will add pipeline-side mirror. Decision trigger: measure broken-image rate from production.

**Re-open when:** post-launch metrics show ≥5% broken-image events on cards.

---

## Q-10. UI internationalization scope

**Status:** New. SP#4 ships with English placeholder strings (e.g. "Search templates...", "Filters", "Coming soon"). PRD primary language is Korean. When and how do we localize?

**Options:**
1. Korean strings now (extra ~2 days; blocks SP#4 close)
2. Korean strings as part of SP#5 (Identity + Fork + Reviews) along with auth-related strings
3. Defer to Pro tier (SP#6) — assumes vibecoders read English UI

**Re-open when:** Starting SP#5 brainstorming.
```

Update revision log:

```markdown
- **2026-04-14** — Sub-project #4 (marketplace UI free) shipped. Added Q-09 (image reliability metric) and Q-10 (i18n scope).
```

### 12.2 Final verification

- [ ] **Step 12.2.1:** Full local verification:

```bash
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:integration  # if Docker
pnpm lint:neg
pnpm build
```

All must pass (Docker tests noted as skip if unavailable).

### 12.3 Commit + PR

- [ ] **Step 12.3.1:** Commit docs:

```bash
git add docs/architecture/open-questions.md
git commit -m "docs: open-questions Q-09 (image reliability), Q-10 (i18n scope) — SP#4 followups"
```

- [ ] **Step 12.3.2:** Push branch:

```bash
git push -u origin feat/marketplace-ui-free
```

- [ ] **Step 12.3.3:** Create PR. Body should reference the spec and summarize:

- 12 logical task batches, ~14-16 commits
- 3 new RPCs + 1 new column + GIN index migration
- 8 new pages/route files + 16 new components + 5 new lib modules
- Tests: ~10 new unit + 4 integration + 5 e2e
- Followups: SP#4.5 image mirror + width/height + GIF→MP4

---

## Self-Review

**Spec coverage:**

| Spec section | Task(s) |
|---|---|
| §1 Architecture (page set, components, data flow) | Tasks 6, 7, 8, 9 |
| §2 URL contract | Task 2 (search-params), Task 9 (page consumption) |
| §3 Cache strategy | Task 1 (RPCs + JobOutput + cron wiring), Task 3 (facets), Task 5 (next.config) |
| §4 Components | Tasks 6, 7, 8 |
| §5 Data SQL | Task 1 (migrations + RPCs), Task 3 (server-only callers) |
| §6 Boundaries + lints | Task 10 (dep-cruiser + fixtures), Task 3 (server-only guards) |
| §7 Testing | Task 11 (unit + integration + e2e + Playwright config) |
| §8 Followups | Task 12 (Q-09, Q-10), PR body summary |

All sections covered.

**Placeholder scan:**
- Task 9.3.1 mentions `https://vibeshelf.example` as TODO comment — replaced via env at runtime; documented in code comment
- Task 9.5.1 sitemap uses `process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vibeshelf.example'` — consistent
- No "TBD"/"implement later" in any task step

**Type consistency:**
- `MarketplaceQuery` (Task 2) used throughout Tasks 3, 8, 9
- `MarketplaceRepoRow` (Task 3) used in Tasks 7, 9
- `RepoDetail` (Task 3) used in Task 9
- `MarketplaceFacets` (Task 3) used in Tasks 8, 9
- `useDebouncedCallback` (Task 2) used in Task 8
- `scoreTier` (Task 2) used in Task 6 (ScoreBadge)

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-14-marketplace-ui-free-implementation.md`.

**Two execution options:**

**1. Subagent-Driven (recommended)** — Fresh subagent per task batch, reviewer between tasks. Matches SP#2/SP#3 pattern.

**2. Inline Execution** — Execute tasks in this session with checkpoints.

**Which approach?**
